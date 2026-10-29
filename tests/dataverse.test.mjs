import assert from "node:assert/strict";
import { test } from "node:test";
import { createDataverse, environment, normalize, signIn } from "../extensions/customer-voice/dataverse.mjs";
import { startViewer } from "../extensions/customer-voice/server.mjs";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const config = { tenant: id(1), clientId: id(2), environment: "https://sample.crm.dynamics.com" };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const question = { msfp_questionid: id(4), msfp_questiontext: "Recommendation",
    msfp_questiontype: 647390007, _msfp_survey_value: id(3) };
const data = (score = "9") => ({
    survey: { msfp_surveyid: id(3), msfp_name: "Synthetic live survey" }, questions: [{ ...question }],
    responses: [{ activityid: id(5), msfp_submitdate: "2026-10-28T00:00:00Z",
        _msfp_surveyid_value: id(3), msfp_respondentemailaddress: "private@example.test" }],
    answers: [{ msfp_questionresponseid: id(6), _msfp_surveyresponseid_value: id(5),
        _msfp_questionid_value: id(4), msfp_response: score }],
});

test("strict environment and tenant validation before authentication", async () => {
    for (const url of ["http://sample.crm.dynamics.com", "https://evil.test", "https://a.crm.dynamics.com/other",
        "https://user:pass@sample.crm.dynamics.com", "https://127.0.0.1"]) {
        assert.throws(() => environment(url));
    }
    await assert.rejects(signIn({ ...config, tenant: "common" }), /GUID/);
});

test("all pages use the unchanged continuation and GET only", async () => {
    const calls = [];
    const next = `${config.environment}/api/data/v9.2/msfp_surveys?$skiptoken=encoded%252Bvalue`;
    const client = createDataverse(config, async () => "synthetic-token", {
        fetch: async (url, request) => {
            calls.push([url, request]);
            return calls.length === 1 ? json({ value: [{ n: 1 }], "@odata.nextLink": next }) : json({ value: [{ n: 2 }] });
        },
    });
    assert.deepEqual(await client.all("msfp_surveys"), [{ n: 1 }, { n: 2 }]);
    assert.equal(calls[1][0], next);
    for (const [, request] of calls) {
        assert.equal(request.method, "GET");
        assert.equal(request.redirect, "error");
        assert.equal(request.headers.Prefer, "odata.maxpagesize=5000");
    }
});

test("unsafe continuation is rejected before a credential callback", async () => {
    let tokens = 0, calls = 0;
    for (const continuation of ["https://evil.test/api/data/v9.2/x",
        `${config.environment}/not-api`, `${config.environment}/api/data/v9.2/x#fragment`]) {
        tokens = calls = 0;
        const client = createDataverse(config, async () => { tokens++; return "token"; }, {
            fetch: async () => { calls++; return json({ value: [], "@odata.nextLink": continuation }); },
        });
        await assert.rejects(client.all("msfp_surveys"), /unsafe/);
        assert.equal(tokens, 1); assert.equal(calls, 1);
    }
});

test("bounded throttling and explicit authentication failures", async () => {
    let calls = 0;
    const waits = [];
    const client = createDataverse(config, async () => "token", {
        delay: async ms => waits.push(ms),
        fetch: async () => ++calls < 3 ? json({}, 429, { "Retry-After": "1" }) : json({ value: [] }),
    });
    assert.deepEqual(await client.all("msfp_surveys"), []);
    assert.deepEqual(waits, [1000, 1000]);
    for (const status of [401, 403, 404, 500]) {
        await assert.rejects(createDataverse(config, async () => "token", {
            fetch: async () => json({ secret: "not returned" }, status),
        }).all("msfp_surveys"), new RegExp(`HTTP ${status}`));
    }
    await assert.rejects(createDataverse(config, async () => "token", {
        fetch: async () => json({}, 429, { "Retry-After": "120" }),
    }).all("msfp_surveys"), /exceeds/);
    calls = 0;
    await assert.rejects(createDataverse(config, async () => "token", {
        delay: async () => {}, fetch: async () => { calls++; return json({}, 429); },
    }).all("msfp_surveys"), /exhausted/);
    assert.equal(calls, 4);
});

test("cancellation, partial pages, invalid JSON, and loops fail closed", async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(createDataverse(config, async () => "token", {
        signal: controller.signal, fetch: async () => { throw new Error("Must not fetch"); },
    }).all("msfp_surveys"), /abort/i);
    let calls = 0;
    await assert.rejects(createDataverse(config, async () => "token", {
        fetch: async () => ++calls === 1 ? json({ value: [1], "@odata.nextLink": `${config.environment}/api/data/v9.2/next` })
            : json({}, 403),
    }).all("msfp_surveys"), /HTTP 403/);
    await assert.rejects(createDataverse(config, async () => "token", {
        fetch: async () => new Response("invalid"),
    }).all("msfp_surveys"), /invalid JSON/);
    await assert.rejects(createDataverse(config, async () => "token", {
        fetch: async () => json({ value: [], "@odata.nextLink": `${config.environment}/api/data/v9.2/msfp_surveys` }),
    }).all("msfp_surveys"), /paging/);
});

test("normalization retains qualified identities and rejects ambiguous joins", () => {
    const snapshot = normalize(data(), config);
    assert.equal(snapshot.rows[0][4], "9");
    assert.equal(snapshot.source.columnIds[4], id(4));
    assert.ok(snapshot.source.identity.includes(config.tenant));
    assert.equal(snapshot.suggestions[0].kind, "nps");
    const copied = data(); copied.survey.msfp_surveyid = id(7);
    assert.notEqual(normalize(copied, config).source.identity, snapshot.source.identity);
    const duplicated = data(); duplicated.answers.push(duplicated.answers[0]);
    assert.throws(() => normalize(duplicated, config), /duplicate/);
    const outside = data(); outside.answers[0]._msfp_questionid_value = id(999);
    assert.throws(() => normalize(outside, config), /Unmapped/);
    const pending = data(); pending.answers = [];
    assert.throws(() => normalize(pending, config), /processing/);
    const uncertain = data();
    uncertain.questions[0].msfp_questiontype = 647390000;
    uncertain.questions[0].msfp_questionchoices = '{"unsupported":"representation"}';
    const suggestion = normalize(uncertain, config).suggestions[0];
    assert.equal(suggestion.kind, "unknown");
    assert.deepEqual(suggestion.choices, []);
});

test("selected-survey read checks metadata and scopes answer joins", async () => {
    const payload = data(), calls = [];
    const fields = {
        msfp_question: ["msfp_questionid", "msfp_questiontext", "msfp_questiontype", "msfp_choicetype",
            "msfp_questionchoices", "msfp_order", "msfp_sourcequestionidentifier", "msfp_sourceparentquestionidentifier", "msfp_survey"],
        msfp_surveyresponse: ["activityid", "msfp_surveyid", "msfp_startdate", "msfp_submitdate", "msfp_respondentemailaddress"],
        msfp_questionresponse: ["msfp_questionresponseid", "msfp_questionid", "msfp_surveyresponseid", "msfp_response"],
    };
    const client = createDataverse(config, async () => "token", {
        fetch: async (url, request) => {
            calls.push([url, request]);
            if (url.includes("EntityDefinitions")) {
                const table = /LogicalName='([^']+)'/.exec(url)[1];
                return json({ Attributes: fields[table].map(LogicalName => ({ LogicalName })) });
            }
            if (url.includes(`msfp_surveys(${id(3)})`)) return json(payload.survey);
            if (url.includes("msfp_questions?")) return json({ value: payload.questions });
            if (url.includes("msfp_surveyresponses?")) return json({ value: payload.responses });
            if (url.includes("msfp_questionresponses?")) {
                assert.equal(new URL(url).searchParams.get("$filter"), `_msfp_surveyresponseid_value eq ${id(5)}`);
                return json({ value: payload.answers });
            }
            throw new Error("Unexpected route");
        },
    });
    const snapshot = await client.snapshot(id(3));
    assert.equal(snapshot.rows.length, 1);
    assert.equal(calls.length, 7);
    payload.questions[0]._msfp_survey_value = id(999);
    await assert.rejects(client.snapshot(id(3)), /outside/);
});

test("live snapshot runs through the shared engine; failed refresh preserves data; restart requires sign-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "cv-live-test-"));
    let fail = false, cancelNext = false, score = "9";
    const mocks = {
        storage: root, signIn: async () => ({ config, token: async () => "memory-only-token" }),
        createDataverse: (_config, _token, { signal }) => ({
            surveys: async () => [{ id: id(3), title: "Synthetic live survey" }],
            snapshot: async () => {
                if (fail) throw new Error("HTTP 403. Reader access is missing.");
                if (cancelNext) return new Promise((_resolve, reject) => {
                    signal.addEventListener("abort", () => reject(new Error("Read cancelled.")), { once: true });
                });
                return normalize(data(score), config);
            },
        }),
    };
    let viewer, second;
    try {
        viewer = await startViewer({}, mocks);
        await viewer.operation("signin", config);
        const proposal = await viewer.operation("inspect", { surveyId: id(3) });
        const report = await viewer.operation("confirm", { ticket: proposal.ticket, profile: proposal.profile });
        assert.equal(report.source.kind, "dataverse");
        assert.equal(report.questions[4].kind, "nps");
        assert.equal(report.questions[4].metric.denominator, 1);
        assert.ok(!JSON.stringify(report).includes("private@example.test"));
        fail = true;
        await assert.rejects(viewer.operation("refresh"), /HTTP 403/);
        assert.equal((await viewer.operation("scope")).source.sha256, report.source.sha256);
        fail = false; cancelNext = true;
        const pending = viewer.operation("refresh");
        await assert.rejects(viewer.operation("refresh"), /in progress/);
        await viewer.operation("cancel");
        await assert.rejects(pending, /cancelled/);
        assert.equal((await viewer.operation("scope")).source.sha256, report.source.sha256);
        cancelNext = false;
        fail = false; score = "0";
        const refreshed = await viewer.operation("refresh");
        assert.notEqual(refreshed.source.sha256, report.source.sha256);
        for (const file of (await readdir(root)).filter(f => f.endsWith(".json"))) {
            const text = await readFile(join(root, file), "utf8");
            assert.ok(!text.includes("private@example.test"));
            assert.ok(!text.includes("memory-only-token"));
        }
        second = await startViewer({}, mocks);
        await assert.rejects(second.operation("open", { id: report.surveyId }), /Sign in/);
        await second.operation("signin", config);
        assert.equal((await second.operation("open", { id: report.surveyId })).source.kind, "dataverse");
        cancelNext = true;
        const closingRead = second.operation("refresh");
        const rejected = assert.rejects(closingRead, /cancelled/);
        await second.close();
        await rejected;
        await assert.rejects(second.operation("scope"), /viewer is closed/);
    } finally {
        for (const entry of [viewer, second].filter(Boolean)) {
            await entry.close();
        }
        await rm(root, { recursive: true, force: true });
    }
});
