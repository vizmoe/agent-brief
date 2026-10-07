import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { parseConfig as codexConfig } from "../adapters/codex/config.mts";
import { parseConfig as piConfig } from "../adapters/pi/config.ts";
import { resolveDeliverySecrets } from "../adapters/codex/credentials.mts";
import { createFishAudioSender } from "../core/backends.ts";

test("the core has no dependency on either host, including type-only imports", async () => {
  const root = new URL("../core/", import.meta.url);
  for (const name of await readdir(root)) {
    const source = await readFile(new URL(name, root), "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\()(["'])([^"']+)\1/g)) {
      assert.ok(match[2].startsWith("node:") || match[2].startsWith("./"), `${name} imported host dependency ${match[2]}`);
    }
  }
});

test("both host configs select the same core backends without running disabled credentials", async () => {
  const raw = { enabled: true, language: "en", summary: false as const, fishAudio: false,
    bark: { serverUrl: "https://bark.example", deviceKeys: ["one", "two"] },
    notify: { idleDelaySeconds: 4, minTaskSeconds: 2, quietHours: { start: "22:00", end: "07:00" } } };
  for (const config of [piConfig(raw), codexConfig(raw)]) {
    assert.deepEqual(config.deliveryBackends, ["bark"]);
    assert.equal(config.summary.enabled, false);
    assert.equal(config.notifyPolicy.idleDelayMs, 4000);
    assert.equal(config.notifyPolicy.ignoreShortTasksSeconds, 2);
    assert.deepEqual(config.backends.bark.deviceKeys, ["one", "two"]);
  }
  const legacy = codexConfig({ fishAudio: { voiceId: "legacy", referenceId: "canonical", apiKey: "literal" },
    bark: { deviceKey: "old", deviceKeys: ["new"], serverUrl: "https://bark.example" } });
  assert.equal(legacy.backends.fishAudio.referenceId, "canonical");
  assert.deepEqual(legacy.backends.bark.deviceKeys, ["new"]);
});

test("Codex voice defaults and identity survive shared Fish transport", async t => {
  let request: RequestInit | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    request = init;
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
  });
  let played = false;
  const send = createFishAudioSender(async path => {
    assert.deepEqual(await readFile(path), Buffer.from([1, 2, 3]));
    played = true;
  });
  const config = codexConfig({ fishAudio: { apiKey: "fixture-key", voiceId: "fixture-voice" } });
  const result = await send({ type: "idle", title: "Codex", summary: "Codex completed the checks.", barkLevel: "active" },
    config, await resolveDeliverySecrets(config, "fishaudio"));
  assert.equal(result.ok, true);
  assert.equal(played, true);
  assert.equal(new Headers(request?.headers).get("model"), "s2.1-pro-free");
  const body = JSON.parse(String(request?.body));
  assert.equal(body.reference_id, "fixture-voice");
  assert.equal(body.text, "Codex completed the checks.");
});
