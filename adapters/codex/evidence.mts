import { basename, isAbsolute, relative } from "node:path";
import { isObject, stableStringify, redactSensitive } from "./shared.mts";
import type { HookEvent, EvidenceRecord } from "./types.mts";
const MAX_EVIDENCE_TEXT = 3000;
const MAX_CHANGED_FILES = 12;
const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
export function clipEvidence(value: string, limit = MAX_EVIDENCE_TEXT): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  const prefix = normalized.slice(0, limit);
  const boundary = Math.max(
    prefix.lastIndexOf("。"),
    prefix.lastIndexOf(". "),
    prefix.lastIndexOf("，"),
    prefix.lastIndexOf(", "),
    prefix.lastIndexOf(" "),
  );
  return `${prefix.slice(0, boundary > limit / 2 ? boundary : limit).trim()}…`;
}

function normalizeRelativePath(candidate: string, cwd?: string): string {
  let path = candidate.trim().replace(/^["']|["']$/g, "");
  path = path.replace(/^[ab]\//, "");
  if (isAbsolute(path)) {
    if (cwd) {
      const relativePath = relative(cwd, path);
      path =
        relativePath && !relativePath.startsWith("..")
          ? relativePath
          : basename(path);
    } else {
      path = basename(path);
    }
  }
  return redactSensitive(path).replace(/^<path:|>$/g, "");
}

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, output);
    }
  } else if (isObject(value)) {
    for (const item of Object.values(value)) {
      collectStrings(item, output);
    }
  }
  return output;
}

export function extractChangedFiles(
  toolName: string,
  toolInput: unknown,
  cwd?: string,
): string[] {
  if (!/^(apply_patch|Edit|Write)$/i.test(toolName)) {
    return [];
  }
  const found: string[] = [];
  const add = (candidate: string): void => {
    const normalized = normalizeRelativePath(candidate, cwd);
    if (normalized && !found.includes(normalized)) {
      found.push(normalized);
    }
  };
  const combined = collectStrings(toolInput).join("\n");
  for (const match of combined.matchAll(
    /^\*{3} (?:(?:Add|Update|Delete) File:|Move to:)\s*(.+)$/gm,
  )) {
    add(match[1] ?? "");
  }
  if (isObject(toolInput)) {
    for (const key of ["file_path", "filePath", "path"]) {
      if (typeof toolInput[key] === "string") {
        add(toolInput[key]);
      }
    }
  }
  return found.slice(0, MAX_CHANGED_FILES);
}

function findNamedString(
  value: unknown,
  names: Set<string>,
): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findNamedString(item, names);
      if (match) {
        return match;
      }
    }
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (names.has(key) && typeof item === "string" && item.trim()) {
        return item;
      }
      const match = findNamedString(item, names);
      if (match) {
        return match;
      }
    }
  }
  return undefined;
}

export function extractPendingAction(
  toolName: string,
  toolInput: unknown,
): string {
  const description = findNamedString(
    toolInput,
    new Set(["description", "question", "title", "prompt", "message"]),
  );
  if (description) {
    return clipEvidence(redactSensitive(description), 300);
  }
  const friendly: Record<string, string> = {
    Bash: "执行需要额外权限的操作",
    apply_patch: "修改受保护的文件",
    request_user_input: "回答 Codex 提出的问题",
  };
  return friendly[toolName] || `确认 ${redactSensitive(toolName)} 操作`;
}

function describeAction(
  toolName: string,
  toolInput: unknown,
  changedFiles: string[],
): string {
  if (changedFiles.length > 0) {
    return `Updated ${changedFiles.join(", ")}`;
  }
  const description = findNamedString(
    toolInput,
    new Set(["description", "justification"]),
  );
  if (description) {
    return clipEvidence(redactSensitive(description), 240);
  }
  if (toolName === "Bash") {
    const command = findNamedString(toolInput, new Set(["command", "cmd"]));
    if (
      command &&
      /\b(test|pytest|vitest|jest|lint|check|build)\b/i.test(command)
    ) {
      return "Ran validation";
    }
    return "Ran a shell operation";
  }
  return `Used ${redactSensitive(toolName)}`;
}

function responseText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return stableStringify(value);
  } catch {
    return "";
  }
}

export function extractValidation(
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
): string | undefined {
  if (toolName !== "Bash") {
    return undefined;
  }
  const command = findNamedString(toolInput, new Set(["command", "cmd"])) || "";
  if (!/\b(test|pytest|vitest|jest|lint|check|build)\b/i.test(command)) {
    return undefined;
  }
  const output = responseText(toolResponse);
  const failureScan = output
    .replace(/\b0\s+(?:failed|failures?|errors?)\b/gi, "")
    .replace(/\bexit(?:ed)?\s+(?:with\s+)?(?:code\s+)?0\b/gi, "");
  if (
    /\b(?:[1-9]\d*\s+(?:failed|failures?|errors?)|fail(?:ed|ure)?|error(?:s)?|exit(?:ed)?\s+(?:with\s+)?(?:code\s+)?[1-9]\d*|non[- ]?zero)\b/i.test(
      failureScan,
    )
  ) {
    return undefined;
  }
  if (
    /\b(\d+\s+passed|tests?\s+passed|all\s+checks?\s+passed|success(?:ful)?|exit(?:ed)?\s+(?:code\s+)?0)\b/i.test(
      output,
    )
  ) {
    return "Validation completed successfully.";
  }
  return undefined;
}

export function storedEvidence(event: HookEvent, now: number): EvidenceRecord {
  const name = stringField(event.hook_event_name) || "Unknown";
  const record: EvidenceRecord = { eventName: name, occurredAt: now };
  const toolName = stringField(event.tool_name);
  const cwd = stringField(event.cwd);
  if (name === "PostToolUse" && toolName) {
    const changedFiles = extractChangedFiles(toolName, event.tool_input, cwd);
    record.action = describeAction(toolName, event.tool_input, changedFiles);
    if (changedFiles.length > 0) {
      record.changedFiles = changedFiles;
    }
    record.validation = extractValidation(
      toolName,
      event.tool_input,
      event.tool_response,
    );
  }
  if (name === "PermissionRequest" && toolName) {
    record.pendingAction = extractPendingAction(toolName, event.tool_input);
  }
  if (name === "PreToolUse" && toolName === "request_user_input") {
    record.pendingAction = extractPendingAction(toolName, event.tool_input);
  }
  if (name === "Stop") {
    const message = stringField(event.last_assistant_message);
    if (message) {
      record.lastAssistantMessage = clipEvidence(
        redactSensitive(message),
        MAX_EVIDENCE_TEXT,
      );
    }
  }
  return record;
}
