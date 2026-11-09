import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { startViewer } = await import(process.env.CUSTOMER_VOICE_PLUGIN_ROOT
    ? pathToFileURL(resolve(process.env.CUSTOMER_VOICE_PLUGIN_ROOT, "extensions/customer-voice/server.mjs")).href
    : new URL("../extensions/customer-voice/server.mjs", import.meta.url).href);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const root = await mkdtemp(join(tmpdir(), "cv-conditional-browser-"));
const headers = ["ID", ...Array.from({ length: 158 }, (_, i) => `Question ${i + 2}`),
    "Are you a resident of the United States or Puerto Rico (eligibility for the sweepstakes)?",
    "Want to enter our .NET prize bundle sweepstakes? Please leave your email address below so we can contact you if you are selected as a winner.",
    "May we contact you at the email address you provided about follow-up research related to your .NET experience?",
    "May we contact you about follow-up research related to your .NET experience? If you agree, please provide your email address below. By providing your email address, you consent to being contacted by Microsoft for this research.",
    "Personalized data"];
const rows = [
    ["Yes", "prize-only@example.test", "No", "", ""],
    ["Yes", "prize-research@example.test", "Yes", "", ""],
    ["No", "", "", "alternate@example.test", ""],
    ["No", "", "", "", ""],
    ["Yes", "", "", "", ""],
].map((tail, i) => [String(i + 1), ...Array(158).fill(""), ...tail]);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
try {
    for (const format of ["csv", "xlsx"]) {
        const source = join(root, `conditional.${format}`), storage = join(root, format);
        if (format === "csv") {
            await writeFile(source, [headers, ...rows].map(row =>
                row.map(v => `"${v.replaceAll('"', '""')}"`).join(",")).join("\n"));
        } else {
            execFileSync(process.env.CUSTOMER_VOICE_TEST_PYTHON
                || (process.platform === "win32" ? "python" : "python3"), ["-c",
                "import json,sys; from openpyxl import Workbook; b=Workbook(); " +
                "[b.active.append(r) for r in json.load(sys.stdin)]; b.save(sys.argv[1])", source],
            { input: JSON.stringify([headers, ...rows]) });
        }
        const viewer = await startViewer({ source }, { storage });
        const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const idle = () => page.locator("#status:empty").waitFor({ state: "attached" });
        const tab = async name => { await page.getByRole("button", { name, exact: true }).click(); await idle(); };
        try {
            await page.goto(viewer.url); await idle();
            await tab("View report");
            await page.locator("#dashboard:not([hidden])").waitFor();
            const scope = await viewer.operation("scope");
            assert.equal(scope.questions.length, 164);
            assert.equal(scope.questions[161].kind, "choice");
            assert.equal(scope.questions[161].valid, 2);
            assert.equal(scope.questions[161].blank, 3);
            assert.doesNotMatch(JSON.stringify(scope), /@example\.test/);
            await assert.rejects(viewer.operation("contacts"), /Review and save/);
            for (const question of ["c161", "c163"]) {
                await assert.rejects(viewer.operation("answers", { question }), /written-answer/);
            }
            await tab("All questions");
            assert.equal(await page.locator('[data-question="c162"]').count(), 1);
            assert.equal(await page.locator('[data-question="c161"], [data-question="c163"]').count(), 0);
            await page.locator(".private-fields summary").click();
            assert.match(await page.locator(".private-fields").innerText(), /c161.*2 answered.*3 blank/);
            assert.match(await page.locator(".private-fields").innerText(), /c163.*1 answered.*4 blank/);
            assert.doesNotMatch(await page.locator("#content").innerText(), /@example\.test/);
            await page.locator('[data-question="c162"]').click(); await idle();
            assert.match(await page.locator("#question-detail").innerText(), /Yes/);
            assert.match(await page.locator("#question-detail").innerText(), /No/);
            await page.setViewportSize({ width: 390, height: 844 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            await page.setViewportSize({ width: 1200, height: 900 });
            if (process.env.CUSTOMER_VOICE_EVIDENCE_DIR && format === "xlsx") {
                await page.screenshot({ path: join(process.env.CUSTOMER_VOICE_EVIDENCE_DIR, "conditional-report.png"), fullPage: true });
            }
            await tab("Private follow-up");
            assert.equal(await page.locator("#load-contacts").count(), 0);
            await tab("Method and column audit");
            assert.equal(await page.locator("tbody tr").count(), 164);
            assert.match(await page.locator("tbody tr").nth(163).innerText(), /c164/);
            // Save an older private role, then require an explicit correction in Review profile.
            await tab("Review profile");
            await page.locator('[data-field="c162"] summary').click();
            await page.locator('[data-field="c162"] [data-key="kind"]').selectOption("private");
            await page.locator("#confirm-mappings").check();
            await tab("Save profile and open report");
            await page.reload(); await idle();
            await page.locator("#library [data-survey]").click(); await idle();
            assert.equal((await viewer.operation("scope")).questions[161].kind, "private");
            await tab("Review profile");
            await page.locator('[data-field="c162"] summary').click();
            assert.match(await page.locator('[data-field="c162"]').innerText(), /current import suggests\s+choice/);
            assert.equal(await page.locator('[data-field="c162"] [data-key="kind"]').inputValue(), "private");
            await page.locator('[data-field="c162"] [data-key="kind"]').selectOption("choice");
            await page.locator('[data-field="c162"] [data-key="choices"]').fill("No\nYes");
            await page.locator("#contact-field").selectOption("c161");
            await page.locator("#consent-field").selectOption("c162");
            await page.locator("#confirm-mappings").check();
            await tab("Save profile and open report");
            await tab("Private follow-up");
            await tab("Show consented contacts");
            const contacts = await page.locator("#contacts").innerText();
            assert.match(contacts, /prize-research@example\.test/);
            assert.doesNotMatch(contacts, /prize-only|alternate@/);
            const report = await viewer.operation("scope");
            const settings = await viewer.operation("settings", { action: "export", surveyId: report.surveyId });
            assert.doesNotMatch(JSON.stringify(settings), /@example\.test/);
            assert.ok(!settings.questions.some(q => ["c161", "c163"].includes(q.id)));
            const profileFile = (await readdir(storage)).find(name => name.endsWith(".json"));
            const saved = await readFile(join(storage, profileFile), "utf8");
            assert.doesNotMatch(saved, /@example\.test/);
            await tab("Review profile");
            await page.locator("#contact-field").selectOption("c163");
            await page.locator("#consent-field").selectOption("");
            await page.locator("#address-consent").check();
            await page.locator("#confirm-mappings").check();
            await tab("Save profile and open report");
            await tab("Private follow-up");
            await tab("Show consented contacts");
            const alternate = await page.locator("#contacts").innerText();
            assert.match(alternate, /alternate@example\.test/);
            assert.doesNotMatch(alternate, /prize-only|prize-research/);
            assert.deepEqual(errors, []);
        } finally {
            await page.close();
            await viewer.close();
        }
    }
    console.log("Conditional browser check passed (CSV and XLSX): 164 columns, sparse permission counts, private field inventory, explicit saved-role correction, preview lock, separate research consent rules, no private values in scope/settings/profile, narrow layout.");
} finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
}
