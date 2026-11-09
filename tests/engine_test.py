import csv
import datetime
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from openpyxl import Workbook

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions/customer-voice"))
import engine


class EngineTests(unittest.TestCase):
    def conditional_survey(self):
        headers = ["ID"] + [f"Question {i}" for i in range(2, 160)] + [
            "Are you a resident of the United States or Puerto Rico (eligibility for the sweepstakes)?",
            "Want to enter our .NET prize bundle sweepstakes? Please leave your email address below so we can contact you if you are selected as a winner.",
            "May we contact you at the email address you provided about follow-up research related to your .NET experience?",
            "May we contact you about follow-up research related to your .NET experience? If you agree, please provide your email address below. By providing your email address, you consent to being contacted by Microsoft for this research.",
            "Personalized data",
        ]
        rows = [[str(i)] + [""] * 158 + tail for i, tail in enumerate([
            ["Yes", "prize-only@example.test", "No", "", ""],
            ["Yes", "prize-research@example.test", "Yes", "", ""],
            ["No", "", "", "alternate@example.test", ""],
            ["No", "", "", "", ""],
            ["Yes", "", "", "", ""],
        ], 1)]
        return headers, rows

    def test_sparse_conditional_columns_survive_csv_and_xlsx(self):
        headers, rows = self.conditional_survey()
        with tempfile.TemporaryDirectory() as folder:
            for suffix in ["csv", "xlsx"]:
                with self.subTest(format=suffix):
                    source = Path(folder) / f"conditional.{suffix}"
                    if suffix == "csv":
                        with source.open("w", newline="") as output:
                            csv.writer(output).writerows([headers, *rows])
                    else:
                        book = Workbook()
                        book.active.append(headers)
                        for row in rows:
                            book.active.append(row)
                        book.save(source)
                    loaded_headers, loaded_rows, provenance = engine.load(source)
                    self.assertEqual(loaded_headers, headers)
                    self.assertEqual(loaded_rows, rows)
                    profile = engine.inspect(loaded_headers, loaded_rows, provenance)
                    profile["id"] = "conditional"
                    self.assertIsNone(profile["followup"])
                    report = engine.report(loaded_headers, loaded_rows, provenance, profile, {})
                    self.assertEqual(len(report["questions"]), 164)
                    trailing = report["questions"][159:]
                    self.assertEqual([q["kind"] for q in trailing],
                                     ["choice", "private", "choice", "private", "metadata"])
                    self.assertEqual([q["answered"] for q in trailing], [5, 2, 2, 1, 0])
                    self.assertEqual(trailing[2]["blank"], 3)
                    self.assertEqual(trailing[2]["valid"], 2)
                    self.assertEqual({d["label"]: d["count"] for d in trailing[2]["distribution"]},
                                     {"No": 1, "Yes": 1})
                    self.assertIn("Branch eligibility is unknown", report["scope"]["population"])
                    self.assertNotIn("@example.test", json.dumps(report))
                    with self.assertRaisesRegex(engine.SurveyError, "consent mapping"):
                        engine.review(rows, profile, {}, "key", "contacts")
                    for field in ["c161", "c163"]:
                        with self.assertRaisesRegex(engine.SurveyError, "written-answer"):
                            engine.review(rows, profile, {}, "key", "answers", field)
                    profile["followup"] = {"contact": "c161", "consent": "c162", "value": "Yes"}
                    engine.validate(profile, headers, rows)
                    self.assertEqual([c["email"] for c in engine.review(
                        rows, profile, {}, "key", "contacts")["contacts"]], ["prize-research@example.test"])
                    profile["followup"] = {"contact": "c163", "addressIsConsent": True}
                    engine.validate(profile, headers, rows)
                    self.assertEqual([c["email"] for c in engine.review(
                        rows, profile, {}, "key", "contacts")["contacts"]], ["alternate@example.test"])

    def test_research_permission_exception_is_conservative(self):
        permission = self.conditional_survey()[0][161]
        for header, values, expected in [
            (permission, ["Yes", "", "No"], "choice"),
            (permission, ["yes", "", "no"], "choice"),
            (permission, ["", ""], "private"),
            (permission, ["Yes", "person@example.test"], "private"),
            (permission, ["Maybe"], "private"),
            ("May we contact you at your email address if you win the sweepstakes?", ["Yes", "No"], "private"),
            ("May we contact you for research? Please enter your email address.", ["Yes", "No"], "private"),
            (self.conditional_survey()[0][162], ["Yes", "No"], "private"),
        ]:
            with self.subTest(header=header, values=values):
                field = engine.inspect([header], [[v] for v in values], {"name": "test.csv"})["fields"][0]
                self.assertEqual(field["kind"], expected)
                self.assertEqual(field["choices"], list(dict.fromkeys(v for v in values if v))
                                 if expected == "choice" else [])

    def test_existing_developer_preset_and_saved_roles_stay_unchanged(self):
        preset = json.loads((Path(engine.__file__).resolve().parents[2] /
                             "profiles/net-developer-survey.json").read_text())
        headers = [f"Question {i}" for i in range(1, preset["columns"] + 1)]
        for index, title in preset["signature"].items():
            headers[int(index) - 1] = title
        rows = [[""] * len(headers)]
        rows[0][159:161] = ["Yes", "old@example.test"]
        profile = engine.inspect(headers, rows, {"name": "old.csv"})
        self.assertEqual(profile["title"], preset["title"])
        self.assertEqual(profile["followup"], preset["followup"])
        self.assertEqual(profile["fields"][159]["kind"], "choice")
        self.assertEqual(profile["fields"][160]["kind"], "private")
        engine.validate(profile, headers, rows)
        headers, rows = self.conditional_survey()
        saved = engine.inspect(headers, rows, {"name": "saved.csv"})
        saved["id"] = "saved"
        saved["fields"][161].update(kind="private", choices=[], filter=False)
        report = engine.report(headers, rows, {}, saved, {})
        self.assertEqual(report["questions"][161]["kind"], "private")
        self.assertIsNone(saved["followup"])

    def test_reader_preserves_unicode_with_non_utf8_stdout(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "unicode-\u65e5\u672c.xlsx"
            for value in ["good", "good \U0001f600", "caf\u00e9 \u65e5\u672c\u8a9e"]:
                book = Workbook()
                book.active.append(["ID", "Answer"])
                book.active.append(["1", value])
                book.save(source)
                for encoding in ["ascii", "cp1252"]:
                    with self.subTest(value=value, encoding=encoding):
                        result = subprocess.run(
                            [sys.executable, str(Path(engine.__file__))],
                            input=json.dumps({"source": str(source), "capture": True}, ensure_ascii=False).encode("utf-8"),
                            capture_output=True,
                            env={**os.environ, "PYTHONIOENCODING": encoding, "PYTHONUTF8": "0"},
                            timeout=30)
                        self.assertEqual(result.returncode, 0, result.stdout.decode("ascii", errors="replace"))
                        response = json.loads(result.stdout.decode("ascii"))
                        self.assertEqual(response["result"]["snapshot"]["rows"][0][1], value)

    def test_input_limits_accept_the_boundary(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "input.csv"
            text = "ID,Question\n1,ok\n"
            source.write_bytes(text.encode("utf-8"))
            with patch.multiple(engine, MAX_FILE_BYTES=len(text.encode()),
                                MAX_ROWS=1, MAX_COLUMNS=2, MAX_CELLS=4, MAX_CELL_CHARS=8):
                headers, rows, _ = engine.load(source)
                self.assertEqual(headers, ["ID", "Question"])
                self.assertEqual(rows, [["1", "ok"]])
            for value in ["", None, 123, []]:
                with self.subTest(source=value), self.assertRaisesRegex(engine.SurveyError, "Select"):
                    engine.load(value)
            source.write_text("ID,Question\n1\n2\n")
            with patch.object(engine, "MAX_CELLS", 4), self.assertRaisesRegex(engine.SurveyError, "padded"):
                engine.load(source)

    def test_workbook_values_and_damaged_sheet(self):
        book = Workbook()
        book.active.append(["ID", "Number", "Date", "Blank"])
        book.active.append([1, 1.5, datetime.datetime(2026, 10, 30), None])
        original = io.BytesIO()
        book.save(original)
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "input.xlsx"
            source.write_bytes(original.getvalue())
            _, rows, _ = engine.load(source)
            self.assertEqual(rows, [["1", "1.5", "2026-10-30 00:00:00", ""]])
            damaged = io.BytesIO()
            with zipfile.ZipFile(original) as archive, zipfile.ZipFile(damaged, "w") as target:
                for name in archive.namelist():
                    value = archive.read(name)
                    if name == "xl/worksheets/sheet1.xml":
                        value = value.replace(b"</sheetData>", b"</wrong>")
                    target.writestr(name, value)
            source.write_bytes(damaged.getvalue())
            with self.assertRaisesRegex(engine.SurveyError, "damaged"):
                engine.load(source)

    def test_invalid_exports_have_explicit_errors(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for text, message in [("", "header row"), (",\n1,2\n", "No source columns"),
                                  ("ID,Question\n", "no response rows"),
                                  ('ID,Question\n1,"unfinished', "invalid quoting")]:
                source = root / "input.csv"
                source.write_text(text)
                with self.subTest(text=text), self.assertRaisesRegex(engine.SurveyError, message):
                    engine.load(source)
            source.write_bytes(b"ID,Question\n1,\xff")
            with self.assertRaisesRegex(engine.SurveyError, "not UTF-8"):
                engine.load(source)
            source = root / "input.xlsx"
            source.write_bytes(b"not a workbook")
            with self.assertRaisesRegex(engine.SurveyError, "damaged"):
                engine.load(source)
            book = Workbook()
            book.active.append(["ID", "Question"])
            book.active.append(["1", "Answer"])
            book.save(source)
            for sheet in [-1, 1, "missing", True, []]:
                with self.subTest(sheet=sheet), self.assertRaisesRegex(engine.SurveyError, "sheet"):
                    engine.load(source, sheet=sheet)
            for header in [True, 0, 101, "1"]:
                with self.subTest(header=header), self.assertRaisesRegex(engine.SurveyError, "Header row"):
                    engine.load(source, header=header)
            for limit in ["MAX_FILE_BYTES", "MAX_EXPANDED_BYTES", "MAX_COLUMNS", "MAX_CELLS", "MAX_CELL_CHARS"]:
                with self.subTest(limit=limit), patch.object(engine, limit, 1):
                    with self.assertRaisesRegex(engine.SurveyError, "limit"):
                        engine.load(source)
            csv_source = root / "input.csv"
            csv_source.write_text("ID\n1\n2\n")
            with patch.object(engine, "MAX_ROWS", 1), self.assertRaisesRegex(engine.SurveyError, "row limit"):
                engine.load(csv_source)

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
