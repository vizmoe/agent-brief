import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test("packaged Codex hooks run detached delivery, cancel stale work and share safe Bark transport", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-brief-codex-"));
  const requests: Array<Record<string, unknown>> = [];
  let responseCode = 200;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    assert.equal(request.url, "/push");
    requests.push(JSON.parse(body));
    response.writeHead(responseCode, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 200, data: [{ code: 200 }] }));
  });
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { if (await check()) return; await delay(20); }
    assert.fail("Timed out waiting for packaged Codex worker");
  };
  const state = join(directory, "data/state");
  async function jobsFinished() {
    const sessions = await readdir(join(state, "sessions")).catch(() => []);
    for (const session of sessions) {
      const jobs = await readdir(join(state, "sessions", session, "jobs")).catch(() => []);
      if (jobs.length) return false;
    }
    return true;
  }
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const { stdout } = await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], { cwd: root });
    const [{ filename }] = JSON.parse(stdout);
    await exec("tar", ["-xzf", join(directory, filename), "-C", directory]);
    const packed = join(directory, "package");
    await assert.rejects(access(join(packed, "node_modules")));
    const configPath = join(directory, "config.json");
    const log = join(directory, "brief.log");
    await mkdir(join(directory, "profile"));
    const env = { ...process.env, HOME: join(directory, "profile"), CODEX_HOME: join(directory, "profile"),
      PLUGIN_ROOT: packed, PLUGIN_DATA: join(directory, "data"), CODEX_BRIEF_CONFIG: configPath,
      CODEX_BRIEF_LOG_PATH: log, CODEX_BRIEF_OBSERVER: "0", CODEX_BRIEF_STATE_DIR: state,
      AGENT_BRIEF_CONFIG: "", PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
    const config = { language: "en", summary: false, bark: {
      serverUrl: `http://127.0.0.1:${address.port}`, deviceKey: "!{printf fixture-device}",
    } };
    await writeFile(configPath, JSON.stringify(config));
    const hooks = JSON.parse(await readFile(join(packed, "hooks/hooks.json"), "utf8"));
    const hook = (name: string, extra: Record<string, unknown> = {}) => new Promise<void>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", hooks.hooks[name][0].hooks[0].command], { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", part => { stdout += part.toString(); });
      child.stderr.on("data", part => { stderr += part.toString(); });
      child.on("error", reject);
      child.on("close", code => {
        try { assert.equal(code, 0, stderr); assert.equal(stdout, ""); assert.equal(stderr, ""); resolve(); }
        catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify({ session_id: "packaged", turn_id: "turn", hook_event_name: name, ...extra }));
    });
    await hook("SessionStart");
    await assert.rejects(access(join(env.CODEX_HOME, "codex-brief/runtime.json")));
    const sessions = await readdir(join(state, "sessions"));
    assert.equal(sessions.length, 1);
    assert.deepEqual((await readdir(join(state, "sessions", sessions[0]))).sort(),
      ["permission.pointer.json", "question.pointer.json", "root.pointer.json"]);
    await hook("UserPromptSubmit", { prompt: "Deploy the update" });
    const question = { tool_name: "request_user_input", tool_input: { questions: [{ question: "Choose staging or production." }] } };
    await hook("PreToolUse", { ...question, tool_use_id: "first" });
    assert.equal(requests.length, 0, "foreground hook must return before delayed background delivery");
    await until(async () => requests.length === 1 && await jobsFinished());
    assert.match(String(requests[0].body), /^Codex.*Choose staging or production/);
    assert.deepEqual(requests[0].device_keys, ["fixture-device"]);
    assert.equal(requests[0].title, "Codex · Input required");

    await hook("PreToolUse", { ...question, tool_use_id: "cancelled" });
    await hook("Interrupt");
    await until(jobsFinished);
    assert.equal(requests.length, 1, "interrupt cancels the pending question before transport");

    responseCode = 503;
    await hook("PreToolUse", { ...question, tool_use_id: "failed" });
    await until(async () => requests.length === 2 && await jobsFinished());
    const logs = await readFile(log, "utf8");
    assert.match(logs, /bark_delivery_failed/);
    assert.match(logs, /503/);
    assert.doesNotMatch(logs, /fixture-device|printf|Choose staging/);

    // Exercise the actual CLI summary invocation against a local executable fixture.
    // No Codex service, authentication, or model generation is claimed by this test.
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (!args.includes("--ignore-user-config") || !args.includes("--ephemeral") || args[args.indexOf("-m") + 1] !== "fixture-model" || !args.some(value => value.includes("Lead with checks."))) process.exit(2);
process.stdin.resume();
process.stdin.on("end", () => fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ event: "idle", text: "Codex completed the deployment checks.", actionRequired: false })));
`, { mode: 0o700 });
    env.PATH = `${bin}:${env.PATH}`;
    responseCode = 200;
    await writeFile(configPath, JSON.stringify({ ...config, summary: { model: "fixture-model", instructions: "Lead with checks." }, notify: { idleDelaySeconds: 0, minTaskSeconds: 0 } }));
    await hook("Stop", { last_assistant_message: "Deployment checks passed." });
    await until(async () => requests.length === 3 && await jobsFinished());
    assert.equal(requests[2].body, "Codex completed the deployment checks.");

    // A failed ordinary delivery remains claimed; replay must not notify twice.
    responseCode = 503;
    const pointer = JSON.parse(await readFile(join(state, "sessions", sessions[0], "root.pointer.json"), "utf8"));
    const replay = join(directory, "replay.json");
    await writeFile(replay, JSON.stringify({ kind: "stop", event: "error", text: "Codex needs attention.",
      sessionId: "packaged", turnId: "turn", eventId: "replayed-error", token: pointer.token, createdAt: Date.now() }));
    const deliver = () => exec(process.execPath, [join(packed, "scripts/codex-brief.mts"), "--deliver", replay], { cwd: directory, env });
    await deliver();
    assert.equal(requests.length, 4);
    assert.equal(requests[3].title, "Codex · Error");
    assert.equal(requests[3].body, "Codex needs attention.");
    await deliver();
    assert.equal(requests.length, 4, "failed delivery stays deduplicated on replay");
    await hook("SessionEnd");
  } finally {
    await until(jobsFinished).catch(() => {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
