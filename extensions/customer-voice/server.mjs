import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, mkdir, open, rename, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createDataverse, environment, guid, signIn } from "./dataverse.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const assets = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/viewer.mjs", ["viewer.mjs", "text/javascript; charset=utf-8"]],
    ["/viewer.css", ["viewer.css", "text/css; charset=utf-8"]],
]);
const dataRoot = () => join(process.env.COPILOT_HOME || join(homedir(), ".copilot"),
    "extensions", "customer-voice-canvas", "artifacts");
const validId = value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);

export async function analyze(request, { signal } = {}) {
    signal?.throwIfAborted();
    const packaged = existsSync(join(here, "runtime", "platform.json"));
    if (packaged) {
        const target = JSON.parse(await readFile(join(here, "runtime", "platform.json"), "utf8"));
        if (target.platform !== process.platform || target.arch !== process.arch) {
            throw new Error("This release requires macOS on Apple Silicon. Other platforms need the source setup.");
        }
    }
    const launchers = packaged
        ? [[join(here, "runtime", "cv-engine", "cv-engine")]]
        : process.env.CUSTOMER_VOICE_PYTHON
        ? [[process.env.CUSTOMER_VOICE_PYTHON]]
        : process.platform === "win32" ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]];
    for (const [launcher, ...args] of launchers) {
        try {
            return await new Promise((accept, reject) => {
                const child = spawn(launcher, packaged ? [] : [...args, join(here, "engine.py")], {
                    stdio: ["pipe", "pipe", "pipe"], signal,
                });
                let stdout = "", stderr = "", exceeded = false;
                const timer = setTimeout(() => child.kill(), 60000);
                child.stdout.on("data", chunk => {
                    stdout += chunk;
                    if (stdout.length > 32 * 1024 * 1024) { exceeded = true; child.kill(); }
                });
                child.stderr.on("data", chunk => { if (stderr.length < 65536) stderr += chunk; });
                child.once("error", error => {
                    clearTimeout(timer);
                    if (error.name !== "AbortError") reject(error);
                });
                child.stdin.on("error", () => {}); // Exit status carries startup/input failures.
                child.once("close", code => {
                    clearTimeout(timer);
                    if (signal?.aborted) return reject(new Error("The survey read was cancelled."));
                    if (exceeded) return reject(new Error("The result is too large for this viewer."));
                    if (stderr.includes("ModuleNotFoundError")) {
                        return reject(new Error("Python needs pandas and openpyxl. Run: python3 -m pip install -r requirements.txt"));
                    }
                    let payload;
                    try { payload = JSON.parse(stdout); } catch {
                        return reject(new Error("The export reader stopped. Check Python, the file format, and the 60-second limit."));
                    }
                    if (code !== 0 || payload.error) return reject(new Error(payload.error || "Export analysis failed."));
                    accept(payload.result);
                });
                child.stdin.end(JSON.stringify(request));
            });
        } catch (error) {
            if (error.code === "ENOENT") continue;
            throw error;
        }
    }
    throw new Error(packaged ? "The packaged survey reader is missing. Update or reinstall the plugin."
        : "Python 3 was not found. Install Python and the packages in requirements.txt.");
}

async function writeRecord(root, record) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = join(root, `${record.profile.id}.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(record, null, 2)); } finally { await file.close(); }
    await rename(temporary, join(root, `${record.profile.id}.json`));
}

async function readRecord(root, id) {
    if (!validId(id)) throw new Error("Select a saved survey.");
    const record = JSON.parse(await readFile(join(root, `${id}.json`), "utf8"));
    if (record.profile?.id !== id || typeof record.profile.title !== "string") {
        throw new Error("The saved profile identity or title is invalid.");
    }
    try { record.view = JSON.parse(await readFile(join(root, "views", `${id}.json`), "utf8")).view; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return record;
}

async function listRecords(root) {
    let files;
    try { files = await readdir(root); } catch (error) {
        if (error.code === "ENOENT") return { surveys: [], warnings: [] };
        throw error;
    }
    const result = [], warnings = [];
    for (const name of files.filter(name => validId(name.replace(/\.json$/, "")) && name.endsWith(".json"))) {
        try {
            const record = await readRecord(root, name.slice(0, -5));
            result.push({ id: record.profile.id, title: record.profile.title, source: record.name });
        } catch (error) {
            if (!(error instanceof SyntaxError) && !["ENOENT", "EACCES", "EPERM"].includes(error.code)
                && error.message !== "The saved profile identity or title is invalid.") throw error;
            warnings.push(`Cannot load saved survey ${name}: ${error.code || "invalid saved JSON or profile"}. The file was not changed.`);
        }
    }
    return { surveys: result.sort((a, b) => a.title.localeCompare(b.title)), warnings };
}

async function body(req) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) throw new Error("The profile request is too large.");
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export async function startViewer(input = {}, options = {}) {
    const root = options.storage || dataRoot();
    const token = randomBytes(32).toString("hex");
    const tickets = new Map();
    const lifetime = new AbortController();
    let current = null, busy = false, connection = null, controller = null;
    let viewWrites = Promise.resolve();
    const authenticate = options.signIn || signIn;
    const connect = options.createDataverse || createDataverse;
    function live(source, signal) {
        if (!connection || ["environment", "tenant", "clientId"].some(k => connection.config[k] !== source[k])) {
            throw new Error("Sign in to this survey's saved environment first. Tokens are not stored across restarts.");
        }
        return connect(connection.config, connection.token, { signal });
    }
    async function snapshot(source, signal) {
        if (source.kind === "dataverse") return live(source, signal).snapshot(source.surveyId);
        const result = await analyze({ ...source, mode: "inspect", capture: true }, { signal });
        return result.snapshot;
    }
    const model = state => ({ snapshot: state.snapshot, profile: state.record.profile,
        population: state.report.scope.populationKey, filters: state.report.scope.filters });
    async function operation(name, request = {}) {
        if (lifetime.signal.aborted) throw new Error("This viewer is closed. Open a new Canvas.");
        if (name === "config") return {
            input, ...await listRecords(root),
            connection: connection ? "Signed in. Select a survey to read." :
                "Not connected. Enter an approved public-client registration and commercial-cloud Dataverse environment. Tokens stay in memory.",
        };
        if (name === "cancel") {
            controller?.abort();
            return { cancelled: Boolean(controller) };
        }
        if (name === "browse") {
            if (request.path !== undefined && typeof request.path !== "string") {
                throw new Error("Select a local folder.");
            }
            const path = resolve(request.path || options.browseRoot || homedir());
            const entries = await readdir(path, { withFileTypes: true });
            return { path, parent: dirname(path), entries: entries
                .filter(entry => !entry.name.startsWith(".") && (entry.isDirectory()
                    || entry.isFile() && [".csv", ".xlsx"].includes(extname(entry.name).toLowerCase())))
                .map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
                .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) };
        }
        if (name === "view") {
            if (!current) throw new Error("Open a survey before saving its reading state.");
            if (current.record.preview) return { saved: false, preview: true };
            const v = request;
            const groupTabs = current.record.profile.fields.filter(f => f.group).map(f => `group:${f.group}`);
            if (!["overview", "questions", "contacts", "method", ...groupTabs].includes(v.tab)
                || ![v.scroll, v.listScroll, v.answerPage].every(n => Number.isSafeInteger(n) && n >= 0)
                || ![v.answerSearch, v.questionSearch].every(s => typeof s === "string" && s.length <= 1000)
                || (v.selected && !current.record.profile.fields.some(f => f.id === v.selected))) {
                throw new Error("Invalid reading state.");
            }
            if (v.answerSearch || v.questionSearch) {
                // Search terms may contain personal data. Do not persist them.
                v.answerSearch = ""; v.questionSearch = "";
            }
            const record = { profile: { id: current.record.profile.id }, view: {
                tab: v.tab, selected: v.selected, scroll: v.scroll, listScroll: v.listScroll,
                answerPage: v.answerPage, filters: current.report.scope.filters,
                population: current.report.scope.populationKey,
            } };
            const write = viewWrites.then(() => writeRecord(join(root, "views"), record));
            // Report each failure to its caller, but let later saves retry.
            viewWrites = write.catch(() => {});
            await write;
            if (current?.record.profile.id === record.profile.id) current.record.view = record.view;
            return { saved: true };
        }
        if (name === "scope") {
            if (!current) throw new Error("Open an export with View report or confirm its profile first.");
            return current.report;
        }
        if (name === "answers" || name === "contacts") {
            if (!current) throw new Error("Load a survey first.");
            if (name === "contacts" && current.record.preview) {
                throw new Error("Review and save the consent mapping before viewing contacts.");
            }
            if (request.sha256 && request.sha256 !== current.report.source.sha256) {
                throw new Error("This view is stale. Use the current report.");
            }
            return analyze({ ...model(current), mode: name, key: current.record.key,
                sha256: current.report.source.sha256, question: request.question }, { signal: lifetime.signal });
        }
        if (busy) throw new Error("A survey change is in progress. Wait for it to finish.");
        busy = true;
        controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, lifetime.signal]);
        try {
            if (name === "signin") {
                const config = { environment: environment(request.environment),
                    tenant: guid(request.tenant), clientId: guid(request.clientId) };
                const candidate = await authenticate(config);
                signal.throwIfAborted();
                const surveys = await connect(candidate.config, candidate.token, { signal }).surveys();
                signal.throwIfAborted();
                connection = candidate;
                return { surveys, config: candidate.config };
            }
            if (name === "inspect" || name === "review") {
                if (name === "review" && !current) throw new Error("Open a report before reviewing its settings.");
                const saved = name === "review" ? current.record : request.id ? await readRecord(root, request.id) : null;
                const source = request.surveyId ? {
                    kind: "dataverse", ...connection?.config, surveyId: guid(request.surveyId),
                } : request.path ? {
                    source: resolve(request.path.replace(/^~(?=[/\\])/, homedir())),
                    sheet: request.sheet ?? 0, header: request.header ?? 1,
                } : saved?.source || current?.record.source;
                if (!source) throw new Error("Enter the full path of a local CSV or XLSX file.");
                if (saved && saved.source.kind !== source.kind && (saved.source.kind || source.kind)) {
                    throw new Error("Export and live profiles have separate identities. Create a new profile for this source.");
                }
                const captured = name === "review" ? current.snapshot : await snapshot(source, signal);
                const proposal = await analyze({ snapshot: captured, mode: "inspect" }, { signal });
                signal.throwIfAborted();
                const ticket = randomUUID();
                tickets.clear();
                tickets.set(ticket, { source, snapshot: captured, sha256: proposal.source.sha256, saved,
                    profile: proposal.profile });
                return { ...proposal, ticket, previous: saved?.profile || null };
            }
            if (name === "confirm" || name === "preview") {
                const proposal = tickets.get(request.ticket);
                if (!proposal) throw new Error("Inspect this export again before confirming its profile.");
                const preview = name === "preview";
                const compatible = proposal.saved?.profile.headers.join("\0") === proposal.profile.headers.join("\0")
                    && proposal.saved.profile.sourceDefinition === proposal.profile.sourceDefinition
                    && proposal.saved.profile.sourceIdentity === proposal.profile.sourceIdentity;
                const profile = { ...(preview ? compatible ? proposal.saved.profile : proposal.profile : request.profile),
                    id: proposal.saved?.profile.id || randomUUID(), version: 1 };
                const record = { profile, source: proposal.source,
                    key: proposal.saved?.key || randomBytes(32).toString("hex"), preview };
                const report = await analyze({ snapshot: proposal.snapshot, profile, mode: "report",
                    sha256: proposal.sha256 }, { signal });
                signal.throwIfAborted();
                record.name = report.source.name;
                if (!preview) await writeRecord(root, record);
                signal.throwIfAborted();
                report.preview = preview;
                if (preview) report.contactEnabled = false;
                current = { record, report, snapshot: proposal.snapshot };
                tickets.delete(request.ticket);
                return report;
            }
            if (name === "open" || name === "refresh" || name === "filter") {
                const record = name === "open" ? await readRecord(root, request.id) : current?.record;
                if (!record) throw new Error("Select a saved survey or open an export.");
                const filters = request.filters ?? (name === "open" ? record.view?.filters || {} : current.report.scope.filters);
                const population = request.population ?? (name === "open" ? record.view?.population || "eligible" : current.report.scope.populationKey);
                const captured = name === "filter" ? current.snapshot : await snapshot(record.source, signal);
                const report = await analyze({ snapshot: captured, profile: record.profile,
                    mode: "report", filters, population }, { signal });
                signal.throwIfAborted();
                report.preview = Boolean(record.preview);
                if (record.preview) report.contactEnabled = false;
                current = { record, report, snapshot: captured };
                if (name === "open") report.view = record.view;
                return report;
            }
            throw new Error("Unknown survey operation.");
        } finally { busy = false; controller = null; }
    }

    const server = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
        if (req.headers.host !== `127.0.0.1:${server.address().port}`) {
            res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" })
                .end(JSON.stringify({ error: "Local access only." })); return;
        }
        const url = new URL(req.url, "http://127.0.0.1");
        try {
            if (assets.has(url.pathname) && req.method === "GET") {
                const [file, type] = assets.get(url.pathname);
                res.writeHead(200, { "Content-Type": type }).end(await readFile(join(here, file)));
                return;
            }
            if (url.pathname === "/favicon.ico") { res.writeHead(204).end(); return; }
            if (req.headers.authorization !== `Bearer ${token}`) {
                res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" })
                    .end(JSON.stringify({ error: "Reopen the Canvas to restore access." })); return;
            }
            if (req.method !== "POST" || !/^\/api\/[a-z]+$/.test(url.pathname)) {
                res.writeHead(405, { Allow: "POST", "Content-Type": "application/json; charset=utf-8" })
                    .end(JSON.stringify({ error: "Use an authenticated local request." })); return;
            }
            const result = await operation(url.pathname.slice(5), await body(req));
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(result));
        } catch (error) {
            const message = error.code ? `Local storage or file access failed (${error.code}).`
                : error instanceof SyntaxError ? "Invalid JSON request or saved profile." : error.message;
            res.writeHead(422, { "Content-Type": "application/json; charset=utf-8" })
                .end(JSON.stringify({ error: message }));
        }
    });
    await new Promise((accept, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", accept);
    });
    async function close() {
        lifetime.abort();
        controller?.abort();
        connection = null;
        tickets.clear();
        current = null;
        server.closeAllConnections();
        await new Promise((accept, reject) => server.close(error => {
            if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
            else accept();
        }));
        await viewWrites;
    }
    return { server, operation, close, url: `http://127.0.0.1:${server.address().port}/#${token}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    if (args.length && (args[0] !== "--source" || args.length !== 2)) {
        process.stderr.write("Usage: node extensions/customer-voice/server.mjs [--source /path/export.xlsx]\n");
        process.exit(1);
    }
    const viewer = await startViewer(args[0] ? { source: args[1] } : {});
    process.stdout.write(`${viewer.url}\n`);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
        viewer.close().catch(error => {
            process.stderr.write(`Cannot close the viewer (${error.code || error.name}).\n`);
            process.exitCode = 1;
        });
    });
}
