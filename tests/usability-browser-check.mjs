import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { startViewer } = await import(process.env.CUSTOMER_VOICE_PLUGIN_ROOT
    ? pathToFileURL(resolve(process.env.CUSTOMER_VOICE_PLUGIN_ROOT, "extensions/customer-voice/server.mjs")).href
    : new URL("../extensions/customer-voice/server.mjs", import.meta.url).href);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const root = await mkdtemp(join(tmpdir(), "cv-usability-browser-"));
await mkdir(join(root, "Exports"));
const source = join(root, "Exports", "synthetic.csv");
const choices = ["Very dissatisfied", "Somewhat dissatisfied", "Neither satisfied nor dissatisfied", "Somewhat satisfied", "Very satisfied"];
await writeFile(source, "ID,Recommend this product,Satisfaction,Written answer\n" +
    Array.from({ length: 40 }, (_, i) => `${i},${i % 11},${choices[i % 5]},Useful for task ${i}`).join("\n"));
let picks = 0;
const viewer = await startViewer({}, { storage: join(root, "profiles"),
    pickExport: async () => ({ path: picks++ ? null : source }) });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const idle = () => page.waitForFunction(() => document.querySelector("#status").textContent === "");
try {
    await page.goto(viewer.url); await idle();
    await page.getByRole("button", { name: "Open an export", exact: true }).click();
    await page.getByRole("button", { name: "Browse files", exact: true }).click();
    await idle();
    assert.equal(await page.locator("#path").inputValue(), source);
    await page.getByRole("button", { name: "Browse files", exact: true }).click();
    await idle();
    assert.equal(await page.locator("#path").inputValue(), source, "Cancel must preserve the previous selection.");
    await page.getByRole("button", { name: "View report", exact: true }).click();
    await page.locator("#dashboard:not([hidden])").waitFor(); await idle();
    assert.equal(await page.locator("#mapping").isVisible(), false);
    assert.equal(await page.locator("#preview-notice").isVisible(), true);
    assert.equal((await viewer.operation("config")).surveys.length, 0);
    const segment = page.locator(".balance [data-tooltip]").first();
    const label = await segment.getAttribute("data-tooltip");
    await segment.hover();
    assert.equal(await page.locator("#chart-tooltip").innerText(), label);
    assert.match(label, /% \/ \d+ of 40 valid answers/);
    await segment.focus();
    assert.equal(await page.locator("#chart-tooltip").isVisible(), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#chart-tooltip").isVisible(), false);
    await page.getByRole("button", { name: "Review profile", exact: true }).click(); await idle();
    await page.locator('[data-field="c3"] summary').click();
    await page.locator('[data-field="c3"] [data-key="group"]').fill("Experience");
    await page.locator('[data-field="c4"] summary').click();
    await page.locator('[data-field="c4"] [data-key="group"]').fill("Written answers");
    await page.locator("#confirm-mappings").check();
    await page.getByRole("button", { name: "Save profile and open report", exact: true }).click(); await idle();
    assert.equal(await page.locator("#preview-notice").isVisible(), false);
    await page.getByRole("button", { name: "Experience", exact: true }).click(); await idle();
    assert.match(await page.locator("#content").innerText(), /Sections use profile group labels/);
    const ordered = page.locator(".balance [data-tooltip]").first();
    await ordered.hover();
    assert.match(await page.locator("#chart-tooltip").innerText(), /Very dissatisfied: 20% \/ 8 of 40/);
    if (process.env.CUSTOMER_VOICE_SCREENSHOT) await page.screenshot({ path: process.env.CUSTOMER_VOICE_SCREENSHOT });
    await page.getByRole("button", { name: "Written answers", exact: true }).click(); await idle();
    await page.getByRole("button", { name: "Read all answers", exact: true }).click(); await idle();
    assert.match(await page.locator("#answer-count").innerText(), /40 written answers/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log("Usability browser check passed: picker selection/cancellation wiring (test picker), quick view without saved mappings, later review, group tabs, all answers, hover/focus percentages, narrow layout.");
} finally {
    await browser.close();
    await viewer.close();
    await rm(root, { recursive: true, force: true });
}
