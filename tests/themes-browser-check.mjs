import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { chartColor, chartPalette, validateAppearance } from "../extensions/customer-voice/themes.mjs";

const { startViewer } = await import(process.env.CUSTOMER_VOICE_PLUGIN_ROOT
    ? pathToFileURL(resolve(process.env.CUSTOMER_VOICE_PLUGIN_ROOT, "extensions/customer-voice/server.mjs")).href
    : new URL("../extensions/customer-voice/server.mjs", import.meta.url).href);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const root = await mkdtemp(join(tmpdir(), "cv-themes-browser-"));
const source = join(root, "survey.csv"), storage = join(root, "profiles");
const csv = count => "ID,Recommend this product,Satisfaction,Written answer\n" +
    Array.from({ length: count }, (_, i) => `${i},${i % 11},${["Poor", "Fair", "Good"][i % 3]},Private response ${i}`).join("\n");
await writeFile(source, csv(40));
let viewer = await startViewer({ source }, { storage });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const idle = () => page.locator("#status:empty").waitFor({ state: "attached" });
const openAppearance = async () => page.locator("#open-appearance").click();
const saveAppearance = async () => { await page.locator("#save-appearance").click(); await idle(); };
const evidence = async name => {
    if (!process.env.CUSTOMER_VOICE_EVIDENCE) return;
    await mkdir(process.env.CUSTOMER_VOICE_EVIDENCE, { recursive: true });
    const path = join(process.env.CUSTOMER_VOICE_EVIDENCE, name);
    if (["appearance-presets.png", "quick-view-controls.png"].includes(name)) await page.locator("#appearance-dialog").screenshot({ path });
    else await page.screenshot({ path, fullPage: name !== "mobile-theme-picker.png" });
};
const colorInput = async (selector, color) => page.locator(selector).evaluate((input, value) => {
    input.value = value; input.dispatchEvent(new Event("input", { bubbles: true }));
}, color);
const colors = () => page.evaluate(() => ({
    paper: getComputedStyle(document.documentElement).getPropertyValue("--paper").trim(),
    bars: [...document.querySelectorAll(".horizontal .chart-segment")].map(node => node.style.background),
    nps: [...document.querySelectorAll(".histogram .chart-segment")].map(node => node.style.background),
}));
try {
    await page.goto(viewer.url); await idle();
    await page.getByRole("button", { name: "View report", exact: true }).click(); await idle();
    assert.equal((await viewer.operation("scope")).preview, true);
    await openAppearance();
    assert.equal(await page.locator("#save-appearance").isEnabled(), true,
        "Quick view must allow appearance changes without a saved profile.");
    assert.equal(await page.locator("#save-appearance").innerText(), "Apply appearance");
    await page.locator('[data-viewer-theme="high-contrast"]').click();
    await page.locator('[data-chart-theme="accessible"]').click();
    await evidence("quick-view-controls.png");
    await page.setViewportSize({ width: 320, height: 256 });
    assert.equal(await page.locator("#appearance-dialog").evaluate(dialog => dialog.scrollWidth > dialog.clientWidth), false);
    await page.locator("#save-appearance").scrollIntoViewIfNeeded();
    assert.equal(await page.locator("#save-appearance").evaluate(button => {
        const bounds = button.getBoundingClientRect();
        return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === button;
    }), true);
    await page.locator("#save-appearance").click(); await idle();
    await page.setViewportSize({ width: 1280, height: 1000 });
    let quick = await viewer.operation("scope");
    assert.equal(quick.appearance.viewer, "high-contrast");
    assert.equal(quick.appearance.chart, "accessible");
    assert.equal(quick.preview, true); assert.equal(quick.contactEnabled, false);
    assert.equal((await viewer.operation("config")).surveys.length, 0);
    assert.equal(await page.locator("#appearance-dialog").isVisible(), false);
    await evidence("quick-view-applied.png");
    await openAppearance();
    await page.getByText("Create a custom viewer theme", { exact: true }).click();
    await page.locator("#custom-viewer-name").fill("Quick view studio");
    await page.getByText("Create a custom chart palette", { exact: true }).click();
    await page.locator("#custom-chart-name").fill("Quick view coast");
    await page.locator("#hex-chart-0").fill("#245c88");
    await page.locator("#hex-viewer-ink").fill("#ffffff");
    await page.locator("#save-appearance").focus(); await page.keyboard.press("Enter");
    assert.equal(await page.locator("#appearance-dialog").isVisible(), true);
    assert.match(await page.locator("#appearance-error").innerText(), /contrast/);
    assert.equal(await page.locator("#appearance-error").evaluate(node => node === document.activeElement), true);
    assert.equal((await viewer.operation("scope")).appearance.viewer, "high-contrast");
    await page.locator("#hex-viewer-ink").fill("#111111");
    await page.locator("#save-appearance").focus(); await page.keyboard.press("Enter"); await idle();
    quick = await viewer.operation("scope");
    assert.equal(quick.appearance.viewer, "custom");
    assert.equal(quick.appearance.customViewer.name, "Quick view studio");
    assert.equal(quick.appearance.chart, "custom");
    assert.equal(quick.appearance.customChart.colors[0], "#245c88");
    assert.equal(quick.preview, true); assert.equal(quick.contactEnabled, false);
    assert.equal((await viewer.operation("config")).surveys.length, 0);
    await page.locator("#refresh").click(); await idle();
    assert.deepEqual((await viewer.operation("scope")).appearance, quick.appearance);
    await openAppearance();
    await page.locator('[data-viewer-theme="studio"]').click();
    await page.locator('[data-chart-theme="coast"]').click();
    await page.locator("#save-appearance").focus(); await page.keyboard.press("Tab");
    assert.equal(await page.locator("#save-appearance-profile").evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Enter"); await idle();
    assert.equal(await page.locator("#appearance-dialog").isVisible(), false);
    assert.equal(await page.locator("#mapping").isVisible(), true);
    assert.equal((await viewer.operation("config")).surveys.length, 0);
    await page.locator("#profile-title").fill("Pending review title");
    await openAppearance();
    await page.locator('[data-chart-theme="accessible"]').click();
    await saveAppearance();
    assert.equal((await viewer.operation("scope")).appearance.chart, "accessible");
    assert.equal(await page.locator("#profile-title").inputValue(), "Pending review title");
    await page.locator("#confirm-mappings").check();
    await page.getByRole("button", { name: "Save profile and open report", exact: true }).click(); await idle();
    const id = (await viewer.operation("scope")).surveyId;
    await viewer.close();
    viewer = await startViewer({ surveyId: id }, { storage });
    await page.goto(viewer.url); await idle();
    assert.equal((await viewer.operation("scope")).appearance.viewer, "studio");
    assert.equal((await viewer.operation("scope")).appearance.chart, "accessible",
        "Confirming a pending mapping must retain the latest applied appearance.");
    assert.equal(JSON.parse(await readFile(join(storage, `${id}.json`), "utf8")).profile.title, "Pending review title");
    assert.equal((await viewer.operation("scope")).appearance.customViewer.name, "Quick view studio");
    assert.equal((await viewer.operation("scope")).appearance.customChart.name, "Quick view coast");
    await openAppearance();
    assert.equal(await page.locator("#save-appearance").isEnabled(), true);
    assert.equal(await page.locator("#save-appearance").innerText(), "Save appearance");
    assert.equal(await page.locator("#save-appearance").getAttribute("aria-describedby"), "");
    assert.equal(await page.locator("#save-appearance-profile").isVisible(), false);
    await page.locator("#save-appearance").focus(); await page.keyboard.press("Space"); await idle();
    assert.equal(await page.locator("#appearance-dialog").isVisible(), false);
    console.log("Quick-view appearance regression passed: pointer and keyboard apply, contrast rejection/recovery, no profile write or contact unlock, refresh, explicit profile save, and fresh-process reopen.");
    const initial = await colors();
    await openAppearance();
    await page.locator('[data-viewer-theme="midnight"]').click();
    await saveAppearance();
    const midnight = await colors();
    assert.notEqual(midnight.paper, initial.paper);
    assert.deepEqual(midnight.bars, initial.bars);
    assert.deepEqual(midnight.nps, initial.nps);
    await openAppearance();
    await page.locator('[data-chart-theme="orchid"]').click();
    await saveAppearance();
    const orchid = await colors();
    assert.equal(orchid.paper, midnight.paper);
    assert.notDeepEqual(orchid.bars, midnight.bars);
    assert.notDeepEqual(orchid.nps, midnight.nps);
    await evidence("midnight-overview.png");
    await viewer.close();
    viewer = await startViewer({ surveyId: id }, { storage });
    await page.goto(viewer.url); await idle();
    assert.deepEqual(await colors(), orchid);
    console.log("Theme browser slice passed: independent viewer/chart choices, saved profile, and fresh-process reopen.");
    const controls = await page.locator(".overview-card").evaluateAll(cards => cards.map(card => {
        const bounds = card.getBoundingClientRect(), tools = card.querySelector(".compact-actions");
        const area = tools.getBoundingClientRect(), previous = tools.previousElementSibling.getBoundingClientRect();
        return { buttons: [...tools.querySelectorAll("button")].map(button => ({
            label: button.getAttribute("aria-label"), title: button.title, text: button.textContent.trim(),
            width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height,
        })), right: bounds.right - area.right, bottom: bounds.bottom - area.bottom, clear: previous.bottom <= area.top };
    }));
    assert.ok(controls.length >= 2);
    for (const card of controls) {
        assert.ok(card.right >= 9 && card.right <= 12 && card.bottom >= 9 && card.bottom <= 12);
        assert.ok(card.clear, "Controls must not overlap chart data or score footnotes.");
        for (const button of card.buttons) {
            assert.ok(button.label && button.title);
            assert.equal(button.text, "");
            assert.equal(button.width, 28); assert.equal(button.height, 28);
        }
    }
    await page.locator(".compact-actions button").first().focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(".compact-actions button").nth(1).evaluate(button =>
        button === document.activeElement && button.matches(":focus-visible")
        && getComputedStyle(button).outlineWidth === "3px"), true);
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#graphic-dialog").isVisible(), true);
    await page.locator("#cancel-graphic").click();
    await page.locator('[data-edit-question="c3"]').click();
    await page.locator("#presentation-chart").selectOption("donut");
    await page.locator("#save-presentation").click(); await idle();
    await openAppearance();
    await page.locator('[data-viewer-theme="seaglass"]').click();
    await page.locator('[data-chart-theme="woodland"]').click();
    await page.locator("#cancel-appearance").click();
    assert.equal((await viewer.operation("scope")).appearance.viewer, "midnight");
    assert.equal((await viewer.operation("scope")).appearance.chart, "orchid");
    await openAppearance();
    await evidence("appearance-presets.png");
    await page.getByText("Create a custom viewer theme", { exact: true }).click();
    await page.getByText("Create a custom chart palette", { exact: true }).click();
    await page.locator("#custom-viewer-name").fill("Presentation studio");
    await page.locator("#custom-chart-name").fill("Ocean and plum");
    for (const [key, color] of Object.entries({
        paper: "#f8faff", ink: "#182940", muted: "#52637a", accent: "#285abb", line: "#cfd9eb",
    })) await colorInput(`[data-viewer-color="${key}"]`, color);
    await colorInput('[data-chart-color="0"]', "#245c88");
    await colorInput('[data-nps-color="0"]', "#9d424c");
    await evidence("custom-theme-editor.png");
    await saveAppearance();
    const custom = (await viewer.operation("scope")).appearance;
    assert.equal(custom.viewer, "custom"); assert.equal(custom.chart, "custom");
    assert.equal(custom.customViewer.name, "Presentation studio");
    assert.equal(custom.customChart.colors[0], "#245c88");
    assert.equal(custom.customChart.nps[0], "#9d424c");
    await writeFile(source, csv(55));
    await page.locator("#refresh").click(); await idle();
    assert.equal((await viewer.operation("scope")).scope.selected, 55);
    assert.deepEqual((await viewer.operation("scope")).appearance, custom);
    await viewer.close();
    viewer = await startViewer({ surveyId: id }, { storage });
    await page.goto(viewer.url); await idle();
    assert.deepEqual((await viewer.operation("scope")).appearance, custom);
    await evidence("custom-theme-overview.png");
    await openAppearance();
    assert.equal(await page.locator("#custom-viewer-name").inputValue(), "Presentation studio");
    assert.equal(await page.locator('[data-chart-color="0"]').inputValue(), "#245c88");
    await page.locator("#cancel-appearance").click();
    const graphic = async format => {
        await page.locator('[data-export-question="c3"]').click();
        const pending = page.waitForEvent("download");
        await page.locator(`#export-${format}`).click();
        const download = await pending, path = join(root, `themed.${format}`);
        await download.saveAs(path); await idle();
        const bytes = await readFile(path);
        if (process.env.CUSTOMER_VOICE_EVIDENCE) await writeFile(join(process.env.CUSTOMER_VOICE_EVIDENCE, `themed-question.${format}`), bytes);
        return bytes;
    };
    const svg = await graphic("svg");
    assert.match(svg.toString(), /#245c88/);
    assert.match(svg.toString(), /55 selected responses/);
    const png = await graphic("png");
    assert.equal(png.readUInt32BE(16), 2000);
    const matchingPixels = await page.evaluate(async uri => {
        const image = new Image(); image.src = uri; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let matches = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] === 36 && pixels[i + 1] === 92 && pixels[i + 2] === 136 && pixels[i + 3] === 255) matches++;
        }
        return matches;
    }, `data:image/png;base64,${png.toString("base64")}`);
    assert.ok(matchingPixels > 10000, "PNG must contain the selected custom chart color.");
    await page.locator(".report-settings summary").click();
    const pending = page.waitForEvent("download");
    await page.locator("#export-settings").click();
    const download = await pending, settingsPath = join(root, "themes.json");
    await download.saveAs(settingsPath); await idle();
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(settings.appearance, custom);
    assert.doesNotMatch(JSON.stringify(settings), /Private response|survey.csv|sha256|rows|token/);
    if (process.env.CUSTOMER_VOICE_EVIDENCE) await writeFile(join(process.env.CUSTOMER_VOICE_EVIDENCE, "shared-theme-settings.json"), JSON.stringify(settings, null, 2));
    const old = viewer, otherSource = join(root, "other.csv");
    await writeFile(otherSource, csv(70));
    viewer = await startViewer({}, { storage: join(root, "other-profiles") });
    const proposal = await viewer.operation("inspect", { path: otherSource });
    const other = await viewer.operation("confirm", { ticket: proposal.ticket, profile: proposal.profile });
    await old.close();
    await page.goto(viewer.url); await idle();
    await page.locator(`[data-survey="${other.surveyId}"]`).click(); await idle();
    await page.locator("#settings-file").setInputFiles(settingsPath); await idle();
    await page.locator("#apply-settings").click(); await idle();
    assert.deepEqual((await viewer.operation("scope")).appearance, custom);
    assert.equal((await viewer.operation("scope")).scope.selected, 70);
    await page.reload(); await idle();
    await page.locator(`[data-survey="${other.surveyId}"]`).click(); await idle();
    assert.deepEqual((await viewer.operation("scope")).appearance, custom);
    const { appearance: omitted, ...legacy } = settings;
    const legacyPath = join(root, "legacy.json");
    await writeFile(legacyPath, JSON.stringify({ ...legacy, version: 1 }));
    await page.locator("#settings-file").setInputFiles(legacyPath); await idle();
    await page.locator("#apply-settings").click(); await idle();
    assert.deepEqual((await viewer.operation("scope")).appearance, custom);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await openAppearance();
    assert.equal(await page.locator("#appearance-dialog").evaluate(dialog => dialog.scrollWidth > dialog.clientWidth), false);
    await evidence("mobile-theme-picker.png");
    await page.locator("#cancel-appearance").click();
    await page.setViewportSize({ width: 320, height: 844 });
    await openAppearance();
    await page.getByText("Create a custom viewer theme", { exact: true }).click();
    await page.locator("#custom-viewer-name").fill("A".repeat(60));
    assert.equal(await page.locator("#appearance-dialog").evaluate(dialog => dialog.scrollWidth > dialog.clientWidth), false);
    await page.locator("#cancel-appearance").click();
    await page.setViewportSize({ width: 1280, height: 1000 });
    await openAppearance();
    await colorInput('[data-viewer-color="ink"]', "#f8faff");
    await page.locator("#save-appearance").click();
    assert.equal(await page.locator("#appearance-dialog").isVisible(), true);
    assert.match(await page.locator("#appearance-error").innerText(), /contrast/);
    assert.deepEqual((await viewer.operation("scope")).appearance, custom);
    await page.locator("#cancel-appearance").click();
    const solidSource = join(root, "solid-colors.csv");
    await writeFile(solidSource, "ID,Recommend this product,Scale one,Scale two,Single choice\n" +
        Array.from({ length: 66 }, (_, i) => `${i},${i % 11},Choice ${i % 6 + 1},Choice ${i % 6 + 1},Choice ${i % 6 + 1}`).join("\n"));
    const solidProposal = await viewer.operation("inspect", { path: solidSource });
    for (const field of solidProposal.profile.fields.filter(field => ["c3", "c4"].includes(field.id))) {
        field.kind = "ordered"; field.group = "Color comparison";
        field.choices = Array.from({ length: 6 }, (_, i) => `Choice ${i + 1}`);
    }
    const choiceField = solidProposal.profile.fields.find(field => field.id === "c5");
    choiceField.kind = "choice"; choiceField.group = "Choices";
    choiceField.choices = Array.from({ length: 6 }, (_, i) => `Choice ${i + 1}`);
    const solidReport = await viewer.operation("confirm", { ticket: solidProposal.ticket, profile: solidProposal.profile });
    await viewer.close();
    viewer = await startViewer({ surveyId: solidReport.surveyId }, { storage: join(root, "other-profiles") });
    await page.goto(viewer.url); await idle();
    const actualColor = (selector, property = "backgroundColor") => page.locator(selector).evaluateAll((nodes, prop) =>
        nodes.map(node => getComputedStyle(node)[prop]), property);
    const rgbColor = color => `rgb(${[1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16)).join(", ")})`;
    for (const paletteId of ["original", "coast", "orchid", "woodland", "accessible"]) {
        const palette = chartPalette({ ...validateAppearance(), chart: paletteId });
        await openAppearance();
        await page.locator(`[data-chart-theme="${paletteId}"]`).click();
        const preview = await actualColor("[data-preview-color]");
        const npsPreview = await actualColor("[data-preview-nps]");
        assert.deepEqual(preview, Array.from({ length: 6 }, (_, index) => rgbColor(chartColor(index, 6, palette))));
        assert.deepEqual(npsPreview, palette.nps.map(rgbColor));
        await saveAppearance();
        assert.deepEqual(await actualColor(".horizontal .chart-segment"), [...preview, ...preview, ...preview]);
        const nps = await actualColor(".hist-bar");
        assert.deepEqual(nps, Array.from({ length: 11 }, (_, score) => npsPreview[score <= 6 ? 0 : score <= 8 ? 1 : 2]));
        await page.getByRole("button", { name: "Color comparison", exact: true }).click();
        assert.deepEqual(await actualColor(".balance .chart-segment"), [...preview, ...preview, ...preview, ...preview]);
        assert.equal(await page.locator(".chart-segment,.swatch").evaluateAll(nodes =>
            nodes.some(node => getComputedStyle(node).backgroundImage !== "none")), false);
        await page.getByRole("button", { name: "Overview", exact: true }).click();
        for (const chart of ["default", "vertical"]) {
            await page.locator('[data-edit-question="c2"]').first().click();
            await page.locator("#presentation-chart").selectOption(chart);
            await page.locator("#save-presentation").click(); await idle();
            const scoreColors = Array.from({ length: 11 }, (_, index) => chart === "default"
                ? palette.nps[index <= 6 ? 0 : index <= 8 ? 1 : 2] : chartColor(index, 11, palette));
            if (chart !== "default") assert.deepEqual(await page.locator(".chart-mark").evaluateAll(nodes =>
                nodes.map(node => node.getAttribute("fill"))), scoreColors);
            await page.locator('[data-export-question="c2"]').first().click();
            const pending = page.waitForEvent("download");
            await page.locator("#export-svg").click();
            const path = join(root, `solid-nps-${paletteId}-${chart}.svg`);
            await (await pending).saveAs(path); await idle();
            const xml = await readFile(path, "utf8");
            assert.doesNotMatch(xml, /<pattern|fill="url\(/);
            const fills = await page.evaluate(xml => [...new DOMParser().parseFromString(xml, "image/svg+xml")
                .querySelectorAll(".chart-mark")].map(node => node.getAttribute("fill")), xml);
            assert.deepEqual(fills, chart === "default" ? [...palette.nps, ...scoreColors] : scoreColors);
        }
        await page.locator('[data-edit-question="c2"]').first().click();
        await page.locator("#presentation-chart").selectOption("default");
        await page.locator("#save-presentation").click(); await idle();
        for (const chart of ["default", "horizontal", "vertical", "dot", "pie", "donut", "stacked"]) {
            await page.locator('[data-edit-question="c3"]').click();
            await page.locator("#presentation-chart").selectOption(chart);
            await page.locator("#save-presentation").click(); await idle();
            assert.equal(await page.locator(".question-graphic pattern").count(), 0);
            assert.equal(await page.locator(".chart-segment,.swatch").evaluateAll(nodes =>
                nodes.some(node => getComputedStyle(node).backgroundImage !== "none")), false);
            if (chart !== "default") {
                const fills = await page.locator(".chart-mark").evaluateAll(nodes => nodes.map(node => node.getAttribute("fill")));
                assert.deepEqual(fills, Array.from({ length: 6 }, (_, index) => chartColor(index, 6, palette)));
            }
            await page.locator('[data-export-question="c3"]').click();
            const pending = page.waitForEvent("download");
            await page.locator("#export-svg").click();
            const download = await pending, path = join(root, `solid-${paletteId}-${chart}.svg`);
            await download.saveAs(path); await idle();
            const xml = await readFile(path, "utf8");
            assert.doesNotMatch(xml, /<pattern|fill="url\(/);
            const expectedFills = Array.from({ length: 6 }, (_, index) => chartColor(index, 6, palette));
            const fills = await page.evaluate(xml => [...new DOMParser().parseFromString(xml, "image/svg+xml")
                .querySelectorAll(".chart-mark")].map(node => node.getAttribute("fill")), xml);
            assert.deepEqual(fills, chart === "default" ? [...expectedFills, ...expectedFills] : expectedFills);
            if (paletteId === "coast" && ["pie", "donut", "stacked"].includes(chart)) {
                await page.locator('[data-export-question="c3"]').click();
                const pngPending = page.waitForEvent("download");
                await page.locator("#export-png").click();
                const pngDownload = await pngPending, pngPath = join(root, `solid-${chart}.png`);
                await pngDownload.saveAs(pngPath); await idle();
                const png = await readFile(pngPath);
                const pixel = await page.evaluate(async ({ uri, chart, xml }) => {
                    const image = new Image(); image.src = uri; await image.decode();
                    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
                    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
                    const mark = new DOMParser().parseFromString(xml, "image/svg+xml").querySelector(".chart-mark");
                    let x, y;
                    if (chart === "stacked") { x = +mark.getAttribute("x") + +mark.getAttribute("width") * .3; y = +mark.getAttribute("y") + 8; }
                    else {
                        const coordinates = mark.getAttribute("d").match(/^M210 ([\d.]+)/);
                        const cy = +coordinates[1], radius = chart === "donut" ? 115 : 70;
                        x = 210 + Math.cos(-Math.PI / 2 + Math.PI / 9) * radius;
                        y = cy + Math.sin(-Math.PI / 2 + Math.PI / 9) * radius;
                    }
                    return [...context.getImageData(Math.round(x * 2) - 3, Math.round(y * 2) - 3, 6, 6).data];
                }, { uri: `data:image/png;base64,${png.toString("base64")}`, chart, xml });
                const expected = [1, 3, 5].map(start => parseInt(palette.colors[0].slice(start, start + 2), 16));
                for (let index = 0; index < pixel.length; index += 4) assert.deepEqual(pixel.slice(index, index + 4), [...expected, 255]);
                if (process.env.CUSTOMER_VOICE_EVIDENCE) await writeFile(join(process.env.CUSTOMER_VOICE_EVIDENCE, `solid-${chart}.png`), png);
            }
        }
        await page.locator('[data-edit-question="c3"]').click();
        await page.locator("#presentation-chart").selectOption("default");
        await page.locator("#save-presentation").click(); await idle();
    }
    await evidence("solid-chart-colors.png");
    console.log("Solid-color check passed: five palettes, matching preview/category/NPS/matrix colors, seven chart types, 45 exact SVG exports including default/alternative NPS, and uniform PNG fills without overlays.");
    const excelSource = join(root, "synthetic-appearance.xlsx");
    const workbook = spawnSync(process.env.CUSTOMER_VOICE_TEST_PYTHON || process.env.CUSTOMER_VOICE_PYTHON || "python3",
        ["scripts/make-test-export.py", excelSource], { encoding: "utf8" });
    assert.equal(workbook.status, 0, workbook.error?.message || workbook.stderr);
    await page.locator("#open-export").click();
    await page.locator("#path").fill(excelSource);
    await page.locator("#reuse-profile").selectOption("");
    await page.getByRole("button", { name: "View report", exact: true }).click(); await idle();
    assert.equal((await viewer.operation("scope")).preview, true);
    await openAppearance();
    await page.locator('[data-chart-theme="orchid"]').click();
    assert.equal(await page.locator("#save-appearance").isEnabled(), true,
        "Loading Excel after a saved sample must not disable appearance.");
    assert.equal(await page.locator("#save-appearance").innerText(), "Apply appearance");
    await page.locator("#save-appearance").click(); await idle();
    const excelQuick = await viewer.operation("scope");
    assert.equal(excelQuick.appearance.chart, "orchid");
    assert.equal(excelQuick.preview, true);
    assert.equal(excelQuick.contactEnabled, false);
    await openAppearance();
    await page.locator('[data-chart-theme="coast"]').click();
    await evidence("sample-to-excel-appearance.png");
    await page.locator("#save-appearance-profile").click(); await idle();
    await page.locator("#confirm-mappings").check();
    await page.getByRole("button", { name: "Save profile and open report", exact: true }).click(); await idle();
    const excelSaved = await viewer.operation("scope");
    assert.equal(excelSaved.preview, false);
    assert.equal(excelSaved.appearance.chart, "coast");
    await viewer.close();
    viewer = await startViewer({ surveyId: excelSaved.surveyId }, { storage: join(root, "other-profiles") });
    await page.goto(viewer.url); await idle();
    assert.equal((await viewer.operation("scope")).appearance.chart, "coast");
    await openAppearance();
    assert.equal(await page.locator("#save-appearance").isEnabled(), true);
    assert.equal(await page.locator("#save-appearance").innerText(), "Save appearance");
    await page.locator("#cancel-appearance").click();
    assert.deepEqual(errors, []);
    console.log("Sample-to-Excel appearance regression passed: saved sample, Excel quick view, palette-only apply, explicit profile confirmation, and fresh-provider persistence.");
    console.log("Theme browser check passed: compact named icon controls, cancellation, custom colors, refresh/restart, colored SVG/PNG pixels, sharing into a second profile, legacy import, mobile layout, and contrast rejection.");
} finally {
    await browser.close(); await viewer.close();
    await rm(root, { recursive: true, force: true });
}
