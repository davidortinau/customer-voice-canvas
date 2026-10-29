import csv
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from openpyxl import Workbook

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions/customer-voice"))
import engine


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.headers = ["ID", "Email", "Name", "Recommend the platform",
                        "Comment", "Select all that apply", "Consent",
                        "Follow-up email", "Personalized data"]
        self.rows = [[str(i), "", "", str(i % 11), "Useful for work", "A;A;B",
                      "Yes" if i % 2 else "No", f"person{i}@example.test",
                      "source:editor;email:private@example.test;"] for i in range(12)]
        self.profile = engine.inspect(self.headers, self.rows, {"name": "sample.csv"})
        self.profile["id"] = "test-survey"
        self.profile["fields"][4].update(kind="text", choices=[], filter=False)
        self.profile["followup"] = {"contact": "c8", "consent": "c7", "value": "Yes"}
        self.source = {"sha256": "a" * 64, "rows": 12, "columns": 9}

    def test_nps_and_small_sample(self):
        report = engine.report(self.headers, self.rows, self.source, self.profile, {})
        metric = report["questions"][3]["metric"]
        self.assertEqual(metric["denominator"], 12)
        self.assertEqual(metric["numerator"], 2 - 8)
        self.assertEqual(metric["value"], -50)
        self.assertEqual(metric["status"], "directional")
        self.assertIsNone(engine.question(self.profile["fields"][3], self.rows[:4])["metric"]["value"])

    def test_multi_select_counts_respondents(self):
        q = engine.question(self.profile["fields"][5], self.rows)
        self.assertEqual(q["valid"], 12)
        self.assertEqual([x["count"] for x in q["distribution"]], [12, 12])

    def test_exclusion_and_positive_share(self):
        field = dict(self.profile["fields"][6], positive=["Yes"], exclude=["No"])
        q = engine.question(field, self.rows)
        self.assertEqual(q["metric"]["numerator"], 6)
        self.assertEqual(q["metric"]["denominator"], 6)
        self.assertEqual(q["excluded"], 6)
        self.assertEqual(q["metric"]["value"], 100)

    def test_empty_numeric(self):
        field = dict(self.profile["fields"][4], kind="number")
        q = engine.question(field, self.rows)
        self.assertEqual(q["valid"], 0)
        self.assertEqual(q["distribution"], [])

    def test_metadata_is_approved_source_only(self):
        self.profile["metadataSource"] = True
        report = engine.report(self.headers, self.rows, self.source, self.profile, {})
        encoded = json.dumps(report)
        self.assertNotIn("private@example", encoded)
        self.assertEqual(report["sourceGroups"][0]["source"], "editor")
        self.assertEqual(report["sourceGroups"][0]["n"], 12)

    def test_contact_consent_and_no_metadata_fallback(self):
        result = engine.review(self.rows, self.profile, {}, "key", "contacts")
        self.assertEqual(len(result["contacts"]), 6)
        self.assertNotIn("private@example", json.dumps(result))

    def test_private_answers_redacted_and_stable(self):
        self.rows[0][4] = "Email person0@example.test or +1 (555) 123-4567"
        result = engine.review(self.rows, self.profile, {}, "key", "answers", "c5")
        self.assertEqual(result["total"], 12)
        self.assertNotIn("person0@", result["answers"][0]["text"])
        self.assertNotIn("555", result["answers"][0]["text"])
        contacts = engine.review(self.rows, self.profile, {}, "key", "contacts")
        self.assertEqual(contacts["contacts"][0]["id"], result["answers"][1]["id"])

    def test_address_redaction_removes_full_tokens(self):
        examples = ["o'connor@example.com", "!team+test@example.com",
                    '"two words"@example.com', "unsupported..address@example.com"]
        for address in examples:
            with self.subTest(address=address):
                result = engine.redact(f"Reach {address} for details", [""] * 9, self.profile["fields"])
                self.assertEqual(result, "Reach [email removed] for details")

    def test_contact_formats_and_explicit_unsupported_count(self):
        addresses = ["o'connor@example.com", "!team+test@example.com",
                     '"two words"@example.com', "unsupported..address@example.com",
                     "not an address", "valid@example.com"]
        for row, address in zip(self.rows, addresses):
            row[6] = "Yes"
            row[7] = address
        self.rows[5][6] = "No"
        result = engine.review(self.rows[:6], self.profile, {}, "key", "contacts")
        self.assertEqual([c["email"] for c in result["contacts"]], addresses[:3])
        self.assertEqual(result["unsupportedAddressCount"], 2)

    def test_duplicate_ids_disable_private_joins(self):
        self.rows[1][0] = self.rows[0][0]
        with self.assertRaisesRegex(engine.SurveyError, "duplicated"):
            engine.review(self.rows, self.profile, {}, "key", "answers", "c5")

    def test_schema_and_choices_drift(self):
        with self.assertRaisesRegex(engine.SurveyError, "columns changed"):
            engine.validate(self.profile, self.headers + ["new"], self.rows)
        self.rows[0][6] = "Maybe"
        with self.assertRaisesRegex(engine.SurveyError, "Choices changed"):
            engine.validate(self.profile, self.headers, self.rows)

    def test_semicolon_text_is_not_automatically_multi_select(self):
        profile = engine.inspect(["Comment"], [["one;two"], ["three;four"]], {"name": "test.csv"})
        self.assertNotEqual(profile["fields"][0]["kind"], "multiple")

    def test_eligibility_and_filter(self):
        self.profile["eligibility"] = {"field": "c7", "value": "Yes"}
        self.profile["fields"][5]["filter"] = True
        report = engine.report(self.headers, self.rows, self.source, self.profile, {"c6": "A"})
        self.assertEqual(report["scope"]["eligible"], 6)
        self.assertEqual(report["scope"]["selected"], 6)
        with self.assertRaisesRegex(engine.SurveyError, "approved cohort filter"):
            engine.select_rows(self.rows, self.profile, {"c2": "x"})

    def test_duplicate_and_blank_headers_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "survey.csv"
            path.write_text('ID,Same,Same,\n1,A,B,C\n', encoding="utf-8")
            headers, rows, _ = engine.load(path)
            self.assertEqual(headers, ["ID", "Same", "Same", ""])
            profile = engine.inspect(headers, rows, {"name": path.name})
            profile["id"] = "test"
            engine.validate(profile, headers, rows)
            self.assertEqual([f["id"] for f in profile["fields"]], ["c1", "c2", "c3", "c4"])

    def test_malformed_workbook_dimensions(self):
        book = Workbook()
        sheet = book.active
        sheet.append(["ID", "Question"])
        for i in range(115):
            sheet.append([str(i), "Answer"])
        original = io.BytesIO()
        book.save(original)
        damaged = io.BytesIO()
        with zipfile.ZipFile(original) as source, zipfile.ZipFile(damaged, "w") as target:
            for name in source.namelist():
                data = source.read(name)
                if name == "xl/worksheets/sheet1.xml":
                    data = data.replace(b'ref="A1:B116"', b'ref="A1:A1"')
                target.writestr(name, data)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "survey.xlsx"
            path.write_bytes(damaged.getvalue())
            headers, rows, _ = engine.load(path)
            self.assertEqual(len(headers), 2)
            self.assertEqual(len(rows), 115)

    def test_changed_fingerprint_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "survey.csv"
            with path.open("w") as file:
                csv.writer(file).writerows([self.headers, *self.rows])
            with self.assertRaisesRegex(engine.SurveyError, "source changed"):
                engine.run({"source": str(path), "sha256": "0" * 64})

    def test_population_excludes_unsubmitted_and_can_include_ineligible(self):
        headers = ["ID", "Completion time", "Recent use", "Recommend the platform"]
        rows = [[str(i), "" if i == 0 else "2026-10-28", "No" if i < 3 else "Yes", "9"]
                for i in range(10)]
        profile = engine.inspect(headers, rows, {"name": "sample.csv"})
        profile.update(id="population", submission={"field": "c2", "kind": "date"},
                       eligibility={"field": "c3", "value": "Yes"})
        eligible = engine.report(headers, rows, {}, profile, {})
        submitted = engine.report(headers, rows, {}, profile, {}, "submitted")
        self.assertEqual(eligible["scope"]["exported"], 10)
        self.assertEqual(eligible["scope"]["submitted"], 9)
        self.assertEqual(eligible["scope"]["eligible"], 7)
        self.assertEqual(eligible["scope"]["selected"], 7)
        self.assertEqual(submitted["scope"]["selected"], 9)
        self.assertEqual(submitted["scope"]["eligible"], 7)

    def test_live_definition_and_survey_identity_cannot_silently_change(self):
        source = {"name": "live", "kind": "dataverse", "sha256": "a",
                  "columnIds": ["response-id", "q1"], "identity": "qualified-survey",
                  "definitionHash": "definition"}
        snapshot = {"headers": ["ID", "Question"], "rows": [["one", "Answer"]],
                    "source": source, "suggestions": []}
        profile = engine.run({"mode": "inspect", "snapshot": snapshot})["profile"]
        profile["id"] = "live-test"
        # This synthetic source has no completion column; use no submission gate.
        profile["submission"] = None
        engine.run({"mode": "report", "snapshot": snapshot, "profile": profile})
        for key in ["identity", "definitionHash"]:
            changed = {**snapshot, "source": {**source, key: "different"}}
            with self.assertRaisesRegex(engine.SurveyError, "identity changed"):
                engine.run({"mode": "report", "snapshot": changed, "profile": profile})


if __name__ == "__main__":
    unittest.main()
