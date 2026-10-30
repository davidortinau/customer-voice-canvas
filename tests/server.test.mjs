import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, startViewer } from "../extensions/customer-voice/server.mjs";
import { pathToFileURL } from "node:url";

test("a running provider keeps matching renderer assets during an on-disk update", async () => {
    const root = await mkdtemp(join(tmpdir(), "cv-assets-update-"));
    let viewer, second;
    try {
        for (const file of ["server.mjs", "dataverse.mjs", "file-picker.mjs", "index.html", "viewer.mjs", "viewer.css"]) {
            await copyFile(new URL(`../extensions/customer-voice/${file}`, import.meta.url), join(root, file));
        }
        const module = await import(pathToFileURL(join(root, "server.mjs")).href);
        viewer = await module.startViewer({}, { storage: join(root, "profiles") });
        const original = await readFile(join(root, "viewer.mjs"), "utf8");
        await writeFile(join(root, "viewer.mjs"), "// renderer from a newer release");
        assert.equal(await (await fetch(new URL("/viewer.mjs", viewer.url))).text(), original);
        second = await module.startViewer({}, { storage: join(root, "profiles") });
        assert.equal(await (await fetch(new URL("/viewer.mjs", second.url))).text(), original);
        const updated = await import(`${pathToFileURL(join(root, "server.mjs")).href}?updated`);
        const fresh = await updated.startViewer({}, { storage: join(root, "profiles") });
        try {
            assert.equal(await (await fetch(new URL("/viewer.mjs", fresh.url))).text(),
                "// renderer from a newer release");
        } finally { await fresh.close(); }
    } finally {
        await viewer?.close();
        await second?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("import, save, reopen, filter, explicit refresh, privacy, and snapshot failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "customer-voice-test-"));
    const source = join(root, "sample.csv");
    const storage = join(root, "profiles");
    const csv = "ID,Recommend this product,Written answer,Consent,Follow-up email,Personalized data\n" +
        Array.from({ length: 40 }, (_, i) =>
            `${i},${i % 11},Useful for task ${i},${i % 2 ? "Yes" : "No"},person${i}@example.test,source:editor;`).join("\n");
    let viewer, second;
    try {
        await writeFile(source, csv);
        viewer = await startViewer({}, { storage });
        const base = new URL(viewer.url);
        const token = base.hash.slice(1);
        const call = async (name, body = {}, authorized = true) => {
            const response = await fetch(new URL(`/api/${name}`, base), {
                method: "POST", headers: {
                    "Content-Type": "application/json", ...(authorized ? { Authorization: `Bearer ${token}` } : {}),
                }, body: JSON.stringify(body),
            });
            return { status: response.status, text: await response.text() };
        };
        const denied = await call("config", {}, false);
        assert.equal(denied.status, 403);
        assert.equal(JSON.parse(denied.text).error, "Reopen the Canvas to restore access.");
        const wrongVerb = await fetch(new URL("/api/config", base), {
            headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(wrongVerb.status, 405);
        assert.equal((await wrongVerb.json()).error, "Use an authenticated local request.");
        const proposal = JSON.parse((await call("inspect", { path: source })).text);
        assert.equal(proposal.source.rows, 40);
        assert.equal(proposal.source.columns, 6);
        const profile = proposal.profile;
        profile.fields[2].kind = "text";
        profile.fields[2].filter = false;
        profile.fields[2].choices = [];
        profile.followup = { contact: "c5", consent: "c4", value: "Yes" };
        profile.metadataSource = true;
        const confirmed = await call("confirm", { ticket: proposal.ticket, profile });
        assert.equal(confirmed.status, 200, confirmed.text);
        const report = JSON.parse(confirmed.text);
        assert.ok(report.surveyId);
        assert.equal(report.scope.selected, 40);
        assert.ok(!confirmed.text.includes("person0@"));
        assert.equal(JSON.parse((await call("answers", { question: "c3" })).text).answers.length, 40);
        assert.equal(JSON.parse((await call("contacts")).text).contacts.length, 20);
        const filtered = JSON.parse((await call("filter", { filters: { c4: "Yes" } })).text);
        assert.equal(filtered.scope.selected, 20);
        const files = await readdir(storage);
        assert.equal(files.length, 1);
        const saved = await readFile(join(storage, files[0]), "utf8");
        assert.ok(!saved.includes("person0@"));
        if (process.platform !== "win32") assert.equal((await stat(join(storage, files[0]))).mode & 0o777, 0o600);
        second = await startViewer({}, { storage });
        const reopened = await second.operation("open", { id: report.surveyId });
        assert.equal(reopened.scope.selected, 40);
        await writeFile(source, csv.replace("Useful for task 0", "Updated task text"));
        const held = await call("answers", { question: "c3" });
        assert.equal(held.status, 200);
        assert.doesNotMatch(held.text, /Updated task text/);
        assert.match(held.text, /Useful for task/);
        assert.equal((await viewer.operation("scope")).source.sha256, report.source.sha256);
        const refreshed = JSON.parse((await call("refresh")).text);
        assert.notEqual(refreshed.source.sha256, report.source.sha256);
        assert.equal(refreshed.scope.selected, 20);
        await viewer.operation("view", { tab: "questions", selected: "c3", answerPage: 1,
            answerSearch: "private search", questionSearch: "", scroll: 900, listScroll: 50 });
        const reopenedWithView = await second.operation("open", { id: report.surveyId });
        assert.equal(reopenedWithView.view.scroll, 900);
        assert.equal(reopenedWithView.view.answerPage, 1);
        assert.equal(reopenedWithView.scope.selected, 20);
        const view = await readFile(join(storage, "views", `${report.surveyId}.json`), "utf8");
        assert.ok(!view.includes("private search"));
        const nextSource = join(root, "refreshed.csv");
        await writeFile(nextSource, csv);
        const nextProposal = JSON.parse((await call("inspect", { id: report.surveyId, path: nextSource })).text);
        const reused = JSON.parse((await call("confirm", {
            ticket: nextProposal.ticket, profile: nextProposal.previous,
        })).text);
        assert.equal(reused.surveyId, report.surveyId);
        assert.equal(reused.source.name, "refreshed.csv");
        await writeFile(nextSource, csv.replace("Consent", "Consent changed"));
        assert.equal((await call("refresh")).status, 422);
        assert.equal((await viewer.operation("scope")).source.sha256, reused.source.sha256);
    } finally {
        for (const entry of [viewer, second].filter(Boolean)) {
            await entry.close();
        }
        await rm(root, { recursive: true, force: true });
    }
});

test("a corrupt profile or view is reported without blocking other surveys", async () => {
    const root = await mkdtemp(join(tmpdir(), "cv-library-test-"));
    const viewer = await startViewer({}, { storage: root });
    const goodId = "11111111-1111-4111-8111-111111111111";
    const badId = "22222222-2222-4222-8222-222222222222";
    try {
        await writeFile(join(root, `${goodId}.json`), JSON.stringify({
            profile: { id: goodId, title: "Good survey" }, name: "Synthetic source",
        }));
        await writeFile(join(root, `${badId}.json`), "{broken");
        const library = await viewer.operation("config");
        assert.deepEqual(library.surveys.map(s => s.id), [goodId]);
        assert.equal(library.warnings.length, 1);
        assert.ok(library.warnings[0].includes(badId));
        assert.equal(await readFile(join(root, `${badId}.json`), "utf8"), "{broken");
        await assert.rejects(viewer.operation("open", { id: badId }), SyntaxError);
        await mkdir(join(root, "views"));
        await writeFile(join(root, "views", `${badId}.json`), "{broken view");
        await writeFile(join(root, `${badId}.json`), JSON.stringify({
            profile: { id: badId, title: "Bad view survey" }, name: "Synthetic source",
        }));
        const withBadView = await viewer.operation("config");
        assert.deepEqual(withBadView.surveys.map(s => s.id), [goodId]);
        assert.equal(withBadView.warnings.length, 1);
    } finally {
        await viewer.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("the Python reader supports cancellation before and during a read", async () => {
    const before = new AbortController();
    before.abort();
    await assert.rejects(analyze({}, { signal: before.signal }), /abort/i);
    const during = new AbortController();
    const pending = analyze({ source: "/unused.csv" }, { signal: during.signal });
    during.abort();
    await assert.rejects(pending, /cancelled/);
});

test("renderer has no background refresh or source watcher", async () => {
    const renderer = await readFile(new URL("../extensions/customer-voice/viewer.mjs", import.meta.url), "utf8");
    const server = await readFile(new URL("../extensions/customer-voice/server.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(renderer, /setInterval|setTimeout|EventSource|WebSocket/);
    assert.doesNotMatch(server, /watchFile|fs\.watch|setInterval/);
});

test("local file browsing, quick view, and later profile review preserve the loaded snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "cv-quick-view-"));
    const storage = join(root, "profiles");
    const source = join(root, "survey.csv");
    await mkdir(join(root, "Exports"));
    await writeFile(join(root, "notes.txt"), "not an export");
    await writeFile(source, "ID,Recommend this product,Written answer,Consent,Follow-up email\n" +
        Array.from({ length: 40 }, (_, i) => `${i},9,Useful for task ${i},Yes,person${i}@example.test`).join("\n"));
    let picks = 0;
    const viewer = await startViewer({}, { storage, pickExport: async () => ({ path: picks++ ? null : source }) });
    try {
        assert.deepEqual(await viewer.operation("browse"), { path: source });
        assert.deepEqual(await viewer.operation("browse"), { path: null });
        const proposal = await viewer.operation("inspect", { path: source });
        const report = await viewer.operation("preview", { ticket: proposal.ticket });
        assert.equal(report.preview, true);
        assert.equal(report.contactEnabled, false);
        assert.equal(report.questions.find(q => q.kind === "nps").metric.value, 100);
        assert.equal((await viewer.operation("config")).surveys.length, 0);
        await assert.rejects(viewer.operation("contacts"), /confirm consent|consent mapping/);
        assert.equal((await viewer.operation("filter", { filters: {} })).preview, true);
        assert.equal((await viewer.operation("view", {})).saved, false);
        await writeFile(source, "changed columns");
        const review = await viewer.operation("review");
        assert.equal(review.source.sha256, report.source.sha256, "Review must not reread a changed source.");
        review.previous.fields[2].kind = "text";
        review.previous.fields[2].choices = [];
        review.previous.fields[2].group = "Written answers";
        const saved = await viewer.operation("confirm", { ticket: review.ticket, profile: review.previous });
        assert.equal(saved.preview, false);
        assert.equal(saved.surveyId, report.surveyId);
        assert.equal((await viewer.operation("answers", { question: "c3" })).total, 40);
        assert.equal((await viewer.operation("config")).surveys.length, 1);
        const state = { tab: "group:Written answers", scroll: 100, listScroll: 0,
            answerPage: 0, answerSearch: "", questionSearch: "" };
        assert.equal((await viewer.operation("view", state)).saved, true);
        await assert.rejects(viewer.operation("view", { ...state, tab: "group:Unknown" }), /Invalid reading state/);
        assert.equal(JSON.parse(await readFile(join(storage, "views", `${saved.surveyId}.json`), "utf8")).view.tab,
            "group:Written answers");
    } finally {
        await viewer.close();
        await rm(root, { recursive: true, force: true });
    }
});
