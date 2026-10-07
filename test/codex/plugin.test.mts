import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseConfig, loadConfig } from "../../adapters/codex/config.mts";
import {
  resolveValue,
  resolveDeliverySecrets,
} from "../../adapters/codex/credentials.mts";
import {
  parseSummaryOutput,
  fallbackSummary,
} from "../../adapters/codex/summary.mts";
import {
  processHookEvent,
  jobIsCurrentForTest,
} from "../../adapters/codex/runtime.mts";
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\''") + "'";

const config = { fishAudio: { apiKey: "fixture", voiceId: "voice" } };
const nodeExpression = (code: string) =>
  `!{${shellQuote(process.execPath)} -e ${shellQuote(code)}}`;

test("Codex legacy fields normalize to shared config without resolving credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brief-config-"));
  try {
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ fishAudio: { apiKey: "!{exit 9}", voiceId: "voice" },
      quietHours: { start: "23:00", end: "08:00" }, bark: { serverUrl: "https://bark.example", deviceKey: "device" } }));
    const loaded = await loadConfig(path);
    assert.equal(loaded.backends.fishAudio.apiKey, "!{exit 9}");
    assert.equal(loaded.backends.fishAudio.referenceId, "voice");
    assert.equal(loaded.backends.fishAudio.model, "s2.1-pro-free");
    assert.equal(loaded.backends.bark.deviceKeys, "device");
    assert.equal(loaded.notifyPolicy.quietHours.start, "23:00");
    assert.equal((await loadConfig(join(directory, "absent.json"))).enabled, false);
    const current = parseConfig({ summary: false, bark: { serverUrl: "https://bark.example", deviceKeys: ["one", "two"] } });
    assert.deepEqual(current.deliveryBackends, ["bark"]);
    assert.equal(current.summary.enabled, false);
    assert.deepEqual(current.backends.bark.deviceKeys, ["one", "two"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("credential values support literal strings and whole command references", async () => {
  assert.equal(
    await resolveValue("literal !{ignored}", "test"),
    "literal !{ignored}",
  );
  assert.equal(
    await resolveValue(
      nodeExpression('process.stdout.write("key-value\\n")'),
      "test",
    ),
    "key-value",
  );
  assert.deepEqual(
    await resolveDeliverySecrets(
      parseConfig({
        fishAudio: {
          apiKey: nodeExpression('process.stdout.write("resolved-key")'),
          voiceId: "voice",
        },
      }),
      "fishaudio",
    ).then(value => value.fishAudio),
    { apiKey: "resolved-key", referenceId: "voice", model: "s2.1-pro-free" },
  );
});

test("credential failures cannot expose stdout, stderr or command text", async () => {
  const expression = nodeExpression(
    'process.stdout.write("secret-stdout");process.stderr.write("secret-stderr");process.exit(3)',
  );
  await assert.rejects(
    resolveValue(expression, "fishAudio.apiKey"),
    (error: Error) => {
      assert.match(error.message, /credential command failed/);
      assert.doesNotMatch(error.message, /secret-|process\./);
      return true;
    },
  );
  for (const code of [
    'process.stdout.write("")',
    'process.stdout.write("one\\ntwo")',
    'process.stdout.write("x".repeat(20000))',
  ]) {
    await assert.rejects(resolveValue(nodeExpression(code), "test"));
  }
  await assert.rejects(resolveValue("!{}", "test"), /invalid command/);
  await assert.rejects(
    resolveValue("!{unterminated", "test"),
    /invalid command/,
  );
});

test("summary can remain silent and can report failures without fabricating an action", () => {
  assert.deepEqual(
    parseSummaryOutput('{"event":"idle","text":null,"actionRequired":false}'),
    { event: "idle", text: null, actionRequired: false },
  );
  assert.equal(
    parseSummaryOutput(
      '{"event":"question","text":null,"actionRequired":true}',
    ),
    undefined,
  );
  assert.ok(
    parseSummaryOutput(
      JSON.stringify({
        event: "error",
        text: "Codex 的构建仍被依赖下载失败阻塞。",
        actionRequired: false,
      }),
    ),
  );
  assert.equal(
    parseSummaryOutput(
      JSON.stringify({
        event: "idle",
        text: "Codex 已完成检查。下一步建议你重启应用。",
        actionRequired: false,
      }),
    ),
    undefined,
  );
  assert.ok(
    parseSummaryOutput(
      JSON.stringify({
        event: "idle",
        text: "Codex 已完成方案比较，整理了三项建议及各自成本。",
        actionRequired: false,
      }),
    ),
  );
  assert.deepEqual(
    fallbackSummary({
      language: "zh-CN",
      trigger: "stop",
      session: { id: "test", rootOnly: true },
      state: {},
      recentMessages: ["是否要继续优化？"],
    }),
    { event: "idle", text: null, actionRequired: false },
  );
});

test("Interrupt and SessionEnd cancel an earlier Stop notification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brief-cancel-"));
  const previous = process.env.CODEX_BRIEF_STATE_DIR;
  process.env.CODEX_BRIEF_STATE_DIR = directory;
  try {
    for (const hook_event_name of ["Interrupt", "SessionEnd"]) {
      const base = { session_id: hook_event_name, turn_id: "turn" };
      const [job] = await processHookEvent(
        {
          ...base,
          hook_event_name: "Stop",
          last_assistant_message: "检查完成。",
        },
        1000,
        async () => {},
      );
      assert.equal(await jobIsCurrentForTest(job!), true);
      await processHookEvent(
        { ...base, hook_event_name },
        1100,
        async () => {},
      );
      assert.equal(await jobIsCurrentForTest(job!), false);
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX_BRIEF_STATE_DIR;
    else process.env.CODEX_BRIEF_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});



test("packaged hook command works outside its root and writes only to plugin data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brief-package-"));
  try {
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify(config));
    const plugin = resolve(".");
    const hooks = JSON.parse(
      await readFile(join(plugin, "hooks/hooks.json"), "utf8"),
    );
    const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
    const run = spawnSync("/bin/sh", ["-c", command], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 5000,
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "package-test",
        turn_id: "turn",
        prompt: "Run checks",
      }),
      env: {
        ...process.env,
        CODEX_BRIEF_OBSERVER: "0",
        PLUGIN_ROOT: plugin,
        PLUGIN_DATA: join(directory, "data"),
        CODEX_BRIEF_CONFIG: path,
        CODEX_BRIEF_LOG_PATH: join(directory, "brief.log"),
      },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "");
    assert.equal(run.stderr, "");
    assert.equal(
      (await readdir(join(directory, "data/state/sessions"))).length,
      1,
    );
    assert.ok(hooks.hooks.Interrupt);
    assert.ok(hooks.hooks.SessionEnd);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
