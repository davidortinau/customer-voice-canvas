import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
    if (name === "appearance-presets.png") await page.locator("#appearance-dialog").screenshot({ path });
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
    await page.getByRole("button", { name: "Inspect export", exact: true }).click(); await idle();
    await page.locator("#confirm-mappings").check();
    await page.getByRole("button", { name: "Save profile and open report", exact: true }).click(); await idle();
    const id = (await viewer.operation("scope")).surveyId;
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
    assert.deepEqual(errors, []);
    console.log("Theme browser check passed: compact named icon controls, cancellation, custom colors, refresh/restart, colored SVG/PNG pixels, sharing into a second profile, legacy import, mobile layout, and contrast rejection.");
} finally {
    await browser.close(); await viewer.close();
    await rm(root, { recursive: true, force: true });
}
