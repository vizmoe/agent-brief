import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runtime = fileURLToPath(new URL("../../scripts/codex-brief.mts", import.meta.url));

async function withFixture(callback: (directory: string, env: NodeJS.ProcessEnv) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "agent-brief-retired-"));
  const env = { ...process.env, CODEX_HOME: directory, PLUGIN_DATA: join(directory, "data"),
    CODEX_BRIEF_STATE_DIR: join(directory, "state"), CODEX_BRIEF_LOG_PATH: join(directory, "brief.log"),
    CODEX_BRIEF_CONFIG: join(directory, "config.json"), AGENT_BRIEF_CONFIG: "",
    AGENT_BRIEF_REMOVAL_MARKER: join(directory, "credential-command-ran") };
  try { await callback(directory, env); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

// Keep stdin open: unsupported CLI options must exit without waiting for hook JSON.
function run(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [runtime, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI did not exit with stdin open")); }, 5_000);
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

test("the retired signal option fails promptly without creating notification state", async () => {
  await withFixture(async (directory, env) => {
    await writeFile(env.CODEX_BRIEF_CONFIG!, JSON.stringify({ enabled: false }));
    const before = await readdir(directory);
    const result = await run(["--signal", "user-presence"], env);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Unknown codex_brief option: --signal/);
    assert.deepEqual(await readdir(directory), before);
  });
});

for (const [mode, kind, event] of [
  ["--worker", "user-presence", "user-presence"],
  ["--deliver", "user-presence", "user-presence"],
  ["--deliver", "stop", "user-presence"],
  ["--play", "user-presence", "user-presence"],
  ["--play", "stop", "user-presence"],
]) {
  test(`${mode} ignores persisted retired work (${kind}/${event})`, async () => {
    await withFixture(async (directory, env) => {
      // A local failing credential command records attempts without using credentials or a service.
      await writeFile(env.CODEX_BRIEF_CONFIG!, JSON.stringify({ summary: false,
        bark: { serverUrl: "http://127.0.0.1:1", deviceKey: '!{printf touched > "$AGENT_BRIEF_REMOVAL_MARKER"; exit 1}' } }));
      const sessionId = "retired-session";
      const session = join(env.CODEX_BRIEF_STATE_DIR!, "sessions", createHash("sha256").update(sessionId).digest("hex").slice(0, 32));
      await mkdir(session, { recursive: true });
      await writeFile(join(session, `${kind === "stop" ? "root" : kind}.pointer.json`), JSON.stringify({ token: "current" }));
      const payload = join(directory, "persisted.json");
      await writeFile(payload, JSON.stringify({ kind, event, sessionId, turnId: "turn", eventId: "retired",
        token: "current", text: "Obsolete reminder", createdAt: Date.now(), dueAt: Date.now() }));
      // An absent audio file cannot produce sound even if a regression reaches the native player.
      const result = await run([mode, payload, ...(mode === "--play" ? [join(directory, "absent.mp3")] : [])], env);
      assert.equal(result.code, 0, result.stderr);
      await assert.rejects(access(env.AGENT_BRIEF_REMOVAL_MARKER!));
      await assert.rejects(access(join(env.CODEX_BRIEF_STATE_DIR!, "delivered")));
      if (mode === "--worker") await assert.rejects(access(payload), "retired jobs should be discarded");
    });
  });
}
