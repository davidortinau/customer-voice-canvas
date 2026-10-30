import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const guidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function guid(value) {
    if (typeof value !== "string" || !guidPattern.test(value)) throw new Error("Enter a valid tenant, client, or survey GUID.");
    return value.toLowerCase();
}

export function environment(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error("Enter the HTTPS Dataverse environment URL."); }
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash
        || !["", "/"].includes(url.pathname)
        || !/^[a-z0-9-]+\.crm(?:\d+)?\.dynamics\.com$/i.test(url.hostname)) {
        throw new Error("Use a commercial-cloud environment URL such as https://org.crm.dynamics.com. Other clouds need a separate authority configuration.");
    }
    return url.origin;
}

export async function signIn(config) {
    const origin = environment(config.environment), tenant = guid(config.tenant), clientId = guid(config.clientId);
    let PublicClientApplication, openBrowser;
    try {
        ({ PublicClientApplication } = await import("@azure/msal-node"));
        ({ default: openBrowser } = await import("open"));
    } catch (error) {
        if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
        throw new Error("The direct connector needs its Node packages. Run npm ci in extensions/customer-voice, then reopen the Canvas.");
    }
    const app = new PublicClientApplication({
        auth: { clientId, authority: `https://login.microsoftonline.com/${tenant}` },
        system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } },
    });
    const scopes = [`${origin}/user_impersonation`];
    let result;
    try {
        result = await app.acquireTokenInteractive({
            scopes, openBrowser: async url => { await openBrowser(url); },
            successTemplate: "Signed in. You can close this window and return to Customer Voice.",
            errorTemplate: "Sign-in failed. Return to Customer Voice for the error code.",
        });
    } catch (error) {
        throw new Error(`Microsoft sign-in failed (${error.errorCode || "authentication_failed"}). Check the public-client registration, consent, and tenant policy.`);
    }
    if (!result?.accessToken || result.tenantId?.toLowerCase() !== tenant) {
        throw new Error("Sign-in did not return a token for the selected tenant.");
    }
    // The MSAL cache and tokens stay in process memory. No plaintext token cache.
    return {
        config: { environment: origin, tenant, clientId },
        token: async () => {
            if (!result.expiresOn || result.expiresOn.getTime() <= Date.now() + 30000) {
                try { result = await app.acquireTokenSilent({ scopes, account: result.account }); }
                catch { throw new Error("The Microsoft session expired. Select Sign in to connect again."); }
            }
            return result.accessToken;
        },
    };
}

export function createDataverse(config, token, options = {}) {
    const origin = environment(config.environment), base = `${origin}/api/data/v9.2/`;
    const fetcher = options.fetch || fetch;
    const pause = options.delay || delay;
    const signal = options.signal;
    function safeUrl(input) {
        const url = new URL(input, base);
        if (url.origin !== origin || !url.pathname.startsWith("/api/data/v9.2/")
            || url.username || url.password || url.hash) {
            throw new Error("Dataverse returned an unsafe continuation URL. No credentials were sent.");
        }
        return url.href;
    }
    async function read(input) {
        const url = safeUrl(input);
        for (let attempt = 0; attempt < 4; attempt++) {
            signal?.throwIfAborted();
            const accessToken = await token();
            let response;
            try {
                response = await fetcher(url, {
                    method: "GET", redirect: "error", signal: AbortSignal.any(
                        [AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
                    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json",
                        "OData-MaxVersion": "4.0", "OData-Version": "4.0",
                        Prefer: "odata.maxpagesize=5000" },
                });
            } catch (error) {
                if (signal?.aborted) throw error;
                throw new Error(`Dataverse GET ${new URL(url).pathname} failed (network, timeout, or redirect).`);
            }
            if (response.status === 429 && attempt < 3) {
                const retry = response.headers.get("Retry-After");
                const milliseconds = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 :
                    retry ? Date.parse(retry) - Date.now() : (attempt + 1) * 1000;
                if (!Number.isFinite(milliseconds) || milliseconds > 30000) {
                    throw new Error("Dataverse throttled this read. Retry-After exceeds 30 seconds. Refresh later.");
                }
                await pause(Math.max(0, milliseconds), undefined, { signal });
                continue;
            }
            if (!response.ok) {
                const reason = { 401: "Sign in again.", 403: "Reader access is missing.",
                    404: "The Customer Voice table or environment was not found.", 429: "Throttling retries were exhausted." }[response.status] || "The read failed.";
                throw new Error(`Dataverse GET ${new URL(url).pathname}: HTTP ${response.status}. ${reason}`);
            }
            let payload;
            try { payload = await response.json(); } catch { throw new Error("Dataverse returned invalid JSON."); }
            return payload;
        }
    }
    async function all(input) {
        let next = safeUrl(input);
        const seen = new Set(), values = [];
        while (next) {
            if (seen.has(next) || seen.size >= 10000) throw new Error("Dataverse paging did not complete.");
            seen.add(next);
            const page = await read(next);
            if (!Array.isArray(page.value)) throw new Error("Dataverse did not return a complete record collection.");
            values.push(...page.value);
            if (values.length > 500000) throw new Error("The selected read exceeds 500,000 records. No partial snapshot was loaded.");
            next = page["@odata.nextLink"] ? safeUrl(page["@odata.nextLink"]) : null;
        }
        return values;
    }
    function query(table, select, filter, order) {
        const params = new URLSearchParams({ $select: select });
        if (filter) params.set("$filter", filter);
        if (order) params.set("$orderby", order);
        return `${table}?${params}`;
    }
    async function checkSchema(table, required) {
        const definitions = await read(`EntityDefinitions(LogicalName='${table}')?$select=EntitySetName&$expand=Attributes($select=LogicalName)`);
        if (!Array.isArray(definitions.Attributes) || definitions["Attributes@odata.nextLink"]) {
            throw new Error(`Cannot validate ${table} metadata completely.`);
        }
        const names = new Set(definitions.Attributes.map(a => a.LogicalName));
        if (required.some(name => !names.has(name))) throw new Error(`The ${table} schema differs from the supported connector. No snapshot was loaded.`);
    }
    return {
        all,
        async surveys() {
            return (await all(query("msfp_surveys", "msfp_surveyid,msfp_name", null, "msfp_surveyid")))
                .map(s => ({ id: guid(s.msfp_surveyid), title: s.msfp_name || "Untitled survey" }));
        },
        async snapshot(surveyId) {
            const id = guid(surveyId);
            const questionFields = ["msfp_questionid", "msfp_questiontext", "msfp_questiontype", "msfp_choicetype",
                "msfp_questionchoices", "msfp_order", "msfp_sourcequestionidentifier", "msfp_sourceparentquestionidentifier", "msfp_survey"];
            const responseFields = ["activityid", "msfp_surveyid", "msfp_startdate", "msfp_submitdate",
                "msfp_respondentemailaddress"];
            await checkSchema("msfp_question", questionFields);
            await checkSchema("msfp_surveyresponse", responseFields);
            await checkSchema("msfp_questionresponse", ["msfp_questionresponseid", "msfp_questionid",
                "msfp_surveyresponseid", "msfp_response"]);
            const survey = await read(`msfp_surveys(${id})?$select=msfp_surveyid,msfp_name`);
            const questions = await all(query("msfp_questions",
                questionFields.filter(x => x !== "msfp_survey").join(",") + ",_msfp_survey_value",
                `_msfp_survey_value eq ${id}`, "msfp_order,msfp_questionid"));
            const responses = await all(query("msfp_surveyresponses",
                responseFields.filter(x => x !== "msfp_surveyid").join(",") + ",_msfp_surveyid_value",
                `_msfp_surveyid_value eq ${id}`, "activityid"));
            if (questions.some(q => q._msfp_survey_value?.toLowerCase() !== id)
                || responses.some(r => r._msfp_surveyid_value?.toLowerCase() !== id)) {
                throw new Error("Dataverse returned data outside the selected survey.");
            }
            const answers = [];
            for (let index = 0; index < responses.length; index += 25) {
                const ids = responses.slice(index, index + 25).map(r => guid(r.activityid));
                answers.push(...await all(query("msfp_questionresponses",
                    "msfp_questionresponseid,_msfp_questionid_value,_msfp_surveyresponseid_value,msfp_response",
                    ids.map(r => `_msfp_surveyresponseid_value eq ${r}`).join(" or "), "msfp_questionresponseid")));
            }
            return normalize({ survey, questions, responses, answers }, config);
        },
    };
}

export function normalize({ survey, questions, responses, answers }, config) {
    const surveyId = guid(survey.msfp_surveyid), origin = environment(config.environment), tenant = guid(config.tenant);
    const ids = questions.map(q => guid(q.msfp_questionid)), responseIds = responses.map(r => guid(r.activityid));
    if (new Set(ids).size !== ids.length || new Set(responseIds).size !== responseIds.length) {
        throw new Error("Duplicate question or response IDs prevent a complete live snapshot.");
    }
    const rows = responses.map(r => [r.activityid, r.msfp_startdate || "", r.msfp_submitdate || "",
        r.msfp_respondentemailaddress || "", ...questions.map(() => "")]);
    const byResponse = new Map(responseIds.map((id, i) => [id, i]));
    const byQuestion = new Map(ids.map((id, i) => [id, i + 4]));
    const joins = new Set();
    for (const answer of answers) {
        const r = byResponse.get(guid(answer._msfp_surveyresponseid_value));
        const q = byQuestion.get(guid(answer._msfp_questionid_value));
        const pair = `${r}:${q}`;
        if (r === undefined || q === undefined || joins.has(pair)) {
            throw new Error("Unmapped or duplicate question answers prevent a complete live snapshot.");
        }
        joins.add(pair);
        if (typeof answer.msfp_response !== "string" && answer.msfp_response !== null) {
            throw new Error("An answer uses an unsupported Dataverse representation.");
        }
        rows[r][q] = answer.msfp_response || "";
    }
    if (responses.length && questions.length && !answers.length) {
        throw new Error("No question-response records are available. Customer Voice processing may still be in progress. No empty snapshot was substituted.");
    }
    const columnIds = ["response-id", "start", "completion", "email", ...ids];
    const headers = ["ID", "Start time", "Completion time", "Email",
        ...questions.map(q => q.msfp_questiontext || `Question ${q.msfp_questionid}`)];
    const identity = `${tenant}:${origin}:${surveyId}`;
    const source = { name: survey.msfp_name || "Customer Voice survey", kind: "dataverse",
        identity, surveyId, environment: origin, tenant, columnIds,
        definitionHash: createHash("sha256").update(JSON.stringify(questions)).digest("hex"),
        sha256: createHash("sha256").update(JSON.stringify({ headers, questions, rows })).digest("hex"),
        rows: rows.length, columns: headers.length, sheet: "Dataverse", header: 1,
        readAt: new Date().toISOString(),
        warning: "Full paged read, not a transactionally consistent database snapshot. Customer Voice processing can lag." };
    const types = { 647390000: "choice", 647390001: "text", 647390002: "number", 647390003: "date",
        647390004: "unknown", 647390005: "unknown", 647390006: "choice", 647390007: "nps",
        647390008: "private", 647390009: "number", 647390010: "date", 647390011: "choice" };
    const parents = new Map(questions.map(q => [q.msfp_sourcequestionidentifier, q.msfp_questiontext]));
    const suggestions = questions.map((q, i) => {
        let kind = types[q.msfp_questiontype] || "unknown";
        if (kind === "choice" && q.msfp_choicetype === 647390001) kind = "multiple";
        if (/\b(email|e-mail|phone|address|name)\b/i.test(headers[i + 4])) kind = "private";
        let choices;
        try {
            const parsed = JSON.parse(q.msfp_questionchoices || "null");
            if (Array.isArray(parsed) && parsed.every(x => typeof x === "string")) choices = parsed;
        } catch { /* Unknown choice encoding stays review-needed; raw JSON is not interpreted. */ }
        if (["choice", "multiple"].includes(kind) && !choices) kind = "unknown";
        return { index: i + 4, kind, choices: choices || [],
            nativeId: ids[i], group: parents.get(q.msfp_sourceparentquestionidentifier) || "",
            filter: false, reason: choices || !["unknown"].includes(kind)
                ? "Dataverse question type. Confirm scoring and private-field handling."
                : "Dataverse choices, ranking, or parent type needs review. No representation was assumed." };
    });
    return { headers, rows, source, suggestions };
}
