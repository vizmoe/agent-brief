import { createHash } from "node:crypto";

import { sanitizeEvidenceText } from "./summary.ts";
import type {
	AssistantOutcome,
	NotificationType,
} from "./types.ts";
import { isRecord } from "./util.ts";

export interface PermissionUiPromptEvent {
	requestId: string;
	source: "tool_call" | "skill_input" | "skill_read";
	surface: string | null;
	value: string | null;
	agentName: string | null;
	message: string | null;
	forwarding: {
		requesterAgentName: string | null;
		requesterSessionId: string | null;
	} | null;
}

export interface PermissionDecisionEvent {
	surface: string;
	value: string;
	resolution:
		| "user_approved"
		| "user_approved_for_session"
		| "user_denied";
	agentName: string | null;
}

function landstripContextIsSubagent(encoded: string | undefined): boolean {
	if (!encoded?.trim()) return false;
	try {
		const value = JSON.parse(
			Buffer.from(encoded, "base64url").toString("utf8"),
		) as unknown;
		return isRecord(value) && value.role === "subagent";
	} catch {
		return false;
	}
}

export function isInternalWorkerProcess(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.PI_SUBAGENT_CHILD === "1"
		|| Boolean(env.PI_LANDSTRIP_WORKER?.trim())
		|| landstripContextIsSubagent(env.LANDSTRIP_CONTEXT);
}

export function normalizeSessionId(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readAssistantOutcome(message: unknown): AssistantOutcome {
	if (!isRecord(message) || message.role !== "assistant") return "unknown";
	// Providers may attach errorMessage to a user-aborted response as well.
	if (message.stopReason === "aborted") return "aborted";
	if (
		message.stopReason === "error"
		|| (typeof message.errorMessage === "string" && message.errorMessage.trim())
	) {
		return "error";
	}
	return "completed";
}

export function readAssistantError(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	return sanitizeEvidenceText(message.errorMessage, 600);
}

export function readAgentOutcome(messages: unknown): AssistantOutcome {
	if (!Array.isArray(messages)) return "unknown";
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const outcome = readAssistantOutcome(messages[index]);
		if (outcome !== "unknown") return outcome;
	}
	return "unknown";
}

export function readAgentError(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const error = readAssistantError(messages[index]);
		if (error) return error;
	}
	return undefined;
}

export function readPermissionUiPromptEvent(
	payload: unknown,
): PermissionUiPromptEvent | null {
	if (!isRecord(payload)) return null;
	if (
		typeof payload.requestId !== "string"
		|| !payload.requestId.trim()
		|| (payload.source !== "tool_call"
			&& payload.source !== "skill_input"
			&& payload.source !== "skill_read")
	) {
		return null;
	}
	const forwarding = payload.forwarding;
	if (forwarding !== null && forwarding !== undefined && !isRecord(forwarding)) {
		return null;
	}
	return {
		requestId: payload.requestId.trim(),
		source: payload.source,
		surface: typeof payload.surface === "string" && payload.surface.trim()
			? payload.surface.trim()
			: null,
		value: typeof payload.value === "string" && payload.value.trim()
			? payload.value.trim()
			: null,
		agentName: typeof payload.agentName === "string" && payload.agentName.trim()
			? payload.agentName.trim()
			: null,
		message: typeof payload.message === "string" ? payload.message : null,
		forwarding: isRecord(forwarding)
			? {
				requesterAgentName: typeof forwarding.requesterAgentName === "string"
					? forwarding.requesterAgentName
					: null,
				requesterSessionId: typeof forwarding.requesterSessionId === "string"
					? forwarding.requesterSessionId
					: null,
			}
			: null,
	};
}

export function readPermissionDecisionEvent(
	payload: unknown,
): PermissionDecisionEvent | null {
	if (
		!isRecord(payload)
		|| typeof payload.surface !== "string"
		|| typeof payload.value !== "string"
		|| (
			payload.resolution !== "user_approved"
			&& payload.resolution !== "user_approved_for_session"
			&& payload.resolution !== "user_denied"
		)
	) {
		return null;
	}
	return {
		surface: payload.surface.trim(),
		value: payload.value.trim(),
		resolution: payload.resolution,
		agentName: typeof payload.agentName === "string" && payload.agentName.trim()
			? payload.agentName.trim()
			: null,
	};
}

export function permissionFingerprint(
	surface: string | null,
	value: string | null,
	agentName: string | null,
): string | null {
	if (!surface && !value) return null;
	return createHash("sha256")
		.update(`${surface ?? ""}\u0000${value ?? ""}\u0000${agentName ?? ""}`)
		.digest("hex");
}

export function summarizePermissionAction(
	surface: string | null,
	value: string | null,
): string {
	const normalizedSurface = typeof surface === "string"
		? surface.trim().toLowerCase()
		: "";
	const candidate = typeof value === "string" ? value.slice(0, 2000) : "";
	if (
		normalizedSurface === "bash"
		|| normalizedSurface === "shell"
		|| normalizedSurface === "command"
	) {
		const knownCommands: Array<[RegExp, string]> = [
			[/\bgit\s+push\b/i, "git push"],
			[/\bgit\s+commit\b/i, "git commit"],
			[/\bgit\s+(?:tag|merge|rebase|reset)\b/i, "a Git history operation"],
			[/\b(?:npm|pnpm|yarn|bun)\s+publish\b/i, "a package publish"],
			[/\bdocker\s+push\b/i, "a container image push"],
			[/\b(?:rm|unlink)\b/i, "a file removal command"],
			[/\b(?:chmod|chown)\b/i, "a file permission command"],
			[/\b(?:ssh|scp|rsync)\b/i, "a remote access command"],
			[/\bcurl\b/i, "a network request"],
		];
		const matched = knownCommands.find(([pattern]) => pattern.test(candidate));
		return matched
			? `Permission is required to run ${matched[1]}.`
			: "Permission is required to run a shell command.";
	}
	if (normalizedSurface === "read") return "Permission is required to read a file.";
	if (normalizedSurface === "write") return "Permission is required to modify a file.";
	if (normalizedSurface === "network") return "Permission is required for network access.";
	if (normalizedSurface === "skill") return "Permission is required to use a skill.";
	if (normalizedSurface === "mcp") return "Permission is required to use an MCP tool.";
	const safeSurface = /^[a-z][a-z0-9_-]{0,40}$/.test(normalizedSurface)
		? normalizedSurface
		: "requested";
	return `Permission is required for the ${safeSurface} operation.`;
}

export function summarizePermissionUiTitle(title: string): string {
	const surface = title.match(
		/(?:^|\n)\s*(bash|shell|command|read|write|network|skill|mcp)\s*:/i,
	)?.[1] ?? null;
	return summarizePermissionAction(surface, title);
}

export function boundedAdd(set: Set<string>, value: string, max = 1000): void {
	set.add(value);
	if (set.size <= max) return;
	const first = set.values().next().value;
	if (typeof first === "string") set.delete(first);
}

export function boundedPush(values: string[], value: string, max: number): void {
	values.push(value);
	if (values.length > max) values.splice(0, values.length - max);
}

export function shouldDispatchNotification(
	scopes: Set<string>,
	lastNotificationAt: Map<NotificationType, number>,
	type: NotificationType,
	scopedKey: string | null,
	sticky: boolean,
	now: number,
	dedupeWindowMs: number,
): boolean {
	const previous = lastNotificationAt.get(type) ?? 0;
	if (scopedKey && scopes.has(scopedKey)) return false;
	if (!scopedKey && now - previous < dedupeWindowMs) return false;
	if (scopedKey && sticky) boundedAdd(scopes, scopedKey);
	lastNotificationAt.set(type, now);
	return true;
}

export function isBlockingQuestionText(value: string | undefined): boolean {
	if (!value) return false;
	const tail = value.slice(-1600).trim();
	if (
		/(?:还有什么.{0,30}(?:帮助|需要)|(?:你|您)?还(?:要|需要)(?:我)?(?:做|帮|处理).{0,30}(?:什么|其他|别的)|要我继续帮.{0,30}(?:其他|别的|吗)|anything else.{0,30}(?:help|assist)|(?:do you want|would you like)(?: me to)?.{0,50}(?:anything|something) else|do you (?:need|want) anything else|can I help.{0,40}anything else)/i
			.test(tail.slice(-160))
	) {
		return false;
	}

	const questionIndex = Math.max(tail.lastIndexOf("?"), tail.lastIndexOf("？"));
	let unresolved = "";
	if (questionIndex >= 0) {
		const trailing = tail.slice(questionIndex + 1).trim();
		if (trailing) {
			const optionLines = trailing
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);
			if (
				optionLines.length === 0
				|| !optionLines.every((line) => (
					/^(?:[-*+]|\d+[.)]|[A-Z][.)])\s+/.test(line)
				))
			) {
				return false;
			}
		}
		unresolved = tail.slice(Math.max(0, questionIndex - 600), questionIndex + 1);
	} else {
		const clauses = tail
			.split(/(?:\n{2,}|[。.!！]\s*)/)
			.map((clause) => clause.trim())
			.filter(Boolean);
		unresolved = clauses.at(-1) ?? tail;
	}

	return /(?:需要你(?:选择|确认|提供|决定|输入)|请(?:选择|确认|提供|决定|输入)|请告诉我.{0,80}(?:希望|想要|选择|使用).{0,50}(?:哪个|哪种|什么)|等待你的(?:选择|确认|输入|决定)|无法继续.{0,120}(?:选择|确认|输入)|(?:你|您)?更倾向(?:于)?(?:哪个|哪种)|(?:是否|要不要|要.{0,40}吗)|needs? your (?:input|decision|confirmation)|please (?:choose|confirm|provide|decide)|which (?:(?:option|one|approach)\s+)?(?:should|would|do)|which do you prefer|do you (?:prefer|want)|would you like me to (?:proceed|continue|deploy|run|apply)|should (?:I|we)|(?:cannot|can't|unable to).{0,120}(?:continue|proceed).{0,120}(?:without|until)|before (?:I|we) (?:can )?(?:continue|proceed))/i
		.test(unresolved);
}

export function notificationKey(
	sessionId: string,
	type: NotificationType,
	scope: string,
): string {
	return `${sessionId}:${type}:${scope}`;
}

export function safeToolArgs(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

export function toolFilePath(args: Record<string, unknown>): string | undefined {
	for (const key of ["path", "filePath", "file_path"]) {
		const value = sanitizeEvidenceText(args[key], 300);
		if (value) return value;
	}
	return undefined;
}

export function questionText(args: Record<string, unknown>): string | undefined {
	for (const key of ["question", "prompt", "message", "title"]) {
		const value = sanitizeEvidenceText(args[key], 600);
		if (value) return value;
	}
	return undefined;
}

export function isInternalAgentTool(name: string): boolean {
	return /(?:subagent|delegate|intercom|background|task_wait|task_join)/i.test(name);
}

export function isValidationCommand(args: Record<string, unknown>): boolean {
	const command = typeof args.command === "string" ? args.command : "";
	return /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun|deno|cargo|go|pytest|python|ruby)?\s*(?:run\s+)?(?:test|check|lint|build|typecheck|tsc)\b/i
		.test(command);
}
