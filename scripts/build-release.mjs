import { cp, mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supported = ["darwin-arm64", "win32-x64", "win32-arm64", "linux-x64", "linux-arm64"];
const target = `${process.platform}-${process.arch}`;
if (!supported.includes(target)) {
    throw new Error(`Unsupported release target: ${target}.`);
}
const output = join(root, "dist", "plugin");
try {
    await stat(output);
    throw new Error("dist/plugin already exists. Use a fresh checkout for a release build.");
} catch (error) {
    if (error.code !== "ENOENT") throw error;
}
const python = process.env.CUSTOMER_VOICE_BUILD_PYTHON || (process.platform === "win32" ? "python" : "python3");
const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit",
        shell: process.platform === "win32" && command === "npm" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}.`);
};
const engineArch = runCapture(python, ["-c",
    "import sys, sysconfig, platform; print(sysconfig.get_platform().split('-')[-1].lower() if sys.platform == 'win32' else platform.machine().lower())"]);
const normalizedEngineArch = { aarch64: "arm64", arm64: "arm64", amd64: "x64", x86_64: "x64" }[engineArch];
if (normalizedEngineArch !== process.arch && !(target === "win32-arm64" && normalizedEngineArch === "x64")) {
    throw new Error(`Reader architecture ${engineArch} does not match ${target}.`);
}
run("npm", ["ci", "--prefix", "extensions/customer-voice", "--omit=dev", "--ignore-scripts"]);
run(python, ["-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
    "--name", "cv-engine", "--distpath", ".build/engine",
    "--workpath", ".build/work", "--specpath", ".build",
    "--add-data", `${join(root, "profiles")}:profiles`,
    "--hidden-import", "openpyxl", "extensions/customer-voice/engine.py"]);
await mkdir(output, { recursive: true });
for (const name of [".github/plugin", "profiles", "skills", "README.md"]) {
    await cp(join(root, name), join(output, name), { recursive: true, verbatimSymlinks: true });
}
const extension = join(output, "extensions", "customer-voice");
await mkdir(extension, { recursive: true });
for (const name of ["extension.mjs", "server.mjs", "dataverse.mjs", "file-picker.mjs", "file-picker.ps1", "index.html",
    "viewer.mjs", "viewer.css", "package.json", "package-lock.json", "node_modules"]) {
    await cp(join(root, "extensions", "customer-voice", name), join(extension, name), { recursive: true, verbatimSymlinks: true });
}
await cp(join(root, ".build", "engine", "cv-engine"), join(extension, "runtime", "cv-engine"),
    { recursive: true, verbatimSymlinks: true });
if (process.platform === "darwin") {
    run("/usr/bin/swiftc", ["extensions/customer-voice/file-picker.swift", "-o",
        join(extension, "runtime", "cv-file-picker")]);
} else if (process.platform === "linux") {
    run(python, ["-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
        "--name", "cv-file-picker", "--distpath", ".build/picker",
        "--workpath", ".build/picker-work", "--specpath", ".build",
        "extensions/customer-voice/file-picker-linux.py"]);
    await cp(join(root, ".build", "picker", "cv-file-picker"), join(extension, "runtime", "cv-file-picker"),
        { recursive: true, verbatimSymlinks: true });
}
run(python, ["scripts/collect-licenses.py", join(output, "licenses")]);
await writeFile(join(extension, "runtime", "platform.json"),
    JSON.stringify({ platform: process.platform, arch: process.arch, engineArch: normalizedEngineArch }) + "\n");
const manifest = JSON.parse(await readFile(join(root, ".github/plugin/plugin.json"), "utf8"));
if (target !== "darwin-arm64") {
    manifest.name = `customer-voice-${target.replace("win32", "windows")}`;
    await writeFile(join(output, ".github/plugin/plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
}
await writeFile(join(output, "release.json"), JSON.stringify({
    version: manifest.version, platform: process.platform, arch: process.arch,
    engineArch: normalizedEngineArch,
    sourceCommit: process.env.GITHUB_SHA || runCapture("git", ["rev-parse", "HEAD"]),
}, null, 2) + "\n");
// GitHub rejects individual files above 100 MB. Catch this before publication.
async function checkSize(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) await checkSize(path);
        else if (entry.isFile() && (await stat(path)).size >= 100 * 1024 * 1024) {
            throw new Error(`Release file exceeds GitHub's file limit: ${path}`);
        }
    }
}
function runCapture(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
    if (result.error || result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message || result.stderr?.trim() || result.status}`);
    }
    return result.stdout.trim();
}
await checkSize(output);
console.log(`Built ${manifest.version} for ${process.platform}-${process.arch}: ${output}`);
