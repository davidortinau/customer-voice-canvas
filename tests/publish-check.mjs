import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Use real Git repositories, but redirect every GitHub URL to this private fixture.
const script = resolve("scripts/publish-release.mjs");
const root = await mkdtemp(join(tmpdir(), "cv-publication-"));
const remote = join(root, "origin.git");
const cwd = join(root, "source");
const git = args => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const targets = ["darwin-arm64", "win32-x64", "win32-arm64", "linux-x64", "linux-arm64"];
try {
    await mkdir(join(cwd, ".github/plugin"), { recursive: true });
    await mkdir(join(cwd, "download"));
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Publication test"]);
    git(["config", "user.email", "test@example.test"]);
    git(["remote", "add", "origin", remote]);
    await copyFile(".github/plugin/marketplace.json", join(cwd, ".github/plugin/marketplace.json"));
    await writeFile(join(cwd, ".github/plugin/plugin.json"), JSON.stringify({ version: "0.4.0" }));
    git(["add", "."]); git(["commit", "-m", "Fixture"]); git(["push", "origin", "main"]);
    const sha = git(["rev-parse", "HEAD"]);
    const env = { ...process.env, REPOSITORY: "test/release", SOURCE_SHA: sha,
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${remote}.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://github.com/test/release.git" };
    async function archive(target, sourceCommit = sha) {
        const folder = join(root, target);
        await mkdir(join(folder, ".github/plugin"), { recursive: true });
        const [platform, arch] = target.split("-");
        await writeFile(join(folder, "release.json"), JSON.stringify({ version: "0.4.0", platform, arch, sourceCommit }));
        await writeFile(join(folder, ".github/plugin/plugin.json"), JSON.stringify({ version: "0.4.0",
            name: target === "darwin-arm64" ? "customer-voice-canvas" : `customer-voice-${target.replace("win32", "windows")}` }));
        execFileSync("tar", ["-czf", join(cwd, "download", `customer-voice-${target}.tar.gz`), "-C", folder, "."]);
    }
    for (const target of targets) await archive(target);
    await archive("linux-arm64", "0".repeat(40));
    const rejected = spawnSync(process.execPath, [script], { cwd, env, encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Wrong source or target/);
    assert.equal(git(["ls-remote", "--heads", "origin"]).split("\n").length, 1, "Invalid artifacts must publish nothing.");
    await archive("linux-arm64");
    // Discard only the extracted scratch fixture from the rejected test.
    await rm(join(cwd, "publish"), { recursive: true, force: true });
    execFileSync(process.execPath, [script], { cwd, env, stdio: "pipe" });
    assert.equal(git(["ls-remote", "--heads", "origin"]).split("\n").length, 6);
    const catalog = JSON.parse(await readFile(join(cwd, ".github/plugin/marketplace.json"), "utf8"));
    assert.equal(catalog.plugins.length, 5);
    assert.equal(new Set(catalog.plugins.map(plugin => plugin.name)).size, 5);
    await rm(join(cwd, "publish"), { recursive: true, force: true });
    execFileSync(process.execPath, [script], { cwd, env, stdio: "pipe" });
    assert.equal(git(["ls-remote", "--heads", "origin"]).split("\n").length, 6);
    console.log("Publication passed against local Git remotes: reject mismatched source before any push, publish five channels, advertise them afterward, and rerun without duplicate entries.");
} finally {
    await rm(root, { recursive: true, force: true });
}
