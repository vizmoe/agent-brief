import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parseConfig as parse, loadConfig as load } from "../../core/config.ts";
import { IDLE_DELAY_MS, MIN_TASK_SECONDS, PLAYBACK_TIMEOUT_MS } from "../../core/policy.ts";
import { isRecord } from "../../core/util.ts";
import type { NotifyConfig } from "../../core/types.ts";

export type UserConfig = NotifyConfig;
export const POLICY = Object.freeze({
  idleDelayMs: IDLE_DELAY_MS,
  questionDelayMs: 750,
  ignoreShortTasksSeconds: MIN_TASK_SECONDS,
  summaryModel: "gpt-5.6-luna",
  summaryTimeoutMs: 45_000,
  playbackTimeoutMs: PLAYBACK_TIMEOUT_MS,
  secretTimeoutMs: 15_000,
  secretMaxBytes: 16_384,
});
export const FREE_FISH_MODEL = "s2.1-pro-free";
export const userDirectory = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "codex-brief");
export const configPath = () => process.env.AGENT_BRIEF_CONFIG || process.env.CODEX_BRIEF_CONFIG || join(userDirectory(), "config.json");

/** Translate the native Codex schema at the adapter; shared core uses one schema. */
export function parseConfig(raw: unknown, path = configPath()): UserConfig {
  if (!isRecord(raw)) return parse(raw, path);
  const fish = isRecord(raw.fishAudio) ? raw.fishAudio : undefined;
  const bark = isRecord(raw.bark) ? raw.bark : undefined;
  const notify = isRecord(raw.notify) ? raw.notify : {};
  const config = parse({
    ...raw,
    fishAudio: fish ? { ...fish, referenceId: fish.referenceId ?? fish.voiceId, model: fish.model ?? FREE_FISH_MODEL } : raw.fishAudio,
    bark: bark ? { ...bark, deviceKeys: bark.deviceKeys ?? bark.deviceKey } : raw.bark,
    notify: { ...notify, quietHours: notify.quietHours ?? raw.quietHours },
  }, path);
  config.backends.fishAudio.speed = 1.08;
  config.backends.fishAudio.latency = "low";
  config.notifyPolicy.quietHours.allowDuringQuietHours = ["permission", "question", "error"];
  return config;
}

export async function loadConfig(path = configPath()): Promise<UserConfig> {
  try {
    if (existsSync(path)) return parseConfig(JSON.parse(readFileSync(path, "utf8")), path);
  } catch { /* Invalid configuration stays disabled, without evaluating credentials. */ }
  return load(path);
}
