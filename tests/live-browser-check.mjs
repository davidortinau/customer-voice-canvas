import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startViewer } from "../extensions/customer-voice/server.mjs";
import { normalize } from "../extensions/customer-voice/dataverse.mjs";

const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const root = await mkdtemp(join(tmpdir(), "cv-live-browser-"));
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const config = { tenant: id(1), clientId: id(2), environment: "https://sample.crm.dynamics.com" };
let fail = false, reads = 0, authenticated = false;
const viewer = await startViewer({}, {
    storage: root,
    signIn: async supplied => {
        assert.deepEqual(supplied, config); authenticated = true;
        return { config, token: async () => "synthetic-token" };
    },
    createDataverse: () => ({
        surveys: async () => [{ id: id(3), title: "Synthetic live survey" }],
        snapshot: async () => {
            reads++;
            if (fail) throw new Error("Dataverse GET: HTTP 403. Reader access is missing.");
            return normalize({
                survey: { msfp_surveyid: id(3), msfp_name: "Synthetic live survey" },
                questions: [{ msfp_questionid: id(4), msfp_questiontext: "Recommendation",
                    msfp_questiontype: 647390007 }],
                responses: Array.from({ length: 10 }, (_, i) => ({
                    activityid: id(100 + i), msfp_submitdate: "2026-10-28T00:00:00Z",
                })),
                answers: Array.from({ length: 10 }, (_, i) => ({
                    _msfp_surveyresponseid_value: id(100 + i), _msfp_questionid_value: id(4),
                    msfp_response: "9",
                })),
            }, config);
        },
    }),
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const idle = () => page.waitForFunction(() => document.querySelector("#status").textContent === "");
try {
    await page.goto(viewer.url); await idle();
    await page.getByText("Direct Customer Voice connection", { exact: true }).click();
    await page.locator("#environment").fill(config.environment);
    await page.locator("#tenant").fill(config.tenant);
    await page.locator("#client-id").fill(config.clientId);
    await page.getByRole("button", { name: "Sign in and list surveys", exact: true }).click();
    assert.equal(authenticated, false, "Sign-in requires the explicit user checkbox.");
    await page.locator("#approve-signin").check();
    await page.getByRole("button", { name: "Sign in and list surveys", exact: true }).click();
    await idle();
    assert.ok(authenticated);
    await page.locator("[data-live-survey]").click();
    await page.locator("#mapping:not([hidden])").waitFor();
    assert.equal(await page.locator(".map-row").count(), 5);
    await page.locator("#confirm-mappings").check();
    await page.locator("#confirm-profile").click();
    await idle();
    assert.equal((await viewer.operation("scope")).questions[4].metric.value, 100);
    assert.equal(reads, 1);
    const fingerprint = await page.locator("#fingerprint").innerText();
    fail = true;
    await page.locator("#refresh").click();
    await page.locator("#error:not([hidden])").waitFor();
    assert.match(await page.locator("#error").innerText(), /HTTP 403/);
    assert.equal(await page.locator("#fingerprint").innerText(), fingerprint);
    assert.equal((await viewer.operation("scope")).questions[4].metric.value, 100);
    assert.deepEqual(errors, []);
    console.log("Simulated live browser check passed: explicit sign-in approval, survey selection, mapping, shared charts, and failed-refresh data retention. No real Microsoft sign-in or live tenant read.");
} finally {
    await browser.close();
    await viewer.close();
    await rm(root, { recursive: true, force: true });
}
