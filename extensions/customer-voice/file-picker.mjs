import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, isAbsolute, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

export async function pickExport({ signal } = {}) {
    const binary = join(here, "runtime", process.platform === "linux" ? "cv-file-picker/cv-file-picker" : "cv-file-picker");
    const packaged = existsSync(join(here, "runtime", "platform.json"));
    let command, args;
    if (process.platform === "win32") {
        if (!process.env.SystemRoot) throw new Error("Windows SystemRoot is not set. Cannot locate the native file dialog.");
        command = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        args = ["-NoProfile", "-NonInteractive", "-STA", "-Command",
            await readFile(join(here, "file-picker.ps1"), "utf8")];
    } else if (["darwin", "linux"].includes(process.platform)) {
        if (packaged && !existsSync(binary)) throw new Error("The native file picker is missing. Update the Customer Voice plugin.");
        command = packaged ? binary : process.platform === "darwin" ? "/usr/bin/swift" : process.env.CUSTOMER_VOICE_PYTHON || "python3";
        args = packaged ? [] : [join(here, process.platform === "darwin" ? "file-picker.swift" : "file-picker-linux.py")];
    } else throw new Error("Native file selection is supported on macOS, Windows, Ubuntu, and Fedora.");
    let stdout;
    try {
        ({ stdout } = await run(command, args, { signal, timeout: 300000, maxBuffer: 65536, windowsHide: true }));
    } catch (error) {
        if (error.stdout) {
            const result = JSON.parse(error.stdout);
            if (result.error) throw new Error(result.error);
        }
        throw error;
    }
    const { path } = JSON.parse(stdout);
    if (path === null) return { path: null };
    if (typeof path !== "string" || !isAbsolute(path) || ![".csv", ".xlsx"].includes(extname(path).toLowerCase())) {
        throw new Error("Select a CSV or XLSX export.");
    }
    return { path };
}
