import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chartOptions, validatePresentations, exportSettings, importSettings, questionGraphic } from "../extensions/customer-voice/presentation.mjs";
import { startViewer } from "../extensions/customer-voice/server.mjs";
import { validateAppearance } from "../extensions/customer-voice/themes.mjs";

test("chart choices match the dimensions and preserve counts", () => {
    for (const kind of ["multiple", "number", "date"]) {
        assert.ok(!chartOptions({ kind }).includes("pie"));
        assert.ok(!chartOptions({ kind }).includes("stacked"));
    }
    const q = { id: "c1", label: "<script> & Long question", kind: "choice",
        answered: 10, blank: 3, valid: 10, excluded: 0,
        distribution: [{ label: "A & B", count: 7, percent: 70 }, { label: "C", count: 3, percent: 30 }] };
    for (const chart of chartOptions(q)) {
        const svg = questionGraphic(q, chart, "Eligible responses");
        assert.match(svg, /&lt;script&gt; &amp;/);
        assert.doesNotMatch(svg, /<script>|NaN|Infinity|foreignObject|href=/);
        if (chart === "table") {
            assert.match(svg, />7<\/text>/);
            assert.match(svg, />70%<\/text>/);
            assert.match(svg, />3<\/text>/);
            assert.match(svg, />30%<\/text>/);
        } else {
            assert.match(svg, /7 \/ 70%|70% \/ 7/);
            assert.match(svg, /3 \/ 30%|30% \/ 3/);
        }
        assert.match(svg, /Denominator: 10/);
    }
    for (const chart of ["pie", "donut", "stacked"]) {
        assert.doesNotMatch(questionGraphic({ ...q, distribution: [{ label: "Only", count: 10, percent: 100 }] }, chart), /NaN|Infinity/);
        assert.doesNotMatch(questionGraphic({ ...q, valid: 0, distribution: [{ label: "Only", count: 0, percent: 0 }] }, chart), /NaN|Infinity/);
    }
    assert.throws(() => questionGraphic({ ...q, kind: "multiple" }, "pie"), /not available/);
    assert.match(questionGraphic({ ...q, kind: "text", distribution: undefined }, "summary"), /counts only/);
});

test("portable settings contain configuration only and require stable matching identities", () => {
    const profile = { fields: [
        { id: "c1", header: "Question", kind: "choice", index: 0 },
        { id: "c2", header: "Email", kind: "private", index: 1 },
    ], presentations: { c1: { chart: "donut" } },
    source: "/private/report.csv", key: "secret", filters: { c1: "private filter" },
    rows: [["private answer", "private@example.test"]] };
    const settings = exportSettings(profile);
    assert.deepEqual(settings, { format: "customer-voice-presentation", version: 2,
        appearance: validateAppearance(),
        questions: [{ id: "c1", header: "Question", kind: "choice", chart: "donut" }] });
    assert.deepEqual(importSettings(profile, settings), profile.presentations);
    const { appearance, ...legacy } = settings;
    assert.deepEqual(importSettings(profile, { ...legacy, version: 1 }), profile.presentations);
    assert.throws(() => importSettings(profile, { ...settings, rows: profile.rows }), /settings file/);
    assert.throws(() => importSettings(profile, { ...settings, questions: [] }), /structure/);
    assert.throws(() => importSettings(profile, { ...settings, questions: [{ ...settings.questions[0], header: "Different" }] }), /identities/);
    assert.throws(() => validatePresentations(profile, { c9: { chart: "pie" } }), /question type/);
    assert.throws(() => validatePresentations(profile, { c1: { chart: "pie", data: [] } }), /question type/);
    const live = { ...profile, columnIds: ["question-guid", "email-guid"] };
    const liveSettings = exportSettings(live);
    assert.deepEqual(importSettings(live, liveSettings), profile.presentations);
    assert.throws(() => importSettings({ ...live, columnIds: ["different-guid", "email-guid"] }, liveSettings), /identities/);
    assert.throws(() => importSettings(profile, liveSettings), /identities/);
});

test("presentation saves and settings imports persist without changing profiles or response data", async () => {
    const root = await mkdtemp(join(tmpdir(), "cv-settings-"));
    const source = join(root, "survey.csv"), storage = join(root, "profiles");
    let viewer;
    try {
        await writeFile(source, "ID,Question,Written answer\n1,A,Private response\n2,B,Another private response\n");
        viewer = await startViewer({}, { storage });
        const proposal = await viewer.operation("inspect", { path: source });
        proposal.profile.fields[2].kind = "text";
        proposal.profile.fields[2].choices = [];
        const report = await viewer.operation("confirm", { ticket: proposal.ticket, profile: proposal.profile });
        const file = join(storage, `${report.surveyId}.json`);
        const original = JSON.parse(await readFile(file, "utf8"));
        const request = { surveyId: report.surveyId };
        await viewer.operation("presentation", { ...request, presentations: { c2: { chart: "dot" } } });
        assert.equal((await viewer.operation("open", { id: report.surveyId })).presentations.c2.chart, "dot");
        const settings = await viewer.operation("settings", { ...request, action: "export" });
        assert.doesNotMatch(JSON.stringify(settings), /Private response|private response|survey.csv|rows|sha256/);
        settings.questions[0].chart = "donut";
        const before = await readFile(file, "utf8");
        await viewer.operation("settings", { ...request, action: "check", settings });
        assert.equal(await readFile(file, "utf8"), before);
        await assert.rejects(viewer.operation("settings", { ...request, action: "apply",
            settings: { ...settings, version: 9 } }), /settings file/);
        assert.equal(await readFile(file, "utf8"), before);
        await viewer.operation("settings", { ...request, action: "apply", settings });
        const after = JSON.parse(await readFile(file, "utf8"));
        assert.deepEqual(after.profile.fields, original.profile.fields);
        assert.deepEqual(after.source, original.source);
        assert.equal(after.key, original.key);
        assert.equal(after.profile.presentations.c2.chart, "donut");
        assert.doesNotMatch(await readFile(file, "utf8"), /Private response/);
        await assert.rejects(viewer.operation("presentation", { surveyId: "stale", presentations: {} }), /report changed/);
        const previewProposal = await viewer.operation("inspect", { path: source });
        await viewer.operation("preview", { ticket: previewProposal.ticket });
        await assert.rejects(viewer.operation("presentation", { ...request, presentations: {} }), /save the profile/);
        assert.equal(JSON.parse(await readFile(file, "utf8")).profile.presentations.c2.chart, "donut");
    } finally {
        await viewer?.close();
        await rm(root, { recursive: true, force: true });
    }
});
