import { execFileSync, spawnSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

// Called only by the publication job after every platform and compatibility check.
const repository = process.env.REPOSITORY;
const sha = process.env.SOURCE_SHA;
const version = JSON.parse(await readFile(".github/plugin/plugin.json", "utf8")).version;
if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "") || !/^[a-f0-9]{40}$/.test(sha || "")) {
    throw new Error("Missing release repository or source commit.");
}
const targets = [
    ["darwin-arm64", "stable"], ["win32-x64", "stable-windows-x64"],
    ["win32-arm64", "stable-windows-arm64"], ["linux-x64", "stable-linux-x64"],
    ["linux-arm64", "stable-linux-arm64"],
];
const catalogPath = ".github/plugin/marketplace.json";
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const descriptions = {
    "win32-x64": "Customer Voice Canvas for Windows x64.",
    "win32-arm64": "Customer Voice Canvas for Windows 11 ARM64. Uses an x64 export reader under Windows emulation.",
    "linux-x64": "Customer Voice Canvas for Ubuntu and Fedora x64 desktops.",
    "linux-arm64": "Customer Voice Canvas for Ubuntu and Fedora ARM64 desktops.",
};
const run = (args, cwd) => execFileSync("git", args, { cwd, stdio: "inherit" });
for (const [target, branch] of targets) {
    const folder = resolve("publish", target);
    await mkdir(folder, { recursive: true });
    execFileSync("tar", ["-xzf", resolve("download", `customer-voice-${target}.tar.gz`), "-C", folder]);
    const release = JSON.parse(await readFile(join(folder, "release.json"), "utf8"));
    const manifest = JSON.parse(await readFile(join(folder, ".github/plugin/plugin.json"), "utf8"));
    const expectedName = target === "darwin-arm64" ? "customer-voice-canvas"
        : `customer-voice-${target.replace("win32", "windows")}`;
    if (release.sourceCommit !== sha || `${release.platform}-${release.arch}` !== target
            || release.version !== version || manifest.version !== version || manifest.name !== expectedName) {
        throw new Error(`Wrong source or target in ${target}.`);
    }
}
// Validate all packages before updating any channel. Updates are append-only.
for (const [target, branch] of targets) {
    const folder = resolve("publish", target);
    run(["init", "-b", branch], folder);
    run(["remote", "add", "origin", `https://github.com/${repository}.git`], folder);
    const refs = execFileSync("git", ["ls-remote", "--heads", "origin", branch], { cwd: folder, encoding: "utf8" });
    if (refs.trim()) {
        run(["fetch", "--depth=1", "origin", branch], folder);
        run(["update-ref", `refs/heads/${branch}`, "FETCH_HEAD"], folder);
    }
    run(["add", "--all", "--force"], folder);
    const diff = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: folder });
    if (diff.status === 1) {
        run(["-c", "user.name=github-actions[bot]", "-c",
            "user.email=41898282+github-actions[bot]@users.noreply.github.com",
            "commit", "-m", `build: publish ${target} from ${sha}`], folder);
    } else if (diff.status !== 0) throw new Error(`Cannot check staged package ${target}.`);
    run(["push", "origin", branch], folder);
}
// Advertise new channels only after their checked branches exist.
for (const [target, branch] of targets.slice(1)) {
    const name = `customer-voice-${target.replace("win32", "windows")}`;
    if (!catalog.plugins.some(plugin => plugin.name === name)) {
        catalog.plugins.push({ name, description: descriptions[target],
            source: { source: "github", repo: repository, ref: branch } });
    }
}
await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
const changed = execFileSync("git", ["diff", "--name-only", "--", catalogPath], { encoding: "utf8" }).trim();
if (changed) {
    run(["add", catalogPath]);
    run(["-c", "user.name=github-actions[bot]", "-c",
        "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "commit", "-m", "build: advertise checked platform packages [skip ci]"]);
    // A concurrent main update is rejected by this normal, non-force push.
    run(["push", "origin", "HEAD:main"]);
}
