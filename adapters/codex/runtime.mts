import { createFishAudioSender, sendBark, sendFishAudio as sendNativeFishAudio } from "../../core/backends.ts";
import { eventPresentation } from "../../core/config.ts";
import { formatDeliveryFailure } from "../../core/diagnostics.ts";
import { isQuietHours, isNotificationAllowedNow, shouldIgnoreShortIdle } from "../../core/policy.ts";
import { resolveDeliverySecrets } from "./credentials.mts";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
} from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  POLICY,
  loadConfig,
  userDirectory,
  configPath,
} from "./config.mts";
import type { UserConfig as NotifyConfig } from "./config.mts";
import type {
  HookEvent,
  WorkerJob,
  WorkerKind,
  SignalName,
  DeliveryBackend,
  TurnMeta,
  EvidenceRecord,
  SummaryContext,
  SummaryResult,
  DeliveryPayload,
  SpawnedJob,
  NotificationEvent,
} from "./types.mts";
import {
  resolveValue,
} from "./credentials.mts";

import {
  isObject,
  sha256,
  stableStringify,
  redactSensitive,
  secretFreeEnvironment,
} from "./shared.mts";
import { clipEvidence, storedEvidence } from "./evidence.mts";
import { runSummaryAgent, runSummaryAgentOnce, fallbackSummary } from "./summary.mts";
const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/codex-brief.mts", import.meta.url));
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const FISH_CREDIT_URL = "https://api.fish.audio/wallet/self/api-credit";
const INPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_ACTIONS = 8;
const MAX_CHANGED_FILES = 12;
const MAX_IDLE_AGE_MS = 90_000;
const MAX_IMPORTANT_AGE_MS = 300_000;
const EVENT_DEDUPE_WINDOW_MS = 2_000;
export const USER_PRESENCE_SPEECH = "Codex 即将使用硬件密钥，请准备触摸确认";
export const USER_PRESENCE_FAILURE_MESSAGE =
  "codex_brief: user-presence notification failed; run the signal outside " +
  "the Codex sandbox and check credential commands, network, and audio access.";

function stateRoot(): string {
  return (
    process.env.CODEX_BRIEF_STATE_DIR ||
    join(process.env.PLUGIN_DATA || userDirectory(), "state")
  );
}

function logPath(): string {
  return process.env.CODEX_BRIEF_LOG_PATH || join(userDirectory(), "brief.log");
}

function buildUserPresenceJob(
  now = Date.now(),
  sessionId = process.env.CODEX_THREAD_ID?.trim() || "manual-user-presence",
): WorkerJob {
  const eventId = sha256(
    `signal:user-presence:${sessionId}:${Math.floor(
      now / EVENT_DEDUPE_WINDOW_MS,
    )}`,
  );
  return {
    kind: "user-presence",
    eventId,
    sessionId,
    turnId: "signal-user-presence",
    token: `signal-${eventId.slice(0, 32)}`,
    createdAt: now,
    dueAt: now,
    pendingAction: USER_PRESENCE_SPEECH,
  };
}

export function buildUserPresenceJobForTest(
  now: number,
  sessionId: string,
): WorkerJob {
  return buildUserPresenceJob(now, sessionId);
}

function sessionDirectory(sessionId: string): string {
  return join(stateRoot(), "sessions", sha256(sessionId).slice(0, 32));
}

function turnDirectory(sessionId: string, turnId: string): string {
  return join(
    sessionDirectory(sessionId),
    "turns",
    sha256(turnId).slice(0, 32),
  );
}

function pointerPath(sessionId: string, name: WorkerKind | "root"): string {
  return join(sessionDirectory(sessionId), `${name}.pointer.json`);
}

function turnMetaPath(sessionId: string, turnId: string): string {
  return join(turnDirectory(sessionId, turnId), "turn.json");
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await chmod(path, 0o700);
  } catch {
    // The directory can still be usable on filesystems without chmod support.
  }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}`,
  );
  const handle = await open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value)}\n`);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function logEvent(
  level: "info" | "warn" | "error",
  code: string,
  error?: unknown,
): Promise<void> {
  const detail =
    error instanceof Error
      ? redactSensitive(error.message).slice(0, 300)
      : typeof error === "string"
        ? redactSensitive(error).slice(0, 300)
        : undefined;
  const entry = JSON.stringify({
    at: new Date().toISOString(),
    level,
    code,
    ...(detail ? { detail } : {}),
  });
  try {
    await ensurePrivateDirectory(dirname(logPath()));
    await appendFile(logPath(), `${entry}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Notifications must never block Codex because logging is unavailable.
  }
}

async function readStdinBounded(limit = INPUT_LIMIT_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let kept = 0;
  for await (const part of process.stdin) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    if (kept >= limit) {
      continue;
    }
    const retained = chunk.subarray(0, Math.max(0, limit - kept));
    chunks.push(retained);
    kept += retained.length;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function hasAgentContext(event: HookEvent): boolean {
  return (
    Object.prototype.hasOwnProperty.call(event, "agent_id") ||
    Object.prototype.hasOwnProperty.call(event, "agent_type")
  );
}

export function isRootHookEvent(event: HookEvent): boolean {
  const name = stringField(event.hook_event_name);
  if (hasAgentContext(event)) {
    return false;
  }
  if (name === "SubagentStart" || name === "SubagentStop") {
    return false;
  }
  if (name === "Stop") {
    return true;
  }
  return true;
}

function eventIdentity(event: HookEvent, occurredAt: number): string {
  const eventName = stringField(event.hook_event_name);
  const occurrenceBucket =
    eventName === "PermissionRequest"
      ? Math.floor(occurredAt / EVENT_DEDUPE_WINDOW_MS)
      : undefined;
  return sha256(
    stableStringify({
      session_id: event.session_id,
      turn_id: event.turn_id,
      hook_event_name: event.hook_event_name,
      tool_name: event.tool_name,
      tool_use_id: event.tool_use_id,
      tool_input: event.tool_input,
      last_assistant_message: event.last_assistant_message,
      source: event.source,
      occurrence_bucket: occurrenceBucket,
    }),
  );
}

async function claimEvent(
  event: HookEvent,
  record: EvidenceRecord,
): Promise<{ claimed: boolean; eventId: string; claimPath: string }> {
  const sessionId = stringField(event.session_id) || "unknown-session";
  const turnId = stringField(event.turn_id) || "session";
  const eventId = eventIdentity(event, record.occurredAt);
  const path = join(turnDirectory(sessionId, turnId), `event-${eventId}.json`);
  await ensurePrivateDirectory(dirname(path));
  try {
    const handle = await open(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { claimed: true, eventId, claimPath: path };
  } catch (error) {
    if (
      isObject(error) &&
      typeof error.code === "string" &&
      error.code === "EEXIST"
    ) {
      return { claimed: false, eventId, claimPath: path };
    }
    throw error;
  }
}

async function writePointer(
  sessionId: string,
  name: WorkerKind | "root",
  token: string,
): Promise<void> {
  await atomicWriteJson(pointerPath(sessionId, name), {
    token,
    updatedAt: Date.now(),
  });
}

async function pointerMatches(
  sessionId: string,
  name: WorkerKind | "root",
  token: string,
): Promise<boolean> {
  const pointer = await readJson<{ token?: unknown }>(
    pointerPath(sessionId, name),
  );
  return pointer?.token === token;
}

async function cancelInterventions(sessionId: string): Promise<void> {
  await Promise.all([
    writePointer(sessionId, "permission", `cancel-${randomUUID()}`),
    writePointer(sessionId, "question", `cancel-${randomUUID()}`),
    writePointer(sessionId, "user-presence", `cancel-${randomUUID()}`),
  ]);
}

async function recordTurnStart(
  event: HookEvent,
  sessionId: string,
  turnId: string,
  now: number,
): Promise<void> {
  const meta: TurnMeta = {
    sessionId,
    turnId,
    startedAt: now,
    currentTask: stringField(event.prompt)
      ? clipEvidence(redactSensitive(String(event.prompt)), 1_500)
      : undefined,
    cwd: stringField(event.cwd),
  };
  await atomicWriteJson(turnMetaPath(sessionId, turnId), meta);
}

async function writeJob(job: WorkerJob): Promise<string> {
  const path = join(
    sessionDirectory(job.sessionId),
    "jobs",
    `${job.kind}-${job.token}.json`,
  );
  await atomicWriteJson(path, job);
  return path;
}

async function spawnDetachedWorker(path: string): Promise<void> {
  let descriptor: number | undefined;
  try {
    const targetLog = logPath();
    mkdirSync(dirname(targetLog), { recursive: true, mode: 0o700 });
    descriptor = openSync(targetLog, "a", 0o600);
    const child = spawn(process.execPath, [SCRIPT_PATH, "--worker", path], {
      detached: true,
      stdio: ["ignore", descriptor, descriptor],
      env: { ...process.env, CODEX_BRIEF_OBSERVER: "1" },
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    child.unref();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Ignore an already-closed descriptor.
      }
    }
  }
}

async function scheduleJob(job: WorkerJob): Promise<SpawnedJob> {
  const path = await writeJob(job);
  try {
    await spawnDetachedWorker(path);
    return { job, path };
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
}

async function scheduleClaimedJob(
  job: WorkerJob,
  claimPath: string,
  schedule: (job: WorkerJob) => Promise<unknown>,
): Promise<void> {
  try {
    await schedule(job);
  } catch (error) {
    await unlink(claimPath).catch(() => {});
    throw error;
  }
}

export async function processHookEvent(
  event: HookEvent,
  now = Date.now(),
  schedule: (job: WorkerJob) => Promise<unknown> = scheduleJob,
): Promise<WorkerJob[]> {
  if (!isRootHookEvent(event)) {
    return [];
  }
  const eventName = stringField(event.hook_event_name);
  const sessionId = stringField(event.session_id);
  if (!eventName || !sessionId) {
    return [];
  }
  const turnId = stringField(event.turn_id) || "session";

  // A session can resume or compact more than once. Cancellation is idempotent
  // and must never be skipped by content-based event deduplication.
  if (["SessionStart", "SessionEnd", "Interrupt"].includes(eventName)) {
    await Promise.all([
      writePointer(sessionId, "root", `cancel-${randomUUID()}`),
      cancelInterventions(sessionId),
    ]);
    if (eventName === "SessionStart" && process.env.PLUGIN_ROOT) {
      await atomicWriteJson(join(userDirectory(), "runtime.json"), {
        entrypoint: SCRIPT_PATH,
        dataDirectory: process.env.PLUGIN_DATA,
      });
    }
    return [];
  }

  const record = storedEvidence(event, now);
  const { claimed, eventId, claimPath } = await claimEvent(event, record);
  if (!claimed) {
    return [];
  }

  if (eventName === "UserPromptSubmit") {
    await recordTurnStart(event, sessionId, turnId, now);
    await Promise.all([
      writePointer(sessionId, "root", `active-${randomUUID()}`),
      cancelInterventions(sessionId),
    ]);
    return [];
  }

  if (eventName === "PreToolUse" || eventName === "PostToolUse") {
    await writePointer(sessionId, "root", `active-${randomUUID()}`);
    await cancelInterventions(sessionId);
    if (
      eventName === "PreToolUse" &&
      /^(?:functions\.)?request_user_input$/.test(
        stringField(event.tool_name) || "",
      )
    ) {
      const token = randomUUID();
      const job: WorkerJob = {
        kind: "question",
        eventId,
        sessionId,
        turnId,
        token,
        createdAt: now,
        dueAt: now + POLICY.questionDelayMs,
        pendingAction: record.pendingAction,
      };
      await writePointer(sessionId, "question", token);
      await scheduleClaimedJob(job, claimPath, schedule);
      return [job];
    }
    return [];
  }

  if (eventName === "PermissionRequest") {
    // Auto-approval may recover this wait. Only the final Stop evidence can
    // establish that human authorization is still pending.
    return [];
  }

  if (eventName === "Stop") {
    const token = randomUUID();
    const job: WorkerJob = {
      kind: "stop",
      eventId,
      sessionId,
      turnId,
      token,
      createdAt: now,
      dueAt: now + POLICY.idleDelayMs,
    };
    await Promise.all([
      writePointer(sessionId, "root", token),
      cancelInterventions(sessionId),
    ]);
    await scheduleClaimedJob(job, claimPath, schedule);
    return [job];
  }

  return [];
}

async function collectEvidence(
  sessionId: string,
  turnId: string,
): Promise<EvidenceRecord[]> {
  const directory = turnDirectory(sessionId, turnId);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const records = await Promise.all(
    names
      .filter((name) => name.startsWith("event-") && name.endsWith(".json"))
      .map((name) => readJson<EvidenceRecord>(join(directory, name))),
  );
  return records
    .filter((record): record is EvidenceRecord => record !== undefined)
    .sort((left, right) => left.occurredAt - right.occurredAt);
}

function uniqueStrings(
  values: Array<string | undefined>,
  limit: number,
): string[] {
  const result: string[] = [];
  for (const value of [...values].reverse()) {
    if (value && !result.includes(value)) {
      result.push(value);
      if (result.length >= limit) {
        break;
      }
    }
  }
  return result.reverse();
}

async function buildSummaryContext(
  job: WorkerJob,
  config: NotifyConfig,
): Promise<SummaryContext> {
  const [meta, records] = await Promise.all([
    readJson<TurnMeta>(turnMetaPath(job.sessionId, job.turnId)),
    collectEvidence(job.sessionId, job.turnId),
  ]);
  const lastAssistant = records
    .map((record) => record.lastAssistantMessage)
    .filter((value): value is string => Boolean(value))
    .at(-1);
  const changedFiles = uniqueStrings(
    records.flatMap((record) => record.changedFiles || []),
    MAX_CHANGED_FILES,
  );
  const recentActions = uniqueStrings(
    records.map((record) => record.action),
    MAX_ACTIONS,
  );
  const validation = records
    .map((record) => record.validation)
    .filter((value): value is string => Boolean(value))
    .at(-1);
  const context: SummaryContext = {
    language: config.summaryLanguage,
    trigger: job.kind,
    session: { id: job.sessionId, rootOnly: true },
    state: {
      durationMs: meta
        ? Math.max(0, job.createdAt - meta.startedAt)
        : undefined,
      currentTask: meta?.currentTask,
      changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
      recentActions: recentActions.length > 0 ? recentActions : undefined,
      validation,
      pendingAction: job.pendingAction,
    },
    recentMessages: lastAssistant ? [lastAssistant] : undefined,
  };
  return context;
}

export function isQuietTime(date: Date, quietHours?: { start: string; end: string }): boolean {
  return quietHours ? isQuietHours(date, { ...quietHours, enabled: true, allowDuringQuietHours: [] }) : false;
}

function allowedByQuietHours(event: NotificationEvent, config: NotifyConfig, now = new Date()): boolean {
  return event === "user-presence" || isNotificationAllowedNow(event, config.notifyPolicy.quietHours, now);
}

function maxAgeFor(event: NotificationEvent, config: NotifyConfig): number {
  return event === "idle"
    ? Math.max(MAX_IDLE_AGE_MS, config.notifyPolicy.idleDelayMs + 60_000)
    : MAX_IMPORTANT_AGE_MS;
}

function pointerNameForJob(job: WorkerJob): WorkerKind | "root" {
  return job.kind === "stop" ? "root" : job.kind;
}

async function jobIsCurrent(job: WorkerJob): Promise<boolean> {
  return await pointerMatches(job.sessionId, pointerNameForJob(job), job.token);
}

export async function jobIsCurrentForTest(job: WorkerJob): Promise<boolean> {
  return await jobIsCurrent(job);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function writeDeliveryPayload(
  job: WorkerJob,
  summary: SummaryResult,
): Promise<string> {
  const payload: DeliveryPayload = {
    event: summary.event,
    text: summary.text!,
    eventId: job.eventId,
    sessionId: job.sessionId,
    turnId: job.turnId,
    token: job.token,
    kind: job.kind,
    createdAt: job.createdAt,
  };
  const path = join(
    sessionDirectory(job.sessionId),
    "deliveries",
    `${job.eventId}-${job.token}.json`,
  );
  await atomicWriteJson(path, payload);
  return path;
}

function userPresenceSummary(): SummaryResult {
  return {
    event: "user-presence",
    text: USER_PRESENCE_SPEECH,
    actionRequired: true,
  };
}

export function userPresenceSummaryForTest(): SummaryResult {
  return userPresenceSummary();
}

async function workerMain(path: string): Promise<number> {
  try {
    const [job, config] = await Promise.all([
      readJson<WorkerJob>(path),
      loadConfig(),
    ]);
    if (!job) return 0;
    if (!config.enabled) return job.kind === "user-presence" ? 1 : 0;
    const initialAge = Date.now() - job.createdAt;
    if (initialAge > MAX_IMPORTANT_AGE_MS || !(await jobIsCurrent(job))) {
      return 0;
    }

    if (job.kind !== "stop") {
      await sleep(Math.max(0, job.dueAt - Date.now()));
      if (!(await jobIsCurrent(job))) {
        return 0;
      }
    }

    const context =
      job.kind === "user-presence"
        ? undefined
        : await buildSummaryContext(job, config);
    const summary =
      job.kind === "user-presence"
        ? userPresenceSummary()
        : config.summary.enabled ? await runSummaryAgent(context!, config.summary.model || undefined, config.summary.instructions) : fallbackSummary(context!);
    if (summary.text === null) {
      await logEvent("info", "summary_silent");
      return 0;
    }
    if (!(await jobIsCurrent(job))) {
      return 0;
    }
    if (
      summary.event === "idle" &&
      context?.state.durationMs !== undefined &&
      shouldIgnoreShortIdle(context.state.durationMs, config.notifyPolicy.ignoreShortTasksSeconds)
    ) {
      return 0;
    }

    if (job.kind === "stop" && summary.event === "idle") {
      await sleep(Math.max(0, job.createdAt + config.notifyPolicy.idleDelayMs - Date.now()));
      if (!(await jobIsCurrent(job))) {
        return 0;
      }
    }
    if (
      Date.now() - job.createdAt > maxAgeFor(summary.event, config) ||
      !allowedByQuietHours(summary.event, config)
    ) {
      return 0;
    }

    const payloadPath = await writeDeliveryPayload(job, summary);
    try {
      if (await jobIsCurrent(job)) {
        const delivered = (await deliverMain(payloadPath)) === 0;
        if (job.kind === "user-presence" && !delivered) {
          return 1;
        }
      }
    } finally {
      await unlink(payloadPath).catch(() => {});
    }
    return 0;
  } catch (error) {
    await logEvent("error", "worker_failed", error);
    return 1;
  } finally {
    await unlink(path).catch(() => {});
  }
}

function deliveryClaimPath(
  payload: DeliveryPayload,
  backend: DeliveryBackend,
): string {
  return join(
    stateRoot(),
    "delivered",
    sha256(`${payload.eventId}:${backend}`),
  );
}

async function claimDelivery(
  payload: DeliveryPayload,
  backend: DeliveryBackend,
): Promise<boolean> {
  const path = deliveryClaimPath(payload, backend);
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  try {
    const handle = await open(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.close();
    return true;
  } catch (error) {
    if (
      isObject(error) &&
      typeof error.code === "string" &&
      error.code === "EEXIST"
    ) {
      return false;
    }
    throw error;
  }
}

async function releaseFailedDeliveryClaim(
  payload: DeliveryPayload,
  backend: DeliveryBackend,
): Promise<void> {
  if (payload.kind === "user-presence") {
    await unlink(deliveryClaimPath(payload, backend)).catch(() => {});
  }
}

export async function exerciseFailedDeliveryClaimForTest(
  payload: DeliveryPayload,
  backend: DeliveryBackend,
): Promise<{ firstClaimed: boolean; retryClaimed: boolean }> {
  const firstClaimed = await claimDelivery(payload, backend);
  await releaseFailedDeliveryClaim(payload, backend);
  const retryClaimed = await claimDelivery(payload, backend);
  return { firstClaimed, retryClaimed };
}

async function deliveryIsCurrent(payload: DeliveryPayload): Promise<boolean> {
  const name = payload.kind === "stop" ? "root" : payload.kind;
  return await pointerMatches(payload.sessionId, name, payload.token);
}

async function waitForChild(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<number | null> {
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  if (child.signalCode !== null) {
    return null;
  }
  return await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);
    child.once("error", rejectExit);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
}

async function playWithGlobalLock(
  audioPath: string,
  payloadPath: string,
  payload: DeliveryPayload,
): Promise<void> {
  const lockPath = join(userDirectory(), "playback.lock");
  await ensurePrivateDirectory(dirname(lockPath));
  const waitSeconds = payload.event === "idle" ? "0" : "30";
  const child = spawn(
    "/usr/bin/lockf",
    [
      "-s",
      "-k",
      "-t",
      waitSeconds,
      lockPath,
      process.execPath,
      SCRIPT_PATH,
      "--play",
      payloadPath,
      audioPath,
    ],
    {
      env: secretFreeEnvironment(),
      stdio: "ignore",
    },
  );
  const code = await waitForChild(child, 95_000);
  if (code !== 0 && payload.event !== "idle") {
    throw new Error(`audio player exited with status ${String(code)}`);
  }
}

async function playMain(
  payloadPath: string,
  audioPath: string,
): Promise<number> {
  const [payload, config] = await Promise.all([readJson<DeliveryPayload>(payloadPath), loadConfig()]);
  if (!payload || !(await deliveryIsCurrent(payload))) {
    return 0;
  }
  const player = spawn("/usr/bin/afplay", [audioPath], { stdio: "ignore" });
  let playerError = false;
  player.on("error", () => {
    playerError = true;
  });
  const started = Date.now();
  while (
    !playerError &&
    player.exitCode === null &&
    player.signalCode === null
  ) {
    if (
      Date.now() - started > POLICY.playbackTimeoutMs ||
      Date.now() - payload.createdAt > maxAgeFor(payload.event, config) ||
      !(await deliveryIsCurrent(payload))
    ) {
      player.kill("SIGTERM");
      await sleep(250);
      if (player.exitCode === null && player.signalCode === null) {
        player.kill("SIGKILL");
      }
      break;
    }
    await sleep(100);
  }
  const exitCode = await waitForChild(player, 1_000).catch(() => null);
  return !playerError && exitCode === 0 ? 0 : 1;
}

async function deliverMain(path: string): Promise<number> {
  const [payload, config] = await Promise.all([
    readJson<DeliveryPayload>(path),
    loadConfig(),
  ]);
  if (!payload || !(await deliveryIsCurrent(payload))) {
    return 0;
  }
  if (
    Date.now() - payload.createdAt > maxAgeFor(payload.event, config) ||
    !allowedByQuietHours(payload.event, config)
  ) {
    return 0;
  }
  if (!config.enabled) return payload.kind === "user-presence" ? 1 : 0;
  let fishHandled = false;
  for (const backend of config.deliveryBackends) {
    if (!(await deliveryIsCurrent(payload))) {
      break;
    }
    if (!(await claimDelivery(payload, backend))) {
      if (backend === "fishaudio") {
        fishHandled = true;
      }
      continue;
    }
    try {
      const controller = new AbortController();
      const checkCurrent = setInterval(() => {
        void deliveryIsCurrent(payload).then(current => {
          if (!current || Date.now() - payload.createdAt > maxAgeFor(payload.event, config)) controller.abort();
        }).catch(() => controller.abort());
      }, 100);
      try {
        const secrets = await resolveDeliverySecrets(config, backend, controller.signal);
        const presentation = payload.event === "user-presence"
          ? { title: "Codex · 硬件密钥", barkLevel: "timeSensitive" as const }
          : eventPresentation(payload.event, config.summaryLanguage, "Codex");
        const notice = { type: payload.event === "user-presence" ? "permission" as const : payload.event,
          summary: payload.text, ...presentation };
        const sendFish = createFishAudioSender(process.platform === "darwin" ? async audioPath => {
          if (!(await deliveryIsCurrent(payload)) || controller.signal.aborted) throw new Error("cancelled");
          await playWithGlobalLock(audioPath, path, payload);
        } : null);
        const result = backend === "fishaudio"
          ? await sendFish(notice, config, secrets, controller.signal)
          : await sendBark(notice, config, secrets, controller.signal);
        if (controller.signal.aborted) continue;
        if (!result.ok) throw new Error(result.error ? formatDeliveryFailure(backend, result.error) : "delivery failed");
        if (backend === "fishaudio") fishHandled = true;
      } finally { clearInterval(checkCurrent); }
    } catch (error) {
      await releaseFailedDeliveryClaim(payload, backend);
      await logEvent("error", `${backend}_delivery_failed`, error);
    }
  }
  return payload.kind === "user-presence" && !fishHandled ? 1 : 0;
}

async function checkFish(): Promise<number> {
  try {
    const response = await fetch(FISH_CREDIT_URL, {
      headers: {
        Authorization: `Bearer ${await resolveValue((await loadConfig()).backends.fishAudio.apiKey, "fishAudio.apiKey")}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Fish Audio returned HTTP ${response.status}`);
    }
    await response.arrayBuffer();
    console.log("Fish Audio API key is valid.");
    return 0;
  } catch (error) {
    console.error(
      `Fish Audio API key check failed: ${
        error instanceof Error
          ? redactSensitive(error.message)
          : "unknown error"
      }.`,
    );
    return 1;
  }
}

async function playTestNotification(): Promise<number> {
  try {
    const config = await loadConfig();
    if (!config.enabled || !config.deliveryBackends.includes("fishaudio")) throw new Error("Fish Audio is not enabled");
    const result = await sendNativeFishAudio({ type: "idle", title: "Codex", summary: "Codex 语音提醒已启用。", barkLevel: "active" },
      config, await resolveDeliverySecrets(config, "fishaudio"));
    if (!result.ok) throw new Error(result.error ? formatDeliveryFailure("fishaudio", result.error) : "delivery failed");
    console.log("Test notification played.");
    return 0;
  } catch (error) {
    console.error(`Fish Audio test failed: ${error instanceof Error ? redactSensitive(error.message) : "unknown error"}.`);
    return 1;
  }
}

async function checkSummaryAgent(): Promise<number> {
  const config = await loadConfig();
  const context: SummaryContext = {
    language: config.summaryLanguage,
    trigger: "stop",
    session: { id: "self-check", rootOnly: true },
    state: {
      durationMs: 20_000,
      currentTask: "验证 Codex 通知摘要观察者",
      recentActions: ["Ran validation"],
      validation: "Validation completed successfully.",
    },
    recentMessages: ["摘要观察者配置已经完成，并通过了本地校验。"],
  };
  const result = await runSummaryAgentOnce(context, undefined, config.summary.model || undefined, config.summary.instructions);
  if (!result) {
    console.error("Summary Agent check failed.");
    return 1;
  }
  console.log(
    `Summary Agent is available: event=${result.event}, chars=${result.text?.length || 0}.`,
  );
  return 0;
}

async function pruneOldState(): Promise<void> {
  const sessions = join(stateRoot(), "sessions");
  let names: string[];
  try {
    names = await readdir(sessions);
  } catch {
    return;
  }
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1_000;
  await Promise.all(
    names.map(async (name) => {
      const path = join(sessions, name);
      try {
        if ((await stat(path)).mtimeMs < cutoff) {
          await rm(path, { recursive: true, force: true });
        }
      } catch {
        // Best-effort cleanup only.
      }
    }),
  );
}

async function hookMain(): Promise<number> {
  if (process.env.CODEX_BRIEF_OBSERVER === "1") {
    await readStdinBounded();
    return 0;
  }
  const input = await readStdinBounded();
  let event: HookEvent;
  try {
    const parsed = JSON.parse(input);
    if (!isObject(parsed)) {
      return 0;
    }
    event = parsed;
  } catch {
    return 0;
  }
  try {
    await processHookEvent(event);
    if (event.hook_event_name === "SessionStart") {
      pruneOldState().catch(() => {});
    }
  } catch (error) {
    await logEvent("error", "hook_failed", error);
  }
  return 0;
}

async function signalMain(signal: SignalName): Promise<number> {
  const job = buildUserPresenceJob();
  await writePointer(job.sessionId, signal, job.token);
  const path = await writeJob(job);
  const result = await workerMain(path);
  if (result !== 0) {
    console.error(USER_PRESENCE_FAILURE_MESSAGE);
  }
  return result;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const mode = argv[0];
  if (mode === "--help") {
    console.log(
      "Codex Brief: --check | --check-summary | --test | --signal user-presence | --paths",
    );
    return 0;
  }
  if (mode === "--paths") {
    console.log(
      JSON.stringify(
        {
          config: configPath(),
          state: stateRoot(),
          log: logPath(),
          pluginRoot: dirname(SCRIPT_DIR),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (mode === "--signal") {
    if (argv.length !== 2 || argv[1] !== "user-presence") {
      console.error("Usage: codex_brief.mts --signal user-presence");
      return 2;
    }
    return await signalMain(argv[1]);
  }
  if (mode === "--worker" && argv[1]) {
    return await workerMain(resolve(argv[1]));
  }
  if (mode === "--deliver" && argv[1]) {
    return await deliverMain(resolve(argv[1]));
  }
  if (mode === "--play" && argv[1] && argv[2]) {
    return await playMain(resolve(argv[1]), resolve(argv[2]));
  }
  if (mode === "--check") {
    return await checkFish();
  }
  if (mode === "--test") {
    return await playTestNotification();
  }
  if (mode === "--check-summary") {
    return await checkSummaryAgent();
  }
  if (mode === "--hook") return await hookMain();
  if (mode !== undefined) {
    console.error(`Unknown codex_brief option: ${mode}`);
    return 2;
  }
  return await hookMain();
}

const entry = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entry === import.meta.url) {
  process.exitCode = await main();
}
