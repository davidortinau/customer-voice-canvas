import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { startViewer } = await import(process.env.CUSTOMER_VOICE_PLUGIN_ROOT
    ? pathToFileURL(resolve(process.env.CUSTOMER_VOICE_PLUGIN_ROOT, "extensions/customer-voice/server.mjs")).href
    : new URL("../extensions/customer-voice/server.mjs", import.meta.url).href);

const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const root = await mkdtemp(join(tmpdir(), "cv-presentation-"));
const source = join(root, "report.csv"), storage = join(root, "profiles");
const csv = count => "ID,Recommend this product,Satisfaction,Tools,Written answer\n" +
    Array.from({ length: count }, (_, i) =>
        `${i},${i % 11},${["Poor", "Fair", "Good"][i % 3]},${i % 2 ? "A;B" : "A"},Private response ${i}`).join("\n");
await writeFile(source, csv(40));
let viewer = await startViewer({ source }, { storage });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const idle = () => page.locator("#status:empty").waitFor({ state: "attached" });
try {
    await page.goto(viewer.url); await idle();
    await page.getByRole("button", { name: "Inspect export", exact: true }).click(); await idle();
    for (const [id, kind] of [["c3", "ordered"], ["c4", "multiple"], ["c5", "text"]]) {
        await page.locator(`[data-field="${id}"] summary`).click();
        await page.locator(`[data-field="${id}"] [data-key="kind"]`).selectOption(kind);
    }
    await page.locator('[data-field="c4"] [data-key="choices"]').fill("A\nB");
    await page.locator('[data-field="c3"] [data-key="group"]').fill("Experience");
    await page.locator('[data-field="c5"] [data-key="group"]').fill("Written answers");
    await page.locator("#confirm-mappings").check();
    await page.getByRole("button", { name: "Save profile and open report", exact: true }).click(); await idle();
    const id = (await viewer.operation("scope")).surveyId;
    await page.locator('[data-edit-question="c3"]').click();
    await page.locator("#presentation-chart").selectOption("donut");
    await page.getByRole("button", { name: "Save presentation", exact: true }).click(); await idle();
    assert.equal((await viewer.operation("scope")).presentations.c3.chart, "donut");
    assert.match(await page.locator("#content").innerHTML(), /<circle cx="210"/);
    await writeFile(source, csv(55));
    await page.getByRole("button", { name: "Refresh data", exact: true }).click(); await idle();
    assert.equal((await viewer.operation("scope")).scope.selected, 55);
    assert.equal((await viewer.operation("scope")).presentations.c3.chart, "donut");
    await viewer.close();
    viewer = await startViewer({ surveyId: id }, { storage });
    await page.goto(viewer.url); await idle();
    assert.equal((await viewer.operation("scope")).presentations.c3.chart, "donut");
    const saved = await readFile(join(storage, `${id}.json`), "utf8");
    assert.doesNotMatch(saved, /Private response/);
    assert.equal(JSON.parse(saved).profile.presentations.c3.chart, "donut");
    const graphic = async (format, question = "c3") => {
        await page.locator(`[data-export-question="${question}"]`).first().click();
        const pending = page.waitForEvent("download");
        await page.locator(`#export-${format}`).click();
        const download = await pending;
        const path = join(root, `question-${question}.${format}`);
        await download.saveAs(path); await idle();
        return { path, bytes: await readFile(path) };
    };
    const svg = await graphic("svg");
    assert.match(svg.bytes.toString(), /Satisfaction/);
    assert.match(svg.bytes.toString(), /55 selected responses/);
    assert.match(svg.bytes.toString(), /Denominator: 55/);
    assert.doesNotMatch(svg.bytes.toString(), /Private response/);
    const parsed = await page.evaluate(svg => {
        const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
        return { error: Boolean(doc.querySelector("parsererror")), width: doc.documentElement.getAttribute("width") };
    }, svg.bytes.toString());
    assert.deepEqual(parsed, { error: false, width: "1000" });
    const png = await graphic("png");
    assert.deepEqual([...png.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.bytes.readUInt32BE(16), 2000);
    const imageCheck = await page.evaluate(async uri => {
        const image = new Image(); image.src = uri; await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let colored = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i + 3] && pixels[i] < 230 && pixels[i + 1] < 230) colored++;
        }
        return { width: image.width, colored };
    }, `data:image/png;base64,${png.bytes.toString("base64")}`);
    assert.equal(imageCheck.width, 2000);
    assert.ok(imageCheck.colored > 10000, "PNG must contain chart marks and text, not an empty canvas.");
    const defaultNps = await graphic("svg", "c2");
    assert.match(defaultNps.bytes.toString(), /Detractors \(0-6\)|Detractors/);
    assert.match(defaultNps.bytes.toString(), /Recommendation scores: 0 to 10/);
    await page.locator(".filters summary").click();
    await page.locator('[data-filter="c4"]').selectOption("B"); await idle();
    const cohortGraphic = await graphic("svg");
    assert.match(cohortGraphic.bytes.toString(), /27 selected responses/);
    assert.match(cohortGraphic.bytes.toString(), /Tools: B/);
    await page.locator("#reset").click(); await idle();
    await page.locator(".report-settings summary").click();
    const settingsDownload = page.waitForEvent("download");
    await page.locator("#export-settings").click();
    const downloadedSettings = await settingsDownload;
    const settingsPath = join(root, "presentation.json");
    await downloadedSettings.saveAs(settingsPath); await idle();
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(Object.keys(settings).sort(), ["format", "questions", "version"]);
    assert.doesNotMatch(JSON.stringify(settings), /Private response|report.csv|sha256|rows|key|token/);
    await page.getByRole("button", { name: "All questions", exact: true }).click(); await idle();
    await page.locator('[data-question="c3"]').click(); await idle();
    for (const chart of ["horizontal", "vertical", "dot", "stacked", "pie", "donut", "table"]) {
        await page.locator('[data-edit-question="c3"]').click();
        await page.locator("#presentation-chart").selectOption(chart);
        await page.locator("#save-presentation").click(); await idle();
        assert.equal((await viewer.operation("scope")).presentations.c3.chart, chart);
        assert.match(await page.locator("#question-detail").innerHTML(), /Denominator: 55/);
    }
    await page.locator('[data-question="c4"]').click(); await idle();
    await page.locator('[data-edit-question="c4"]').click();
    const multipleOptions = await page.locator("#presentation-chart option").evaluateAll(items => items.map(item => item.value));
    assert.ok(!multipleOptions.includes("pie") && !multipleOptions.includes("stacked"));
    await page.locator("#cancel-presentation").click();
    await page.locator('[data-question="c5"]').click(); await idle();
    const writtenGraphic = await graphic("svg", "c5");
    assert.doesNotMatch(writtenGraphic.bytes.toString(), /Private response/);
    assert.match(writtenGraphic.bytes.toString(), /counts only/);
    await page.locator('[data-edit-question="c5"]').click();
    await page.locator("#presentation-chart").selectOption("summary");
    await page.locator("#save-presentation").click(); await idle();
    assert.equal(await page.locator("#answer-list").count(), 0);
    assert.match(await page.locator("#question-detail").innerText(), /counts only/);
    await page.locator('[data-tab="group:Written answers"]').click(); await idle();
    assert.equal(await page.getByRole("button", { name: "Read all answers", exact: true }).count(), 0);
    assert.match(await page.locator("#content").innerText(), /counts only/);
    await page.getByRole("button", { name: "All questions", exact: true }).click(); await idle();
    await page.locator("#settings-file").setInputFiles(settingsPath); await idle();
    await page.locator("#cancel-settings").click();
    assert.equal((await viewer.operation("scope")).presentations.c3.chart, "table");
    await page.locator("#settings-file").setInputFiles(settingsPath); await idle();
    await page.locator("#apply-settings").click(); await idle();
    assert.equal((await viewer.operation("scope")).presentations.c3.chart, "donut");
    assert.equal(await page.locator("#answer-list").count(), 1);
    await writeFile(join(root, "invalid.json"), JSON.stringify({ ...settings, rows: [["private"]] }));
    await page.locator("#settings-file").setInputFiles(join(root, "invalid.json"));
    await page.locator("#error:not([hidden])").waitFor();
    assert.equal((await viewer.operation("scope")).presentations.c3.chart, "donut");
    const oldViewer = viewer;
    const otherSource = join(root, "other.csv");
    await writeFile(otherSource, csv(70));
    viewer = await startViewer({}, { storage: join(root, "other-profiles") });
    const proposal = await viewer.operation("inspect", { path: otherSource });
    const otherProfile = JSON.parse(saved).profile;
    otherProfile.presentations = {};
    const otherReport = await viewer.operation("confirm", { ticket: proposal.ticket, profile: otherProfile });
    assert.notEqual(otherReport.surveyId, id);
    await oldViewer.close();
    await page.goto(viewer.url); await idle();
    await page.locator(`[data-survey="${otherReport.surveyId}"]`).click(); await idle();
    await page.locator("#settings-file").setInputFiles(settingsPath); await idle();
    await page.locator("#apply-settings").click(); await idle();
    assert.equal((await viewer.operation("scope")).scope.selected, 70);
    assert.equal((await viewer.operation("scope")).presentations.c3.chart, "donut");
    await page.reload(); await idle();
    await page.locator(`[data-survey="${otherReport.surveyId}"]`).click(); await idle();
    assert.equal((await viewer.operation("scope")).presentations.c3.chart, "donut");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.getByRole("button", { name: "All questions", exact: true }).click(); await idle();
    await page.locator('[data-question="c3"]').click(); await idle();
    const labelCheck = await page.evaluate(async () => {
        const { questionGraphic } = await import("/presentation.mjs");
        const svg = questionGraphic({ label: "W".repeat(160) + " \u{1f600}".repeat(50),
            kind: "choice", answered: 1, blank: 0, valid: 1, excluded: 0,
            distribution: [{ label: "W".repeat(200), count: 1, percent: 100 }] }, "donut");
        const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
        if (doc.querySelector("parsererror")) return { parseError: true };
        const node = document.importNode(doc.documentElement, true);
        document.body.append(node);
        const clipped = [...node.querySelectorAll("text")].some(text => {
            const box = text.getBBox();
            return box.x < 0 || box.x + box.width > 1000;
        });
        node.remove();
        return { parseError: false, clipped };
    });
    assert.deepEqual(labelCheck, { parseError: false, clipped: false });
    if (process.env.CUSTOMER_VOICE_EVIDENCE) {
        await mkdir(process.env.CUSTOMER_VOICE_EVIDENCE, { recursive: true });
        await page.screenshot({ path: join(process.env.CUSTOMER_VOICE_EVIDENCE, "saved-presentation.png"), fullPage: true });
        await writeFile(join(process.env.CUSTOMER_VOICE_EVIDENCE, "question-graphic.svg"), svg.bytes);
        await writeFile(join(process.env.CUSTOMER_VOICE_EVIDENCE, "question-graphic.png"), png.bytes);
        await writeFile(join(process.env.CUSTOMER_VOICE_EVIDENCE, "report-presentation.json"), JSON.stringify(settings, null, 2));
        await page.locator('[data-edit-question="c3"]').click();
        await page.screenshot({ path: join(process.env.CUSTOMER_VOICE_EVIDENCE, "chart-options.png") });
        await page.locator("#cancel-presentation").click();
        await page.emulateMedia({ colorScheme: "dark" });
        await page.screenshot({ path: join(process.env.CUSTOMER_VOICE_EVIDENCE, "dark-presentation.png"), fullPage: true });
    }
    await page.getByRole("button", { name: "Review profile", exact: true }).click(); await idle();
    await page.locator('[data-field="c3"] summary').click();
    await page.locator('[data-field="c3"] [data-key="kind"]').selectOption("multiple");
    await page.locator("#confirm-mappings").check();
    await page.getByRole("button", { name: "Save profile and open report", exact: true }).click(); await idle();
    assert.equal((await viewer.operation("scope")).questions.find(q => q.id === "c3").kind, "multiple");
    assert.equal((await viewer.operation("scope")).presentations.c3, undefined, "A kind change must reset an incompatible donut choice.");
    const dateSource = join(root, "dates.csv");
    await writeFile(dateSource, "ID,Event date\n" + Array.from({ length: 400 }, (_, index) =>
        `${index},${new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10)}`).join("\n"));
    const dateProposal = await viewer.operation("inspect", { path: dateSource });
    dateProposal.profile.fields[1].kind = "date";
    dateProposal.profile.fields[1].choices = [];
    const dateReport = await viewer.operation("confirm", { ticket: dateProposal.ticket, profile: dateProposal.profile });
    await page.reload(); await idle();
    await page.locator(`[data-survey="${dateReport.surveyId}"]`).click(); await idle();
    await page.locator('[data-export-question="c2"]').click();
    await page.locator("#export-png").click();
    await page.locator("#error:not([hidden])").waitFor();
    assert.match(await page.locator("#error").innerText(), /too large for PNG/);
    const largeSvg = await graphic("svg", "c2");
    assert.match(largeSvg.bytes.toString(), /Denominator: 400/);
    assert.deepEqual(errors, []);
    console.log("Presentation browser check passed: all chart choices, edit/save, refresh and restart, SVG/PNG contents and size limit, text counts across views, settings export/import/cancel/rejection, second profile with 70 responses, narrow/dark views, long Unicode labels, and question-type changes.");
} finally {
    await browser.close();
    await viewer.close();
    await rm(root, { recursive: true, force: true });
}
