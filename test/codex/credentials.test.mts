import { parseConfig } from "../../adapters/codex/config.mts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  resolveDeliverySecrets,
  resolveValue,
} from "../../adapters/codex/credentials.mts";
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

const expression = (code: string) =>
  `!{${shellQuote(process.execPath)} -e ${shellQuote(code)}}`;

test("synchronous process errors cannot expose command contents", async () => {
  await assert.rejects(
    resolveValue("!{printf secret-command\0}", "test"),
    (error: Error) => {
      assert.match(error.message, /credential command failed/);
      assert.doesNotMatch(error.message, /secret-command|printf/);
      return true;
    },
  );
});

test("credential commands receive EOF instead of waiting for interactive input", async () => {
  const value = await resolveValue(
    expression(`
    const timer = setTimeout(() => process.exit(2), 700);
    process.stdin.resume();
    process.stdin.on("end", () => {
      clearTimeout(timer);
      process.stdout.write("noninteractive");
    });
  `),
    "test",
  );
  assert.equal(value, "noninteractive");
});

test("a failed credential stops the remaining credential commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brief-credentials-"));
  const marker = join(directory, "unexpected-second-command");
  try {
    const result = await resolveDeliverySecrets(parseConfig({
        fishAudio: {
          apiKey: expression("setTimeout(() => process.exit(1), 200)"),
          voiceId: expression(
            `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); process.stdout.write("voice");`,
          ),
        },
      }), "fishaudio");
    assert.ok(result.failures?.fishaudio);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential timeout terminates descendants, not just the shell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brief-process-tree-"));
  const marker = join(directory, "orphan");
  try {
    const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "orphan"), 700)`;
    const command = expression(`
      require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "inherit" });
      setTimeout(() => {}, 1200);
    `);
    await assert.rejects(resolveValue(command, "test", 200));
    await delay(900);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential commands cannot leave a background child after the shell exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brief-background-child-"));
  const marker = join(directory, "orphan");
  try {
    const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "orphan"), 500)`;
    const command = `!{${shellQuote(process.execPath)} -e ${shellQuote(descendant)} & printf fixture}`;
    assert.equal(await resolveValue(command, "test"), "fixture");
    await delay(650);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
