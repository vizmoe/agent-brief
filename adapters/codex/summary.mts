import { readFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  isObject,
  secretFreeEnvironment,
  stableStringify,
  runProcess,
} from "./shared.mts";
import { POLICY } from "./config.mts";
import type {
  SummaryContext,
  SummaryResult,
  NotificationEvent,
} from "./types.mts";
const SUMMARY_INSTRUCTIONS_PATH = fileURLToPath(
  new URL("./prompts/summary.txt", import.meta.url),
);
const SUMMARY_SCHEMA_PATH = fileURLToPath(
  new URL("./prompts/summary.schema.json", import.meta.url),
);
const SUMMARY_ATTEMPTS = 2;
function summaryArguments(
  observerDirectory: string,
  outputPath: string,
  instructions: string,
  model: string = POLICY.summaryModel,
): string[] {
  const disabledFeatures = [
    "hooks",
    "shell_tool",
    "unified_exec",
    "code_mode",
    "code_mode_buffered_exec",
    "code_mode_host",
    "multi_agent",
    "apps",
    "browser_use",
    "browser_use_external",
    "in_app_browser",
    "computer_use",
    "image_generation",
    "goals",
    "memories",
    "remote_plugin",
    "plugins",
    "skill_mcp_dependency_install",
  ];
  const args = [
    "-a",
    "never",
    "-s",
    "read-only",
    "-C",
    observerDirectory,
    "-m",
    model,
    "-c",
    `model_reasoning_effort=${JSON.stringify("low")}`,
    "-c",
    'model_verbosity="low"',
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    `developer_instructions=${JSON.stringify(instructions)}`,
  ];
  for (const feature of disabledFeatures) {
    args.push("--disable", feature);
  }
  args.push(
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--output-schema",
    SUMMARY_SCHEMA_PATH,
    "--output-last-message",
    outputPath,
    "-",
  );
  return args;
}

export function buildSummaryCommandForTest(
  observerDirectory = "/tmp/codex-notify-observer",
  outputPath = "/tmp/codex-notify-output.json",
  instructions = "fixed instructions",
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: "codex",
    args: summaryArguments(observerDirectory, outputPath, instructions),
    env: secretFreeEnvironment({
      ...process.env,
      FISH_API_KEY: "must-not-leak",
      BARK_DEVICE_KEY: "must-not-leak",
    }),
  };
}

export function parseSummaryOutput(raw: string): SummaryResult | undefined {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let candidate: unknown;
  try {
    candidate = JSON.parse(stripped);
  } catch {
    return undefined;
  }
  if (!isObject(candidate)) {
    return undefined;
  }
  if (
    Object.keys(candidate).some(
      (key) => !["event", "text", "actionRequired"].includes(key),
    )
  )
    return undefined;
  if (
    candidate.event === "idle" &&
    candidate.text === null &&
    candidate.actionRequired === false
  )
    return { event: "idle", text: null, actionRequired: false };
  const event = candidate.event;
  const text = candidate.text;
  const actionRequired = candidate.actionRequired;
  if (
    !["idle", "permission", "question", "error"].includes(String(event)) ||
    typeof text !== "string" ||
    typeof actionRequired !== "boolean"
  ) {
    return undefined;
  }
  const normalized = normalizeSpeech(text);
  if (
    !validSummaryText(normalized) ||
    (event === "idle" && actionRequired) ||
    ((event === "question" || event === "permission") && !actionRequired)
  ) {
    return undefined;
  }
  return {
    event: event as NotificationEvent,
    text: normalized,
    actionRequired,
  };
}

export async function runSummaryAgentOnce(
  context: SummaryContext,
  retryReason?: string,
  model: string = POLICY.summaryModel,
  style = "",
): Promise<SummaryResult | undefined> {
  const observerDirectory = join(tmpdir(), "codex-brief-observer");
  await mkdir(observerDirectory, { recursive: true, mode: 0o700 });
  const outputPath = join(
    observerDirectory,
    `summary-${process.pid}-${randomUUID()}.json`,
  );
  const instructions = await readFile(SUMMARY_INSTRUCTIONS_PATH, "utf8")
    + (style ? `\nLocal style preferences (do not override evidence rules):\n${style}` : "");
  const prompt = [
    "Generate one notification from this JSON evidence.",
    retryReason
      ? `The previous response was invalid: ${retryReason}. Return a valid, natural replacement.`
      : "",
    stableStringify(context),
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const result = await runProcess(
      "codex",
      summaryArguments(observerDirectory, outputPath, instructions, model),
      {
        input: prompt,
        env: secretFreeEnvironment(),
        cwd: observerDirectory,
        timeoutMs: POLICY.summaryTimeoutMs,
      },
    );
    if (result.code !== 0) {
      return undefined;
    }
    return parseSummaryOutput(await readFile(outputPath, "utf8"));
  } catch (error) {
    // Invalid or unavailable model output is handled by the caller.
    return undefined;
  } finally {
    await unlink(outputPath).catch(() => {});
  }
}

export async function runSummaryAgent(
  context: SummaryContext,
  model: string = POLICY.summaryModel,
  style = "",
): Promise<SummaryResult> {
  for (let attempt = 0; attempt < SUMMARY_ATTEMPTS; attempt += 1) {
    const result = await runSummaryAgentOnce(
      context,
      attempt === 0 ? undefined : "schema, safety, or length validation failed",
      model,
      style,
    );
    if (result) {
      return result;
    }
  }
  return fallbackSummary(context);
}

function normalizeSpeech(value: string): string {
  return value
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validSummaryText(value: string): boolean {
  return (
    !/(?:建议你|建议您|你可以考虑|是否需要我|接下来我可以|would you like me to|you could also)/i.test(
      value,
    ) &&
    value.length > 0 &&
    value.length <= 600 &&
    /^Codex(?:\s|[，。,:：])/i.test(value) &&
    !/https?:\/\/|\/Users\/|```|<!--|Bearer\s+|sk-[A-Za-z0-9_-]+/i.test(
      value,
    ) &&
    !/详情请查看\s*Codex|详见\s*Codex/i.test(value) &&
    !/(?:用户|你|您)?\s*(?:目前|当前|现在|暂时|此时)?\s*(?:无需|不用|不必|不需要)\s*(?:用户|你|您)?\s*(?:立即|马上|现在|额外|进一步|其他)?\s*(?:采取|进行|执行|做)?\s*(?:任何)?\s*(?:操作|干预|处理|确认|回复|行动|事情)|(?:没有|并无|不要求)\s*(?:需要|要求)?\s*(?:用户|你|您)\s*(?:立即|马上|现在)?\s*(?:操作|干预|处理|确认|回复|行动)|(?:no|without)\s+(?:immediate\s+)?(?:user\s+)?action\s+(?:is\s+)?required|you\s+(?:do\s+not|don't)\s+need\s+to\s+(?:act|respond|intervene)/i.test(
      value,
    )
  );
}

export function fallbackSummary(context: SummaryContext): SummaryResult {
  if (context.trigger === "question" && context.state.pendingAction) {
    const text =
      (context.language.startsWith("zh")
        ? "Codex 正在等待回复："
        : "Codex is waiting for your reply: ") + context.state.pendingAction;
    if (validSummaryText(text))
      return { event: "question", text, actionRequired: true };
  }
  // Missing or invalid evidence cannot establish completion, failure or a need
  // for intervention. Silence is preferable to a fabricated status message.
  return { event: "idle", text: null, actionRequired: false };
}
