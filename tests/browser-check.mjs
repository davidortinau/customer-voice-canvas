import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { startViewer } from "../extensions/customer-voice/server.mjs";

// Use an existing Playwright installation. No browser or package is downloaded.
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const source = process.env.CUSTOMER_VOICE_TEST_EXPORT;
assert.ok(source, "Set CUSTOMER_VOICE_TEST_EXPORT to a private, local acceptance workbook.");
const maui = process.env.CUSTOMER_VOICE_TEST_PROFILE === "maui";
// Calculate an independent CSV baseline. Acceptance must also work after an export refresh.
const baseline = maui ? JSON.parse(execFileSync(process.env.CUSTOMER_VOICE_PYTHON || "python3", ["-c", `
import csv, hashlib, io, json, sys
import pandas as pd
data = open(sys.argv[1], "rb").read()
table = list(csv.reader(io.StringIO(data.decode("utf-8-sig"))))
rows = [r for r in table[1:] if any(v.strip() for v in r)]
dates = pd.to_datetime(pd.Series([r[2] for r in rows]), format="mixed", errors="coerce")
submitted = [r for r, valid in zip(rows, dates.notna()) if valid]
eligible = [r for r in submitted if r[5].strip() == "Yes"]
def scores(group):
    nps = [int(float(r[10])) for r in group if r[10].strip()]
    csat = [r[8].strip() for r in group if r[8].strip()]
    numerator = sum(x >= 9 for x in nps) - sum(x <= 6 for x in nps)
    positive = sum(x in {"Slightly Satisfied", "Moderately Satisfied", "Extremely Satisfied"} for x in csat)
    return {"n": len(group), "nps": round(numerator / len(nps) * 100, 1) if len(nps) >= 5 else None,
            "npsNumerator": numerator, "npsN": len(nps), "csat": round(positive / len(csat) * 100, 1) if len(csat) >= 5 else None,
            "csatNumerator": positive, "csatN": len(csat)}
def source(row):
    for pair in row[36].split(";"):
        key, sep, value = pair.partition(":")
        if sep and key.strip().lower() == "source":
            return value.strip() or "[missing]"
    return "[missing]"
groups = {s: scores([r for r in eligible if source(r) == s]) for s in sorted({source(r) for r in eligible})}
print(json.dumps({"rows": len(rows), "submitted": len(submitted), "selected": len(eligible),
                  "sha256": hashlib.sha256(data).hexdigest(), "metrics": scores(eligible), "groups": groups}))
`, source], { encoding: "utf8", timeout: 60000 })) : null;
const expected = maui ? { ...baseline, columns: 37, nps: "c11", text: "c26" }
    : { rows: 115, selected: 115, columns: 162, nps: "c23", text: "c24" };
const root = await mkdtemp(join(tmpdir(), "cv-browser-test-"));
const corruptId = "22222222-2222-4222-8222-222222222222";
await writeFile(join(root, `${corruptId}.json`), "{broken");
const viewer = await startViewer({ source }, { storage: root });
const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true,
});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [], requests = [];
page.on("pageerror", error => errors.push(error.message));
page.on("request", request => {
    if (!request.url().endsWith("/api/view")) requests.push(request.url());
});
const idle = () => page.waitForFunction(() => document.querySelector("#status").textContent === "");
let reopened;
try {
    await page.clock.install();
    await page.goto(viewer.url.split("#")[0]);
    await page.locator("#error:not([hidden])").waitFor();
    assert.match(await page.locator("#error").innerText(), /Reopen the Canvas to restore access/);
    await page.goto(viewer.url);
    await page.reload();
    await page.locator("#library-warning:not([hidden])").waitFor();
    await idle();
    assert.ok((await page.locator("#library-warning").innerText()).includes(corruptId));
    await page.getByRole("button", { name: "Inspect export", exact: true }).click();
    await page.locator("#mapping:not([hidden])").waitFor();
    assert.ok((await page.locator("#mapping").innerText()).includes(`${expected.rows} responses / ${expected.columns} columns`));
    assert.equal(await page.locator(".map-row").count(), expected.columns);
    await page.locator("#confirm-mappings").check();
    await page.getByRole("button", { name: "Save profile and open report", exact: true }).click();
    await page.locator("#dashboard:not([hidden])").waitFor();
    await idle();
    const scope = await viewer.operation("scope");
    assert.equal(scope.questions.length, expected.columns);
    assert.equal(scope.scope.selected, expected.selected);
    assert.equal(scope.questions.find(q => q.id === expected.nps).metric.value, maui ? baseline.metrics.nps : 30.4);
    if (maui) {
        assert.equal(scope.source.sha256, baseline.sha256);
        assert.equal(scope.scope.submitted, baseline.submitted);
        const csat = scope.questions.find(q => q.id === "c9").metric;
        const nps = scope.questions.find(q => q.id === "c11").metric;
        assert.deepEqual([csat.numerator, csat.denominator, csat.value],
            [baseline.metrics.csatNumerator, baseline.metrics.csatN, baseline.metrics.csat]);
        assert.deepEqual([nps.numerator, nps.denominator], [baseline.metrics.npsNumerator, baseline.metrics.npsN]);
        const scores = Object.fromEntries(scope.sourceGroups.map(g => [
            g.source, [g.n, g.metrics.find(m => m.id === "c11").value, g.metrics.find(m => m.id === "c9").value],
        ]));
        for (const [source, expected] of Object.entries(baseline.groups)) {
            assert.deepEqual(scores[source], [expected.n, expected.nps, expected.csat]);
        }
        await page.locator(".filters summary").click();
        await page.locator("#population").selectOption("submitted");
        await idle();
        assert.equal((await viewer.operation("scope")).scope.selected, baseline.submitted);
        await page.locator("#population").selectOption("eligible");
        await idle();
        await page.locator('[data-filter="source"]').selectOption("vs22");
        await idle();
        assert.equal((await viewer.operation("scope")).scope.selected, baseline.groups.vs22.n);
        await page.locator("#reset").click();
        await idle();
        assert.equal((await viewer.operation("scope")).scope.selected, baseline.selected);
    }
    await page.getByRole("button", { name: "All questions", exact: true }).click();
    await idle();
    await page.locator(`[data-question="${expected.text}"]`).click();
    await page.locator(".answer-card").first().waitFor();
    const written = await viewer.operation("answers", { question: expected.text });
    assert.ok(written.total > 20);
    if (!maui) assert.equal(written.total, 74);
    assert.ok((await page.locator("#answer-count").textContent()).includes(`${written.total} written answers`));
    await page.getByRole("button", { name: "Next answers", exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 900));
    const state = () => page.evaluate(() => ({
        scroll: scrollY, page: document.querySelector("#answer-pagination").innerText,
        first: document.querySelector(".answer-card").dataset.answerId,
        search: document.querySelector("#answer-search").value,
    }));
    const before = await state(), count = requests.length;
    const node = await page.locator(".answer-card").first().elementHandle();
    await page.clock.fastForward(10 * 60 * 1000);
    assert.equal(requests.length, count, "Idle time must not trigger polling.");
    assert.deepEqual(await state(), before);
    assert.ok(await node.evaluate(element => element.isConnected));
    const viewSaved = page.waitForResponse(response => response.url().endsWith("/api/view") && response.ok());
    await page.locator("#refresh").click();
    await idle();
    assert.deepEqual(await state(), before, "Manual refresh must preserve reading position and answer page.");
    // A new server origin models an extension restart without copying private data.
    await viewSaved;
    reopened = await startViewer({ surveyId: scope.surveyId }, { storage: root });
    await page.goto(reopened.url);
    await idle();
    await page.locator(".answer-card").first().waitFor();
    assert.deepEqual(await state(), before, "A new loopback origin must restore the saved reading position.");
    await page.getByRole("button", { name: "Private follow-up", exact: true }).click();
    await idle();
    await page.getByRole("button", { name: "Show consented contacts", exact: true }).click();
    await idle();
    const contacts = await reopened.operation("contacts");
    if (!maui) assert.equal(contacts.contacts.length, 24);
    assert.ok((await page.locator("#contacts").innerText()).includes(`${contacts.contacts.length} consented contacts`));
    await page.getByRole("button", { name: "Method and column audit", exact: true }).click();
    await idle();
    assert.equal(await page.locator(".audit tbody tr").count(), expected.columns);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await idle();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: process.env.CUSTOMER_VOICE_SCREENSHOT || join(root, "dark.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, "The narrow view must not overflow.");
    assert.deepEqual(errors, []);
    console.log(`Browser check passed: ${expected.rows} real responses, ${expected.columns} columns, charts, full answers, contacts, no polling, manual refresh, new-origin reading state, and narrow layout.`);
} finally {
    await browser.close();
    for (const entry of [viewer, reopened].filter(Boolean)) {
        await entry.close();
    }
    await rm(root, { recursive: true, force: true });
}
