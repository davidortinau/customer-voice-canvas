import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, isAbsolute, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

export async function pickExport({ signal } = {}) {
    if (process.platform !== "darwin") throw new Error("Native file selection is available on macOS. Enter the export path on this platform.");
    const binary = join(here, "runtime", "cv-file-picker");
    const packaged = existsSync(join(here, "runtime", "platform.json"));
    if (packaged && !existsSync(binary)) throw new Error("The native file picker is missing. Update the Customer Voice plugin.");
    const { stdout } = await run(packaged ? binary : "/usr/bin/swift",
        packaged ? [] : [join(here, "file-picker.swift")],
        { signal, timeout: 300000, maxBuffer: 65536 });
    const { path } = JSON.parse(stdout);
    if (path === null) return { path: null };
    if (typeof path !== "string" || !isAbsolute(path) || ![".csv", ".xlsx"].includes(extname(path).toLowerCase())) {
        throw new Error("Select a CSV or XLSX export.");
    }
    return { path };
}
