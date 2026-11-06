import assert from "node:assert/strict";
import { test } from "node:test";
import { viewerThemes, chartThemes, systemColors, chartColor, contrast, mix, validateAppearance } from "../extensions/customer-voice/themes.mjs";
import { questionGraphic, importSettings, exportSettings } from "../extensions/customer-voice/presentation.mjs";

test("every shipped viewer surface has readable text, controls, focus, and tooltips", () => {
    for (const [name, c] of [...viewerThemes.filter(t => t.colors).map(t => [t.id, t.colors]), ...Object.entries(systemColors)]) {
        const backgrounds = [c.paper, mix(c.paper, c.accent, .06), mix(c.paper, c.muted, .12)];
        for (const background of backgrounds) {
            for (const key of ["ink", "muted"]) assert.ok(contrast(c[key], background) >= 4.5, `${name}/${key}/${background}`);
            assert.ok(contrast(c.accent, background) >= 3, `${name} selected indicator`);
        }
        assert.ok(contrast(c.paper, c.accent) >= 4.5, `${name} primary button`);
        assert.ok(contrast(c.paper, mix(c.accent, c.ink, .2)) >= 4.5, `${name} primary hover`);
        assert.ok(contrast(c.paper, c.ink) >= 4.5, `${name} tooltip`);
    }
});

test("all chart scales and NPS colors meet 3:1 against white, with independent high-contrast boundaries on every viewer", () => {
    for (const palette of chartThemes) {
        for (let index = 0; index < 256; index++) {
            assert.ok(contrast(chartColor(index, 256, palette), "#ffffff") >= 3, `${palette.id}/${index}`);
        }
        for (const color of palette.nps) assert.ok(contrast(color, "#ffffff") >= 3, `${palette.id} NPS`);
        for (const viewer of [...viewerThemes.filter(t => t.colors).map(t => t.colors), ...Object.values(systemColors)]) {
            assert.ok(contrast(viewer.ink, viewer.paper) >= 4.5, `${palette.id} dual-tone chart boundary`);
        }
    }
});

test("new custom edits reject low contrast, while older settings stay loadable with redundant chart cues", () => {
    const appearance = { ...validateAppearance(), chart: "custom",
        customChart: { name: "Old pale palette", colors: Array(6).fill("#ffffff"), nps: Array(3).fill("#ffffff") } };
    assert.doesNotThrow(() => validateAppearance(appearance));
    assert.throws(() => validateAppearance(appearance, { editing: true }), /Chart color 1.*3:1/);
    const profile = { fields: [{ id: "c1", header: "Question", kind: "choice" }], appearance };
    assert.doesNotThrow(() => importSettings(profile, exportSettings(profile)));
    const q = { id: "c1", label: "Question", kind: "choice", answered: 10, valid: 10, blank: 0, excluded: 0,
        distribution: [{ label: "First", count: 6, percent: 60 }, { label: "Second", count: 4, percent: 40 }] };
    for (const chart of ["pie", "donut", "stacked"]) {
        const svg = questionGraphic(q, chart, "", appearance);
        assert.match(svg, /<pattern /);
        assert.match(svg, /chart-number/);
        assert.match(svg, /1\. First/);
        assert.match(svg, /2\. Second/);
        assert.match(svg, /mark-halo/);
        assert.match(svg, /numbered rows/);
    }
});
