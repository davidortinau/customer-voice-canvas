import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { startViewer } = await import(process.env.CUSTOMER_VOICE_PLUGIN_ROOT
    ? pathToFileURL(resolve(process.env.CUSTOMER_VOICE_PLUGIN_ROOT, "extensions/customer-voice/server.mjs")).href
    : new URL("../extensions/customer-voice/server.mjs", import.meta.url).href);

const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const root = await mkdtemp(join(tmpdir(), "cv-input-browser-"));
const source = process.argv[2] || join(root, "valid.csv");
if (!process.argv[2]) {
    await writeFile(source, "ID,Recommendation,Comment\n1,9,good \u{1f600}\n2,8,caf\u00e9 \u65e5\u672c\u8a9e\n");
}
const viewer = await startViewer({}, { storage: join(root, "profiles") });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const idle = () => page.locator("#status:empty").waitFor({ state: "attached", timeout: 90000 });
try {
    await page.goto(viewer.url);
    await idle();
    if (!await page.locator("#setup").isVisible()) {
        await page.locator("#open-export").click();
    }
    await page.locator("#path").fill(source);
    await page.getByRole("button", { name: "View report", exact: true }).click();
    await page.locator("#dashboard:not([hidden])").waitFor({ timeout: 90000 });
    await idle();
    const original = await viewer.operation("scope");
    if (process.argv[2]) {
        assert.equal(original.source.rows, 875);
        assert.equal(original.source.columns, 164);
    }
    const tabs = await page.locator("[data-tab]").evaluateAll(nodes => nodes.map(node => node.dataset.tab));
    for (const tab of tabs) {
        await page.locator(`[data-tab="${tab}"]`).click();
        await idle();
    }
    await page.locator('[data-tab="questions"]').click();
    await idle();
    const questions = await page.locator("[data-question]").evaluateAll(nodes => nodes.map(node => node.dataset.question));
    for (const question of questions) {
        await page.locator(`[data-question="${question}"]`).click();
        await idle();
        assert.equal(await page.locator("#error").isVisible(), false);
    }
    if (!process.argv[2]) {
        assert.match(await page.locator("#question-detail").innerText(), /good \u{1f600}/u);
        assert.match(await page.locator("#question-detail").innerText(), /caf\u00e9 \u65e5\u672c\u8a9e/);
    }
    const invalid = [
        ["broken.xlsx", "not an Excel file", /damaged/],
        ["empty.csv", "", /header row/],
        ["blank.csv", ",\n1,2\n", /No source columns/],
        ["header-only.csv", "ID,Question\n", /no response rows/],
        ["quotes.csv", 'ID,Question\n1,"unfinished', /invalid quoting/],
        ["encoding.csv", Buffer.from([0xff, 0xfe]), /not UTF-8/],
        ["unsupported.txt", "data", /CSV or XLSX/],
        ["wide.csv", Array.from({ length: 2049 }, () => "Column").join(","), /column limit/],
    ];
    for (const [filename, content, expected] of invalid) {
        const path = join(root, filename);
        await writeFile(path, content);
        if (!await page.locator("#setup").isVisible()) {
            await page.locator("#open-export").click();
        }
        await page.locator("#path").fill(path);
        await page.getByRole("button", { name: "View report", exact: true }).click();
        await page.locator("#error:not([hidden])").waitFor();
        assert.match(await page.locator("#error").innerText(), expected);
        assert.equal((await viewer.operation("scope")).source.sha256, original.source.sha256);
    }
    await mkdir(join(root, "folder.csv"));
    await assert.rejects(viewer.operation("inspect", { path: join(root, "folder.csv") }), /folder/);
    await assert.rejects(viewer.operation("inspect", { path: source, header: 0 }), /Header row/);
    if (source.endsWith(".xlsx")) {
        await assert.rejects(viewer.operation("inspect", { path: source, sheet: -1 }), /sheet/);
    }
    await page.getByRole("button", { name: "Open an export", exact: true }).click();
    await page.locator("#path").fill(source);
    await page.getByRole("button", { name: "View report", exact: true }).click();
    await idle();
    assert.equal((await viewer.operation("scope")).source.sha256, original.source.sha256);
    assert.deepEqual(errors, []);
    console.log(`Input browser check passed: ${original.source.rows} rows, ${original.source.columns} columns; ${tabs.length} tabs and ${questions.length} question views; eight rejected imports, folder/header/sheet checks, last-report retention, recovery, no page errors.`);
} finally {
    await browser.close();
    await viewer.close();
    await rm(root, { recursive: true, force: true });
}
