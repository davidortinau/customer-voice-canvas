import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Explicit opt-in: this check updates the real installed plugin.
assert.equal(process.env.CUSTOMER_VOICE_TEST_UPDATE, "yes", "Set CUSTOMER_VOICE_TEST_UPDATE=yes to update the installed plugin.");
const plugin = resolve(process.env.CUSTOMER_VOICE_PLUGIN_ROOT);
const expected = process.env.CUSTOMER_VOICE_EXPECT_VERSION;
assert.ok(expected, "Set CUSTOMER_VOICE_EXPECT_VERSION to the new published version.");
const manifest = () => readFile(join(plugin, ".github/plugin/plugin.json"), "utf8").then(JSON.parse);
const before = await manifest();
assert.notEqual(before.version, expected, "This check needs an actual version upgrade.");
const root = await mkdtemp(join(tmpdir(), "cv-update-check-"));
let viewer;
try {
    const source = join(root, "synthetic.csv");
    const storage = join(root, "profiles");
    await writeFile(source, "ID,Recommend this product,Written answer\n" +
        Array.from({ length: 40 }, (_, i) => `${i},9,Useful for task ${i}`).join("\n"));
    const moduleUrl = pathToFileURL(join(plugin, "extensions/customer-voice/server.mjs")).href;
    const previous = await import(moduleUrl);
    viewer = await previous.startViewer({}, { storage });
    const proposal = await viewer.operation("inspect", { path: source });
    const report = await viewer.operation("confirm", { ticket: proposal.ticket, profile: proposal.profile });
    await viewer.operation("view", { tab: "questions", selected: "c3", answerPage: 1,
        answerSearch: "", questionSearch: "", scroll: 900, listScroll: 50 });
    await viewer.close();
    viewer = null;
    const profilePath = join(storage, `${report.surveyId}.json`);
    const viewPath = join(storage, "views", `${report.surveyId}.json`);
    const savedProfile = await readFile(profilePath, "utf8");
    const savedView = await readFile(viewPath, "utf8");
    execFileSync(process.env.COPILOT_CLI_EXECUTABLE || "copilot",
        ["plugin", "update", "customer-voice-canvas@customer-voice-canvas"],
        { stdio: "inherit", timeout: 120000 });
    assert.equal((await manifest()).version, expected);
    assert.equal(await readFile(profilePath, "utf8"), savedProfile);
    assert.equal(await readFile(viewPath, "utf8"), savedView);
    const updated = await import(`${moduleUrl}?version=${encodeURIComponent(expected)}`);
    viewer = await updated.startViewer({}, { storage });
    const reopened = await viewer.operation("open", { id: report.surveyId });
    assert.equal(reopened.scope.selected, 40);
    assert.equal(reopened.view.scroll, 900);
    assert.equal(reopened.view.answerPage, 1);
    assert.equal(reopened.view.selected, "c3");
    assert.equal((await viewer.operation("answers", { question: "c3" })).total, 40);
    console.log(`Installed upgrade passed: ${before.version} to ${expected}, unchanged saved profile and view, reopened report and full answers.`);
} finally {
    await viewer?.close();
    await rm(root, { recursive: true, force: true });
}
