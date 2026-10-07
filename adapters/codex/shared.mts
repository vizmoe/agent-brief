import { sanitizeEvidenceText } from "../../core/summary.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function redactSensitive(value: string): string {
  let text = sanitizeEvidenceText(value, value.length) ?? "";
  text = text.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/\bBearer\s+[^\s"'`]+/gi, "Bearer [redacted]");
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
  text = text.replace(
    /\b(api[_ -]?key|token|secret|password|authorization)\b(\s*[:=]\s*)[^\s,;]+/gi,
    "$1$2[redacted]",
  );
  text = text.replace(
    /\b(FISH|BARK|OPENAI)_[A-Z0-9_]+=(?:"[^"]*"|'[^']*'|[^\s]+)/g,
    (match) => `${match.split("=")[0]}=[redacted]`,
  );
  text = text.replace(/\b[a-f0-9]{32,}\b/gi, "[id]");
  text = text.replace(/https?:\/\/[^\s)>\]]+/gi, "[link]");
  text = text.replace(
    /\/Users\/[^/\s]+\/[^\s"'`)>]+/g,
    (path) => `<path:${basename(path)}>`,
  );
  return text.replace(/\s+/g, " ").trim();
}

export function secretFreeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  const allowExact = new Set([
    "HOME",
    "CODEX_HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NO_PROXY",
    "no_proxy",
    "CODEX_BRIEF_STATE_DIR",
    "CODEX_BRIEF_LOG_PATH",
    "CODEX_BRIEF_CONFIG",
    "AGENT_BRIEF_CONFIG",
    "PLUGIN_DATA",
  ]);
  const proxyKeys = new Set([
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowExact.has(key)) {
      output[key] = value;
    } else if (value !== undefined && proxyKeys.has(key)) {
      try {
        const parsed = new URL(value);
        if (!parsed.username && !parsed.password) {
          output[key] = value;
        }
      } catch {
        // Ignore malformed proxy values instead of leaking embedded credentials.
      }
    }
  }
  output.CODEX_BRIEF_OBSERVER = "1";
  return output;
}

export function secretFreeEnvironmentForTest(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return secretFreeEnvironment(source);
}

export async function runProcess(
  command: string,
  args: string[],
  options: {
    input?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    timeoutMs: number;
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-8_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectProcess(error);
    });
    child.stdin.on("error", () => {
      // Early process failure can close stdin before the evidence is written.
      // The process exit/error remains the authoritative failure signal.
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveProcess({ code, stdout, stderr });
    });
    child.stdin.end(options.input || "");
  });
}
