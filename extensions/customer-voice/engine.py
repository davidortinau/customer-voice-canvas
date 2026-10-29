"""Local, deterministic export analysis. Respondent data never enters a profile."""

import argparse
import csv
import hashlib
import hmac
import io
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

import pandas as pd


KINDS = {"system", "private", "metadata", "choice", "multiple", "ordered",
         "nps", "number", "date", "text", "unknown"}
EMAIL_ATOM = r"[A-Z0-9!#$%&'*+/=?^_`{|}~-]+"
EMAIL_LOCAL = rf'(?:{EMAIL_ATOM}(?:\.{EMAIL_ATOM})*|"(?:[^"\\\r\n]|\\[^\r\n])+")'
EMAIL_DOMAIN = r"[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?"
CONTACT_EMAIL = re.compile(rf"{EMAIL_LOCAL}@(?:{EMAIL_DOMAIN}\.)+[A-Z]{{2,}}", re.I)
# Scrub complete address-like tokens even when their format is not supported.
EMAIL = re.compile(r'(?:"(?:[^"\\\r\n]|\\[^\r\n])+"|[^\s<>()",;:@]+)@[^\s<>()",;:@]+')
PHONE = re.compile(r"(?<!\w)(?:\+?\d[\d ().-]{7,}\d)(?!\w)")
URL = re.compile(r"https?://\S+", re.I)
OBFUSCATED = re.compile(
    r"\b[\w.+-]+\s*(?:\[at\]|\(at\)| at )\s*[\w.-]+"
    r"\s*(?:\[dot\]|\(dot\)| dot )\s*[a-z]{2,}\b", re.I)
SCALES = [
    ["Extremely Dissatisfied", "Moderately Dissatisfied", "Slightly Dissatisfied",
     "Neither", "Slightly Satisfied", "Moderately Satisfied", "Extremely Satisfied"],
    ["Very dissatisfied", "Somewhat dissatisfied", "Neither satisfied nor dissatisfied",
     "Somewhat satisfied", "Very satisfied"],
    ["Not at all helpful", "Slightly helpful", "Moderately helpful", "Very helpful",
     "Extremely helpful"],
]


class SurveyError(Exception):
    pass


def load(source, sheet=0, header=1):
    path = Path(source).expanduser().resolve(strict=True)
    if path.suffix.lower() not in {".csv", ".xlsx"}:
        raise SurveyError("Select a CSV or XLSX export.")
    if not isinstance(header, int) or not 1 <= header <= 100:
        raise SurveyError("Header row must be between 1 and 100.")
    data = path.read_bytes()
    fingerprint = hashlib.sha256(data).hexdigest()
    if path.suffix.lower() == ".csv":
        text = data.decode("utf-8-sig")
        try:
            dialect = csv.Sniffer().sniff(text[:65536], delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        rows = list(csv.reader(io.StringIO(text), dialect))
        sheets = []
    else:
        book = pd.ExcelFile(io.BytesIO(data), engine="openpyxl")
        sheets = book.sheet_names
        frame = pd.read_excel(book, sheet_name=sheet, header=None,
                              dtype=str, keep_default_na=False)
        rows = frame.values.tolist()
    if len(rows) < header:
        raise SurveyError("The selected header row is outside the export.")
    headers = [str(x).strip() for x in rows[header - 1]]
    if not headers:
        raise SurveyError("No source columns found.")
    records = []
    for row in rows[header:]:
        if len(row) > len(headers) and any(str(x).strip() for x in row[len(headers):]):
            raise SurveyError("A response has more fields than the header.")
        values = [str(x).strip() for x in row[:len(headers)]]
        values += [""] * (len(headers) - len(values))
        if any(values):
            records.append(values)
    display_name = re.sub(r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}-", "", path.name)
    return headers, records, {"name": display_name, "sha256": fingerprint,
                             "rows": len(records), "columns": len(headers),
                             "sheets": sheets, "sheet": sheet, "header": header}


def values_for(rows, index):
    return [row[index] for row in rows if row[index]]


def split(value):
    return list(dict.fromkeys(x.strip() for x in value.split(";") if x.strip()))


def inspect(headers, rows, provenance):
    fields = []
    for index, title in enumerate(headers):
        values = values_for(rows, index)
        unique = list(dict.fromkeys(values))
        lower = title.casefold()
        kind = "unknown"
        reason = "The export does not define this question type."
        if lower in {"id", "response id", "start time", "completion time", "end time"}:
            kind, reason = "system", "Export response metadata."
        elif lower in {"personalized data", "personalised data"}:
            kind, reason = "metadata", "Private metadata. Only source can be enabled."
        elif lower == "name" or re.search(r"\b(email|e-mail|phone|address|upload)\b", lower):
            kind, reason = "private", "Possible identity or contact data."
        elif re.search(r"recommend", lower) and values and all(valid_score(v) for v in values):
            kind, reason = "nps", "Recommendation wording and observed integer scores 0-10."
        elif re.search(r"select (all|up to)|choose (all|up to)", lower):
            kind, reason = "multiple", "The header specifies multiple selections."
        elif values and all(number(v) is not None for v in values):
            kind, reason = "number", "Observed numeric values. Confirm units and meaning."
        elif len(unique) <= 16 and values and max(map(len, unique)) <= 180:
            kind, reason = "choice", "Few distinct values. Confirm that these are choices."
        elif values:
            kind, reason = "text", "Many distinct values or long written answers."
        choices = unique if kind in {"choice", "ordered"} else (
            list(dict.fromkeys(x for value in values for x in split(value)))
            if kind == "multiple" else [])
        # A small free-text column can resemble a categorical question.
        # Do not expose identifiers in the proposed choice list.
        if any(EMAIL.search(x) or URL.search(x) or OBFUSCATED.search(x) for x in choices):
            kind, choices, reason = "text", [], "Possible personal text. Review privately."
        for scale in SCALES:
            mapping = {x.casefold(): x for x in choices}
            if len(choices) >= 3 and all(x.casefold() in {s.casefold() for s in scale}
                                         for x in choices):
                choices = [mapping[x.casefold()] for x in scale if x.casefold() in mapping]
                kind, reason = "ordered", "Observed values match an ordered scale. Confirm order."
                break
        fields.append({"id": f"c{index + 1}", "index": index, "header": title,
                       "label": title or f"Unnamed column {index + 1}", "kind": kind,
                       "choices": choices, "positive": [], "exclude": [], "group": "",
                       "filter": kind == "choice" and len(choices) <= 12,
                       "reason": reason, "answered": len(values)})
    profile = {"version": 1, "title": Path(provenance["name"]).stem,
               "headers": headers, "fields": fields, "eligibility": None,
               "followup": None, "metadataSource": False}
    for path in (Path(__file__).resolve().parents[2] / "profiles").glob("*.json"):
        preset = json.loads(path.read_text())
        if len(headers) != preset["columns"] or any(
                headers[int(i) - 1] != title for i, title in preset["signature"].items()):
            continue
        profile["title"] = preset["title"]
        profile["followup"] = preset.get("followup")
        for key in ["eligibility", "submission", "metadataSource"]:
            if key in preset:
                profile[key] = preset[key]
        for override in preset["overrides"]:
            for index in range(override["start"] - 1, override.get("end", override["start"])):
                field = fields[index]
                field.update({k: v for k, v in override.items() if k not in {"start", "end"}})
                if "choices" not in override and field["kind"] in {"choice", "multiple"}:
                    field["choices"] = list(dict.fromkeys(
                        x for v in values_for(rows, index)
                        for x in (split(v) if field["kind"] == "multiple" else [v])))
                field["reason"] = "Bundled profile suggestion. Confirm against the survey definition."
        break
    return profile


def number(value):
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


def valid_score(value):
    n = number(value)
    return n is not None and n.is_integer() and 0 <= n <= 10


def validate(profile, headers, rows):
    if profile.get("version") != 1 or profile.get("headers") != headers:
        raise SurveyError("The export columns changed. Review the survey profile again.")
    fields = profile.get("fields", [])
    if len(fields) != len(headers):
        raise SurveyError("The profile must account for every source column.")
    ids = set()
    for index, field in enumerate(fields):
        if (field.get("index") != index or field.get("header") != headers[index]
                or field.get("id") != f"c{index + 1}" or field["id"] in ids
                or field.get("kind") not in KINDS):
            raise SurveyError("Invalid source column mapping.")
        ids.add(field["id"])
        for key in ["choices", "positive", "exclude"]:
            if (not isinstance(field.get(key), list)
                    or not all(isinstance(x, str) for x in field[key])
                    or len(set(field[key])) != len(field[key])):
                raise SurveyError("Choices, positive values, and exclusions must be unique text lists.")
        if not isinstance(field.get("label"), str) or not isinstance(field.get("group"), str):
            raise SurveyError("Question labels and groups must be text.")
        if field["positive"] and field["kind"] not in {"choice", "ordered"}:
            raise SurveyError("Positive-share scoring requires a choice or ordered scale.")
        if not set(field["positive"]) <= set(field["choices"]) - set(field["exclude"]):
            raise SurveyError("Positive choices must be included in the valid scale.")
        if field["kind"] in {"choice", "ordered", "multiple"}:
            observed = set(x for v in values_for(rows, index)
                           for x in (split(v) if field["kind"] == "multiple" else [v]))
            if observed - set(field["choices"]) - set(field["exclude"]):
                raise SurveyError(f"Choices changed in column {index + 1}. Review the profile again.")
        if field["kind"] == "nps" and any(
                not valid_score(v) for v in values_for(rows, index) if v not in field["exclude"]):
            raise SurveyError(f"Column {index + 1} has invalid NPS scores.")
    by_id = {f["id"]: f for f in fields}
    rule = profile.get("eligibility")
    if rule and (rule.get("field") not in by_id or
                 by_id[rule["field"]]["kind"] not in {"choice", "ordered"} or
                 rule.get("value") not in by_id[rule["field"]]["choices"]):
        raise SurveyError("Eligibility requires a mapped choice and value.")
    submission = profile.get("submission")
    if submission and (submission.get("field") not in by_id or
                       submission.get("kind") != "date" or
                       by_id[submission["field"]]["kind"] not in {"system", "date"}):
        raise SurveyError("Submission requires a mapped completion date field.")
    followup = profile.get("followup")
    if followup:
        contact = by_id.get(followup.get("contact"))
        consent = by_id.get(followup.get("consent"))
        if not contact or contact["kind"] != "private":
            raise SurveyError("Follow-up contact must map to a private field.")
        if not followup.get("addressIsConsent") and (
                not consent or consent["kind"] not in {"choice", "ordered"}
                or followup.get("value") not in consent["choices"]):
            raise SurveyError("Select a valid consent field and affirmative value.")
    return by_id


def metadata_source(row, fields):
    for field in fields:
        if field["kind"] == "metadata":
            for entry in row[field["index"]].split(";"):
                key, sep, value = entry.partition(":")
                if sep and key.strip().casefold() == "source":
                    value = value.strip()
                    if re.fullmatch(r"[A-Za-z0-9_. -]{1,60}", value):
                        return value
                    return "[unapproved source value]"
    return "[missing]"


def submitted_rows(rows, profile):
    submission = profile.get("submission")
    if not submission:
        return rows
    field = next(f for f in profile["fields"] if f["id"] == submission["field"])
    values = pd.to_datetime(pd.Series([r[field["index"]] for r in rows], dtype=str),
                            errors="coerce", format="mixed")
    return [r for r, valid in zip(rows, values.notna()) if valid]


def select_rows(rows, profile, filters, population="eligible"):
    fields = {f["id"]: f for f in profile["fields"]}
    selected = submitted_rows(rows, profile)
    rule = profile.get("eligibility")
    if rule and population == "eligible":
        selected = [r for r in selected if r[fields[rule["field"]]["index"]] == rule["value"]]
    eligible = len(selected)
    if not isinstance(filters, dict):
        raise SurveyError("Filters must be a question-to-choice object.")
    for key, value in filters.items():
        if not isinstance(value, str):
            raise SurveyError("Filter values must be text.")
        if key == "source" and profile.get("metadataSource"):
            selected = [r for r in selected if metadata_source(r, profile["fields"]) == value]
        else:
            field = fields.get(key)
            if not field or not field.get("filter") or field["kind"] not in {"choice", "ordered", "multiple"}:
                raise SurveyError("This question is not an approved cohort filter.")
            if value not in field["choices"]:
                raise SurveyError("The selected filter value is not in this survey.")
            selected = [r for r in selected if value in (
                split(r[field["index"]]) if field["kind"] == "multiple" else [r[field["index"]]])]
    return selected, eligible


def metric_status(n):
    return "suppressed" if n < 5 else "directional" if n < 30 else "standard"


def question(field, rows):
    values = values_for(rows, field["index"])
    valid = [v for v in values if v not in field["exclude"]]
    kind = field["kind"]
    result = {k: field[k] for k in ["id", "label", "header", "kind", "group", "choices"]}
    result.update(answered=len(values), blank=len(rows) - len(values),
                  excluded=len(values) - len(valid), valid=len(valid), metric=None)
    if kind in {"text", "private", "metadata", "system", "unknown"}:
        return result
    if kind in {"choice", "ordered", "multiple"}:
        counts = Counter(x for v in valid for x in (split(v) if kind == "multiple" else [v]))
        result["distribution"] = [{"label": v, "count": counts[v],
                                   "percent": round(counts[v] / len(valid) * 100, 1) if valid else 0}
                                  for v in field["choices"] if v not in field["exclude"]]
        result["multiSelect"] = kind == "multiple"
    if kind == "nps":
        scores = [int(float(v)) for v in valid if valid_score(v)]
        n = len(scores)
        promoters = sum(v >= 9 for v in scores)
        detractors = sum(v <= 6 for v in scores)
        result["valid"] = n
        result["excluded"] += len(valid) - n
        result["distribution"] = [{"label": str(v), "count": scores.count(v),
                                   "percent": round(scores.count(v) / n * 100, 1) if n else 0}
                                  for v in range(11)]
        result["metric"] = {"label": "NPS", "value": round((promoters - detractors) / n * 100, 1)
                            if n >= 5 else None, "numerator": promoters - detractors,
                            "denominator": n, "promoters": promoters, "detractors": detractors,
                            "passives": n - promoters - detractors, "status": metric_status(n),
                            "method": "(9-10 count minus 0-6 count) / valid 0-10 answers x 100"}
    elif kind == "number":
        nums = [number(v) for v in valid if number(v) is not None]
        counts = Counter(nums)
        if len(counts) <= 20:
            result["distribution"] = [{"label": str(v), "count": counts[v],
                                       "percent": round(counts[v] / len(nums) * 100, 1)}
                                      for v in sorted(counts)]
        else:
            low, high = min(nums), max(nums)
            width = (high - low) / 10
            bins = Counter(min(9, int((v - low) / width)) for v in nums)
            result["distribution"] = [
                {"label": f"{low + i * width:g} to {low + (i + 1) * width:g}",
                 "count": bins[i], "percent": round(bins[i] / len(nums) * 100, 1)}
                for i in range(10)]
        result.update(valid=len(nums), excluded=len(values) - len(nums),
                      units="Source units are not defined.")
    elif kind == "date":
        dates = pd.to_datetime(pd.Series(valid, dtype=str), errors="coerce", format="mixed").dropna()
        counts = Counter(dates.dt.strftime("%Y-%m-%d"))
        result.update(valid=len(dates), excluded=len(values) - len(dates),
                      distribution=[{"label": k, "count": n,
                                     "percent": round(n / len(dates) * 100, 1)}
                                    for k, n in sorted(counts.items())],
                      units="Date as exported. Source time zone is not defined.")
    if field["positive"]:
        n = len(valid)
        numerator = sum(v in field["positive"] for v in valid)
        result["metric"] = {
            "label": field.get("metricLabel", "Positive share"), "value": round(numerator / n * 100, 1) if n >= 5 else None,
            "numerator": numerator, "denominator": n, "status": metric_status(n),
            "method": "Positive: " + "; ".join(field["positive"]) +
                      ". Excluded: " + ("; ".join(field["exclude"]) or "none") + ". Blanks excluded."}
    return result


def report(headers, rows, provenance, profile, filters, population="eligible"):
    validate(profile, headers, rows)
    if population not in {"eligible", "submitted"}:
        raise SurveyError("Select eligible or submitted responses.")
    selected, _ = select_rows(rows, profile, filters, population)
    _, eligible = select_rows(rows, profile, {}, "eligible")
    fields = profile["fields"]
    options = [{"id": f["id"], "label": f["label"], "values": f["choices"]}
               for f in fields if f.get("filter") and f["kind"] in {"choice", "ordered", "multiple"}]
    if profile.get("metadataSource"):
        options.append({"id": "source", "label": "Source metadata",
                        "values": sorted({metadata_source(r, fields) for r in rows})})
    questions = [question(f, selected) for f in fields]
    groups = []
    if profile.get("metadataSource"):
        for source in sorted({metadata_source(r, fields) for r in selected}):
            group = [r for r in selected if metadata_source(r, fields) == source]
            groups.append({"source": source, "n": len(group),
                           "metrics": [{"id": f["id"], "question": f["label"],
                                        **question(f, group)["metric"]}
                                       for f in fields if f["kind"] == "nps" or f["positive"]]})
    return {"surveyId": profile["id"], "title": profile["title"], "source": provenance,
            "scope": {"exported": len(rows), "submitted": len(submitted_rows(rows, profile)),
                      "eligible": eligible, "selected": len(selected), "populationKey": population,
                      "eligibility": profile.get("eligibility"), "filters": filters,
                      "population": "All submitted responses" if population == "submitted" else
                      "Configured eligible responses" if profile.get("eligibility")
                      else "All submitted responses. Branch eligibility is unknown." if profile.get("submission")
                      else "All exported response rows. Branch eligibility is unknown."},
            "questions": questions, "filterOptions": options, "sourceGroups": groups,
            "contactEnabled": bool(profile.get("followup")),
            "warning": "Private review. Automated redaction is not proof of anonymity. Review quotes before sharing."}


def redact(value, row, fields):
    text = value
    for field in fields:
        if field["kind"] == "private":
            private = row[field["index"]]
            if private and len(private) >= 3:
                text = re.sub(re.escape(private), "[private value removed]", text, flags=re.I)
                if field["header"].casefold() == "name":
                    for part in re.findall(r"[^\W\d_]+", private):
                        if len(part) >= 3:
                            text = re.sub(r"\b" + re.escape(part) + r"\b",
                                          "[name removed]", text, flags=re.I)
    text = EMAIL.sub("[email removed]", text)
    text = OBFUSCATED.sub("[email removed]", text)
    text = PHONE.sub("[number removed]", text)
    text = URL.sub("[link removed]", text)
    if re.search(r"\b(my name is|call me|I am named)\b", text, re.I) or re.search(
            r"\b(?:I am|I['\u2019]m|This is)\s+[A-Z][a-z]+(?:[-'\u2019][A-Za-z]+)?\b", text):
        return "[withheld for identity review]"
    return text


def review(rows, profile, filters, key, mode, field_id=None, population="eligible"):
    selected, _ = select_rows(rows, profile, filters, population)
    fields = {f["id"]: f for f in profile["fields"]}
    id_field = next((f for f in fields.values()
                     if f["kind"] == "system" and f["header"].casefold() in {"id", "response id"}), None)
    all_ids = [r[id_field["index"]] for r in rows] if id_field else []
    if id_field and (len(set(all_ids)) != len(all_ids) or "" in all_ids):
        raise SurveyError("Response IDs are blank or duplicated. Private joins are disabled.")

    def reference(row):
        identity = row[id_field["index"]] if id_field else json.dumps(row, ensure_ascii=False)
        return hmac.new(key.encode(), (profile["id"] + ":" + identity).encode(),
                        hashlib.sha256).hexdigest()[:16]

    if mode == "answers":
        field = fields.get(field_id)
        if not field or field["kind"] != "text":
            raise SurveyError("Select a mapped written-answer question.")
        return {"question": field_id, "total": sum(bool(r[field["index"]]) for r in selected),
                "answers": [{"id": reference(r), "text": redact(r[field["index"]], r, list(fields.values()))}
                            for r in selected if r[field["index"]]]}
    config = profile.get("followup")
    if not config:
        raise SurveyError("Confirm the follow-up consent mapping in the profile first.")
    contact = fields[config["contact"]]
    consent = fields.get(config.get("consent"))
    consented = [r for r in selected if r[contact["index"]] and (
        config.get("addressIsConsent") or r[consent["index"]] == config["value"])]
    return {"contacts": [{"id": reference(r), "email": r[contact["index"]]}
                         for r in consented if CONTACT_EMAIL.fullmatch(r[contact["index"]])],
            "unsupportedAddressCount": sum(
                not bool(CONTACT_EMAIL.fullmatch(r[contact["index"]])) for r in consented)}


def run(request):
    if "snapshot" in request:
        headers, rows, provenance = (request["snapshot"][key] for key in ["headers", "rows", "source"])
    else:
        headers, rows, provenance = load(request["source"], request.get("sheet", 0), request.get("header", 1))
    expected = request.get("sha256")
    if expected and expected != provenance["sha256"]:
        raise SurveyError("The source changed. Click Refresh data to load it explicitly.")
    mode = request.get("mode", "inspect")
    if mode == "inspect":
        profile = inspect(headers, rows, provenance)
        if provenance.get("kind") == "dataverse":
            profile["columnIds"] = provenance["columnIds"]
            profile["sourceIdentity"] = provenance["identity"]
            profile["sourceDefinition"] = provenance["definitionHash"]
            for suggestion in request["snapshot"].get("suggestions", []):
                profile["fields"][suggestion["index"]].update(
                    {k: v for k, v in suggestion.items() if k != "index"})
            profile["submission"] = {"field": "c3", "kind": "date"}
        return {"profile": profile, "source": provenance,
                **({"snapshot": {"headers": headers, "rows": rows, "source": provenance}}
                   if request.get("capture") else {})}
    profile = request["profile"]
    if provenance.get("kind") == "dataverse" and (
            profile.get("sourceIdentity") != provenance["identity"] or
            profile.get("columnIds") != provenance["columnIds"] or
            profile.get("sourceDefinition") != provenance["definitionHash"]):
        raise SurveyError("The live survey or question identity changed. Review the profile.")
    validate(profile, headers, rows)
    if mode == "report":
        return report(headers, rows, provenance, profile, request.get("filters", {}),
                      request.get("population", "eligible"))
    if mode in {"answers", "contacts"}:
        return review(rows, profile, request.get("filters", {}), request["key"], mode,
                      request.get("question"), request.get("population", "eligible"))
    raise SurveyError("Unknown survey operation.")


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
    try:
        print(json.dumps({"result": run(json.load(sys.stdin))}, ensure_ascii=False))
    except (SurveyError, OSError, ValueError, KeyError, TypeError, UnicodeError) as error:
        # Only known application errors can include a message in an API reply.
        message = str(error) if isinstance(error, SurveyError) else (
            f"Cannot read the export ({type(error).__name__}). Check its path, sheet, header, and format.")
        print(json.dumps({"error": message}))
        sys.exit(1)
