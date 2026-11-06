import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewerThemes, chartThemes, validateAppearance, chartPalette, chartColor } from "../extensions/customer-voice/themes.mjs";
import { questionGraphic, exportSettings } from "../extensions/customer-voice/presentation.mjs";
import { startViewer } from "../extensions/customer-voice/server.mjs";

test("viewer themes have readable text and custom themes accept only bounded color settings", () => {
    for (const theme of viewerThemes.filter(theme => theme.colors)) {
        assert.doesNotThrow(() => validateAppearance({ ...validateAppearance(),
            viewer: "custom", customViewer: { name: theme.name, colors: theme.colors } }), theme.name);
    }
    assert.throws(() => validateAppearance({ ...validateAppearance(), viewer: "missing" }), /available/);
    assert.throws(() => validateAppearance({ ...validateAppearance(), viewer: "custom" }), /available/);
    const appearance = { ...validateAppearance(), viewer: "custom", chart: "custom",
        customViewer: { name: "My theme", colors: { ...viewerThemes[1].colors } },
        customChart: { name: "My palette", colors: [...chartThemes[1].colors], nps: [...chartThemes[1].nps] } };
    assert.deepEqual(validateAppearance(appearance), appearance);
    assert.throws(() => validateAppearance({ ...appearance, rows: [] }), /Invalid theme/);
    assert.throws(() => validateAppearance({ ...appearance,
        customViewer: { ...appearance.customViewer, colors: { ...appearance.customViewer.colors, ink: "#f8faff" } } }), /contrast/);
    assert.throws(() => validateAppearance({ ...appearance,
        customViewer: { ...appearance.customViewer, colors: { ...appearance.customViewer.colors, paper: "url(https://example.test)" } } }), /hex/);
    assert.throws(() => validateAppearance({ ...appearance,
        customChart: { ...appearance.customChart, colors: ["#ffffff"] } }), /six chart/);
    assert.throws(() => validateAppearance({ ...appearance,
        customChart: { ...appearance.customChart, name: "x".repeat(61) } }), /palette name/);
});

test("graphic colors depend on the chart palette, not the viewer theme", () => {
    const q = { label: "Question", kind: "choice", answered: 10, blank: 0, valid: 10, excluded: 0,
        distribution: [{ label: "A", count: 6, percent: 60 }, { label: "B", count: 4, percent: 40 }] };
    const appearance = { ...validateAppearance(), chart: "orchid" };
    const first = questionGraphic(q, "donut", "", appearance);
    const dark = questionGraphic(q, "donut", "", { ...appearance, viewer: "midnight" });
    assert.equal(first, dark);
    assert.match(first, /#8b64ab/);
    assert.notEqual(first, questionGraphic(q, "donut", "", { ...appearance, chart: "coast" }));
    assert.equal(chartColor(0, 6, chartPalette(appearance)), "#8b64ab");
});

test("themes persist and sharing imports custom colors while version 1 keeps current themes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cv-theme-test-"));
    let viewer, second;
    try {
        const source = join(root, "survey.csv"), storage = join(root, "profiles");
        await writeFile(source, "ID,Question\n1,A\n2,B\n");
        viewer = await startViewer({}, { storage });
        const proposal = await viewer.operation("inspect", { path: source });
        const report = await viewer.operation("confirm", { ticket: proposal.ticket, profile: proposal.profile });
        const request = { surveyId: report.surveyId }, file = join(storage, `${report.surveyId}.json`);
        const appearance = { ...validateAppearance(), viewer: "custom", chart: "custom",
            customViewer: { name: "My studio", colors: { ...viewerThemes[1].colors } },
            customChart: { name: "My coast", colors: [...chartThemes[1].colors], nps: [...chartThemes[1].nps] } };
        await viewer.operation("appearance", { ...request, appearance });
        const before = await readFile(file, "utf8");
        await assert.rejects(viewer.operation("appearance", request), /Select viewer/);
        await assert.rejects(viewer.operation("appearance", { ...request, appearance: { ...appearance, chart: "unknown" } }), /available/);
        await assert.rejects(viewer.operation("appearance", { ...request, appearance: { ...appearance,
            customChart: { ...appearance.customChart, colors: Array(6).fill("#ffffff") } } }), /3:1/);
        assert.equal(await readFile(file, "utf8"), before);
        second = await startViewer({}, { storage });
        assert.deepEqual((await second.operation("open", { id: report.surveyId })).appearance, appearance);
        const settings = await viewer.operation("settings", { ...request, action: "export" });
        assert.equal(settings.version, 2);
        assert.deepEqual(settings.appearance, appearance);
        assert.doesNotMatch(JSON.stringify(settings), /survey.csv|sha256|rows|sourceCommit/);
        const { appearance: omitted, ...legacy } = settings;
        await viewer.operation("settings", { ...request, action: "apply", settings: { ...legacy, version: 1 } });
        assert.deepEqual((await viewer.operation("scope")).appearance, appearance);
        await assert.rejects(viewer.operation("settings", { ...request, action: "apply",
            settings: { ...settings, appearance: { ...appearance, extra: "private" } } }), /Invalid theme/);
        const after = JSON.parse(await readFile(file, "utf8"));
        assert.deepEqual(after.profile.appearance, appearance);
        assert.equal(exportSettings(after.profile).version, 2);
    } finally {
        await viewer?.close(); await second?.close();
        await rm(root, { recursive: true, force: true });
    }
});
