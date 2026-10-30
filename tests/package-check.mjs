import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile, readdir, readlink, stat } from "node:fs/promises";
import { join, resolve, dirname, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const plugin = resolve(process.env.CUSTOMER_VOICE_PLUGIN_ROOT || "dist/plugin");
const { startViewer } = await import(pathToFileURL(join(plugin, "extensions/customer-voice/server.mjs")));
const root = await mkdtemp(join(tmpdir(), "cv-package-"));
const previousPath = process.env.PATH;
const previousPython = process.env.CUSTOMER_VOICE_PYTHON;
// A release must not depend on a Python installation or npm at runtime.
process.env.PATH = root;
process.env.CUSTOMER_VOICE_PYTHON = join(root, "no-python");
let viewer;
try {
    const source = join(root, "survey.csv");
    await writeFile(source, "ID,Recommend this product,Written answer\n" +
        Array.from({ length: 40 }, (_, i) => `${i},9,Useful for task ${i}`).join("\n"));
    viewer = await startViewer({}, { storage: join(root, "profiles") });
    const proposal = await viewer.operation("inspect", { path: source });
    assert.equal(proposal.source.rows, 40);
    const report = await viewer.operation("confirm", { ticket: proposal.ticket, profile: proposal.profile });
    assert.equal(report.questions.find(q => q.kind === "nps").metric.value, 100);
    assert.equal((await viewer.operation("refresh")).scope.selected, 40);
    const require = createRequire(join(plugin, "extensions/customer-voice/extension.mjs"));
    assert.ok(require("@azure/msal-node").PublicClientApplication);
    await import(pathToFileURL(require.resolve("open")));
    const excel = process.env.CUSTOMER_VOICE_TEST_XLSX;
    if (excel) {
        const workbook = await viewer.operation("inspect", { path: excel });
        assert.ok(workbook.source.rows > 0);
        assert.ok(workbook.source.columns > 1);
    }
    const release = JSON.parse(await readFile(join(plugin, "release.json"), "utf8"));
    assert.equal(release.platform, process.platform);
    assert.equal(release.arch, process.arch);
    const pickerPath = process.platform === "win32" ? "file-picker.ps1"
        : process.platform === "linux" ? "runtime/cv-file-picker/cv-file-picker" : "runtime/cv-file-picker";
    const picker = await stat(join(plugin, "extensions/customer-voice", pickerPath));
    assert.ok(picker.isFile() && (process.platform === "win32" || (picker.mode & 0o111)),
        "The release must include its native file picker.");
    async function checkLinks(folder) {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
            const path = join(folder, entry.name);
            if (entry.isDirectory()) await checkLinks(path);
            else if (entry.isSymbolicLink()) {
                const link = await readlink(path);
                assert.ok(!isAbsolute(link), `Absolute build-machine link: ${path}`);
                assert.ok(resolve(dirname(path), link).startsWith(plugin + sep), `External link: ${path}`);
                await stat(path); // Also reject broken links.
            }
        }
    }
    // Framework symlinks can point to directories as well as files.
    await checkLinks(plugin);
    async function inventory(folder) {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
            const path = join(folder, entry.name);
            if (entry.isDirectory()) await inventory(path);
            else assert.doesNotMatch(entry.name, /\.(csv|xlsx|xls|pem|pfx)$/i, `Unexpected private input: ${path}`);
        }
    }
    // Exports are never bundled; dependency test fixtures are not source responses.
    for (const folder of [".github", "profiles", "skills"]) await inventory(join(plugin, folder));
    console.log("Packaged runtime passed: import, scoring, manual refresh, and bundled auth dependency, without Python or npm on PATH.");
} finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousPython === undefined) delete process.env.CUSTOMER_VOICE_PYTHON; else process.env.CUSTOMER_VOICE_PYTHON = previousPython;
    await viewer?.close();
    await rm(root, { recursive: true, force: true });
}
