import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { startViewer } = await import(process.env.CUSTOMER_VOICE_PLUGIN_ROOT
    ? pathToFileURL(resolve(process.env.CUSTOMER_VOICE_PLUGIN_ROOT, "extensions/customer-voice/server.mjs")).href
    : new URL("../extensions/customer-voice/server.mjs", import.meta.url).href);

const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const root = await mkdtemp(join(tmpdir(), "cv-contact-browser-"));
const source = join(root, "synthetic.csv");
await writeFile(source, [
    "ID,Written answer,Consent,Follow-up email",
    "1,Reach o'connor@example.com for details,Yes,o'connor@example.com",
    "2,Reach !team+test@example.com for details,Yes,!team+test@example.com",
    "3,Reach bad..address@example.com for details,Yes,bad..address@example.com",
    "4,Do not follow up,No,no-consent@example.com",
].join("\n"));
const viewer = await startViewer({ source }, { storage: join(root, "profiles") });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
const page = await browser.newPage();
const idle = () => page.waitForFunction(() => document.querySelector("#status").textContent === "");
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
    await page.goto(viewer.url); await idle();
    await page.getByRole("button", { name: "Inspect export", exact: true }).click();
    await page.locator("#mapping:not([hidden])").waitFor();
    await page.locator('[data-field="c2"] summary').click();
    await page.locator('[data-field="c2"] [data-key="kind"]').selectOption("text");
    await page.locator("#contact-field").selectOption("c4");
    await page.locator("#consent-field").selectOption("c3");
    await page.locator("#confirm-mappings").check();
    await page.locator("#confirm-profile").click();
    await idle();
    await page.getByRole("button", { name: "All questions", exact: true }).click();
    await idle();
    await page.locator('[data-question="c2"]').click();
    await page.locator(".answer-card").first().waitFor();
    const text = await page.locator("#question-detail").innerText();
    assert.ok(!text.includes("o'connor"));
    assert.ok(!text.includes("!team+test"));
    assert.ok(!text.includes("bad..address"));
    await page.getByRole("button", { name: "Private follow-up", exact: true }).click();
    await idle();
    await page.getByRole("button", { name: "Show consented contacts", exact: true }).click();
    await idle();
    const contacts = await page.locator("#contacts").innerText();
    assert.match(contacts, /2 consented contacts/);
    assert.ok(contacts.includes("o'connor@example.com"));
    assert.ok(contacts.includes("!team+test@example.com"));
    assert.match(contacts, /1 consented entries have an unsupported address format/);
    assert.ok(!contacts.includes("bad..address@example.com"));
    assert.ok(!contacts.includes("no-consent@example.com"));
    assert.deepEqual(errors, []);
    console.log("Contact browser check passed: complete address redaction, apostrophe/plus contact display, explicit unsupported-format warning, and consent gate.");
} finally {
    await browser.close();
    await viewer.close();
    await rm(root, { recursive: true, force: true });
}
