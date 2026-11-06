import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { viewerThemes, chartThemes, contrast } from "../extensions/customer-voice/themes.mjs";
const { startViewer } = await import(process.env.CUSTOMER_VOICE_PLUGIN_ROOT
    ? pathToFileURL(resolve(process.env.CUSTOMER_VOICE_PLUGIN_ROOT, "extensions/customer-voice/server.mjs")).href
    : new URL("../extensions/customer-voice/server.mjs", import.meta.url).href);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const root = await mkdtemp(join(tmpdir(), "cv-accessibility-")), source = join(root, "survey.csv");
await writeFile(source, "ID,Recommend this product,Satisfaction\n" +
    Array.from({ length: 40 }, (_, i) => `${i},${i % 11},${["Poor", "Fair", "Good"][i % 3]}`).join("\n"));
const viewer = await startViewer({}, { storage: join(root, "profiles") });
const proposal = await viewer.operation("inspect", { path: source });
proposal.profile.fields[2].kind = "ordered";
const report = await viewer.operation("confirm", { ticket: proposal.ticket, profile: proposal.profile });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [], measurements = [];
page.on("pageerror", error => errors.push(error.message));
const idle = () => page.locator("#status:empty").waitFor({ state: "attached" });
const appearance = async (viewerId, chart) => {
    await page.locator("#open-appearance").click();
    await page.locator(`[data-viewer-theme="${viewerId}"]`).click();
    await page.locator(`[data-chart-theme="${chart}"]`).click();
    await page.locator("#save-appearance").click(); await idle();
};
const measure = async (selector, property = "color", backgroundSelector) => page.locator(selector).first().evaluate((node, args) => {
    const context = document.createElement("canvas").getContext("2d");
    const hex = color => {
        context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
        return "#" + [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(n => n.toString(16).padStart(2, "0")).join("");
    };
    let parent = args.backgroundSelector ? document.querySelector(args.backgroundSelector) : node;
    while (parent && getComputedStyle(parent).backgroundColor === "rgba(0, 0, 0, 0)") parent = parent.parentElement;
    return { foreground: hex(getComputedStyle(node)[args.property]), background: hex(getComputedStyle(parent || document.body).backgroundColor) };
}, { property, backgroundSelector });
const check = async (label, selector, threshold = 4.5, property = "color", backgroundSelector) => {
    const values = await measure(selector, property, backgroundSelector), ratio = contrast(values.foreground, values.background);
    measurements.push({ label, ...values, ratio, threshold });
    assert.ok(ratio >= threshold, `${label}: ${ratio}, expected ${threshold}`);
};
const screenshot = async name => {
    if (!process.env.CUSTOMER_VOICE_EVIDENCE) return;
    await mkdir(process.env.CUSTOMER_VOICE_EVIDENCE, { recursive: true });
    await page.screenshot({ path: join(process.env.CUSTOMER_VOICE_EVIDENCE, name) });
};
try {
    await page.goto(viewer.url); await idle();
    await page.locator(`[data-survey="${report.surveyId}"]`).click(); await idle();
    const schemes = viewerThemes.flatMap(t => t.id === "system"
        ? [{ id: t.id, scheme: "light" }, { id: t.id, scheme: "dark" }] : [{ id: t.id, scheme: "light" }]);
    for (const theme of schemes) for (const palette of chartThemes) {
        await page.emulateMedia({ colorScheme: theme.scheme });
        await appearance(theme.id, palette.id);
        const prefix = `${theme.id}/${theme.scheme}/${palette.id}`;
        await check(`${prefix}/text`, "body");
        await check(`${prefix}/muted`, "#content > .muted");
        await check(`${prefix}/metric`, ".metric-value");
        await check(`${prefix}/metric-muted`, ".metric .fine");
        await check(`${prefix}/icon`, ".compact-actions button");
        await page.locator(".compact-actions button").first().hover();
        await check(`${prefix}/icon-hover`, ".compact-actions button");
        await page.locator(".compact-actions button").first().focus(); await page.keyboard.press("Tab");
        await check(`${prefix}/icon-focus`, ".compact-actions button:focus-visible", 3, "outlineColor", ".metric.overview-card");
        await check(`${prefix}/chart-boundary`, ".hist-bar", 3, "borderTopColor", "body");
        await check(`${prefix}/primary`, "#refresh");
        await page.locator("#refresh").hover();
        await check(`${prefix}/primary-hover`, "#refresh");
        await page.locator("#open-appearance").click();
        await check(`${prefix}/dialog`, "#appearance-dialog");
        await check(`${prefix}/theme-text`, ".theme-choice");
        await check(`${prefix}/theme-boundary`, ".theme-choice", 3, "borderTopColor");
        await check(`${prefix}/selected`, '.theme-choice[aria-pressed="true"]', 3, "borderTopColor");
        await page.locator(".theme-choice").first().hover();
        await check(`${prefix}/theme-hover`, ".theme-choice");
        await check(`${prefix}/preview-text`, "#theme-preview");
        await check(`${prefix}/preview-muted`, "#theme-preview span");
        await page.getByText("Create a custom viewer theme", { exact: true }).click();
        await check(`${prefix}/input`, "#custom-viewer-name");
        await check(`${prefix}/input-boundary`, "#custom-viewer-name", 3, "borderTopColor");
        await page.locator("#custom-viewer-name").focus(); await page.keyboard.press("Tab");
        await check(`${prefix}/focus`, "input:focus-visible", 3, "outlineColor", "#appearance-dialog");
        await page.getByText("Create a custom viewer theme", { exact: true }).click();
        await page.locator("#cancel-appearance").click();
        const segment = page.locator(".hist-bar").first();
        await segment.focus();
        await check(`${prefix}/tooltip`, "#chart-tooltip");
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#chart-tooltip").isVisible(), false);
    }
    await appearance("high-contrast", "accessible");
    await page.locator('[data-edit-question="c3"]').click();
    await page.locator("#presentation-chart").selectOption("donut");
    await page.locator("#save-presentation").click(); await idle();
    assert.ok(await page.locator(".question-graphic pattern").count() >= 3);
    const data = page.locator(".chart-data").last();
    await data.locator("summary").press("Enter");
    assert.equal(await data.locator("tbody tr").count(), 3);
    assert.match(await data.ariaSnapshot(), /Poor.*|rowheader "Poor"/);
    assert.match(await page.locator(".graphic-scroll").ariaSnapshot(), /img "Poor: 35% \/ 14 of 40 valid answers"/);
    await screenshot("high-contrast-data.png");
    const session = await page.context().newCDPSession(page);
    for (const type of ["protanopia", "deuteranopia", "tritanopia", "achromatopsia"]) {
        await session.send("Emulation.setEmulatedVisionDeficiency", { type });
        assert.equal(await data.locator("tbody tr").count(), 3);
        await screenshot(`${type}.png`);
    }
    await session.send("Emulation.setEmulatedVisionDeficiency", { type: "none" });
    const savedAppearance = (await viewer.operation("scope")).appearance;
    await viewer.operation("appearance", { surveyId: report.surveyId, appearance: {
        ...savedAppearance, viewer: "custom", customViewer: { name: "Midtone test",
            colors: { paper: "#8f9992", ink: "#000000", muted: "#000000", accent: "#000000", line: "#666666" } },
    } });
    await page.reload(); await idle();
    await page.locator(`[data-survey="${report.surveyId}"]`).click(); await idle();
    await page.locator('[data-edit-question="c3"]').click();
    await page.locator("#presentation-chart").selectOption("vertical");
    await page.locator("#save-presentation").click(); await idle();
    await check("custom-midtone/axis", ".chart-axis", 3, "stroke", "body");
    await viewer.operation("appearance", { surveyId: report.surveyId, appearance: savedAppearance });
    await page.reload(); await idle();
    await page.locator(`[data-survey="${report.surveyId}"]`).click(); await idle();
    const segment = page.locator(".hist-bar").first(), tooltip = page.locator("#chart-tooltip");
    await segment.hover(); await tooltip.hover();
    assert.equal(await tooltip.isVisible(), true);
    await page.keyboard.press("Escape");
    assert.equal(await tooltip.isVisible(), false);
    await page.locator("#open-appearance").click();
    await screenshot("accessible-themes.png");
    await page.getByText("Create a custom chart palette", { exact: true }).click();
    await page.locator("#hex-chart-0").fill("#ffffff");
    assert.equal(await page.locator('[data-chart-theme="custom"]').getAttribute("aria-pressed"), "true");
    await page.locator("#save-appearance").click();
    assert.match(await page.locator("#appearance-error").innerText(), /3:1/);
    assert.equal(await page.locator("#appearance-error").evaluate(node => node === document.activeElement), true);
    await screenshot("custom-color-validation.png");
    await page.locator("#repair-colors").click();
    await page.locator("#cancel-appearance").click();
    assert.equal((await viewer.operation("scope")).appearance.chart, "accessible", "Repair and Cancel must not save a draft.");
    await page.locator("#open-appearance").click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#open-appearance").evaluate(node => node === document.activeElement), true);
    await page.emulateMedia({ forcedColors: "active" });
    await page.waitForFunction(() => document.querySelectorAll(".chart-data:not([open])").length === 0);
    assert.equal(await page.locator(".chart-data:not([open])").count(), 0);
    await screenshot("forced-colors.png");
    await page.setViewportSize({ width: 320, height: 256 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator("#open-appearance").click();
    for (let i = 0; i < 70; i++) {
        await page.keyboard.press("Tab");
        const focus = await page.evaluate(() => {
            const node = document.activeElement, box = node.getBoundingClientRect();
            return { tag: node.tagName, id: node.id, inside: Boolean(node.closest("#appearance-dialog")),
                top: box.top, bottom: box.bottom, height: innerHeight, documentFocused: document.hasFocus() };
        });
        // Native dialog tab order can visit browser chrome, but not another page control.
        if (focus.tag === "BODY" && !focus.documentFocused) continue;
        assert.ok(focus.inside && focus.bottom > 0 && focus.top < focus.height, JSON.stringify(focus));
    }
    assert.equal(await page.locator("#appearance-dialog").evaluate(node => node.scrollWidth > node.clientWidth), false);
    await screenshot("reflow-400-percent-equivalent.png");
    assert.deepEqual(errors, []);
    if (process.env.CUSTOMER_VOICE_EVIDENCE) await writeFile(join(process.env.CUSTOMER_VOICE_EVIDENCE, "contrast-measurements.json"), JSON.stringify({
        combinations: schemes.length * chartThemes.length, measurements,
        limits: "Automated Chromium checks and vision-deficiency simulations. Not a formal conformance review or a human screen-reader test.",
    }, null, 2));
    console.log(`Accessibility browser check passed: ${schemes.length * chartThemes.length} theme/palette combinations, ${measurements.length} state contrast measurements, patterns/data access, tooltip hover/Escape, custom rejection/repair cancellation, dialog focus, forced colors, and 320 CSS-pixel reflow.`);
} finally {
    await browser.close(); await viewer.close(); await rm(root, { recursive: true, force: true });
}
