import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const { CopilotClient, RuntimeConnection } = await import(
    pathToFileURL(resolve(process.env.COPILOT_SDK_MODULE)).href);
const plugin = process.env.CUSTOMER_VOICE_PLUGIN_ROOT
    ? resolve(process.env.CUSTOMER_VOICE_PLUGIN_ROOT)
    : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "cv-native-runtime-"));
const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({
        path: process.env.COPILOT_CLI_EXECUTABLE, args: ["--plugin-dir", plugin],
    }),
    baseDirectory: root, workingDirectory: root, logLevel: "error",
});
try {
    const session = await client.createSession({
        workingDirectory: root, requestCanvasRenderer: true, requestExtensions: true,
        onPermissionRequest: async () => ({ kind: "denied-interactively-by-user" }),
    });
    let declared;
    for (let attempt = 0; attempt < 20; attempt++) {
        await delay(500);
        declared = await session.rpc.canvas.list();
        if (declared.canvases.some(c => c.canvasId === "customer-voice-survey")) break;
    }
    assert.ok(declared.canvases.some(c => c.canvasId === "customer-voice-survey"));
    const opened = await session.rpc.canvas.open({
        canvasId: "customer-voice-survey", instanceId: "native-check", input: {},
    });
    const source = process.env.CUSTOMER_VOICE_TEST_EXPORT;
    if (source) {
        const base = new URL(opened.url);
        const api = async (name, body) => {
            const response = await fetch(new URL(`/api/${name}`, base), {
                method: "POST", headers: {
                    Authorization: `Bearer ${base.hash.slice(1)}`, "Content-Type": "application/json",
                }, body: JSON.stringify(body),
            });
            const value = await response.json();
            assert.equal(response.status, 200, value.error);
            return value;
        };
        const proposal = await api("inspect", { path: source });
        const report = await api("confirm", { ticket: proposal.ticket, profile: proposal.profile });
        assert.equal(report.scope.submitted, 115);
        assert.equal(report.questions.length, 162);
        const routed = await session.rpc.canvas.action.invoke({
            instanceId: "native-check", actionName: "scope", input: {},
        });
        assert.equal(routed.result.source.sha256, report.source.sha256);
        const answers = await session.rpc.canvas.action.invoke({
            instanceId: "native-check", actionName: "answers", input: { question: "c24" },
        });
        assert.equal(answers.result.total, 74);
    }
    await assert.rejects(session.rpc.canvas.open({
        canvasId: "customer-voice-survey", instanceId: "invalid-check", input: { extra: true },
    }), /invalid|schema|additional properties/i);
    await assert.rejects(session.rpc.canvas.action.invoke({
        instanceId: "native-check", actionName: "canvas.open", input: {},
    }), /reserved/i);
    await session.rpc.canvas.close({ instanceId: "native-check" });
    console.log("Native runtime check passed: plugin discovery, registration, open, actions, schema validation, reserved-action rejection, and close. No model call was made.");
} finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
}
