import { existsSync, readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	type BarkLevel,
	type NotificationType,
	type NotifyConfig,
} from "./types.ts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const warned = new Set<string>();

function expandHomePath(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) {
		return join(homedir(), value.slice(2));
	}
	return value;
}

export function resolveAgentDirectory(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	return configured ? expandHomePath(configured) : getAgentDir();
}

export function resolveConfigPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const explicit = env.PI_BRIEF_CONFIG?.trim();
	if (explicit) return expandHomePath(explicit);

	return join(resolveAgentDirectory(env), "pi-brief", "config.json");
}

export const EVENT_PRESENTATION: Record<
	NotificationType,
	{ title: string; barkLevel: BarkLevel }
> = {
	idle: { title: "Pi · 已完成", barkLevel: "active" },
	permission: { title: "Pi · 等待授权", barkLevel: "timeSensitive" },
	question: { title: "Pi · 等待输入", barkLevel: "timeSensitive" },
	error: { title: "Pi · 执行错误", barkLevel: "critical" },
};

const EN_EVENT_TITLES: Record<NotificationType, string> = {
	idle: "Pi · Completed",
	permission: "Pi · Permission required",
	question: "Pi · Input required",
	error: "Pi · Error",
};

const EN_FALLBACK_MESSAGES: Record<NotificationType, string> = {
	idle: "Pi completed the task and is waiting for your next instruction.",
	permission: "Pi is waiting for permission and needs your confirmation.",
	question: "Pi needs your input before it can continue.",
	error: "Pi encountered an error and needs your attention.",
};

export function eventPresentation(
	type: NotificationType,
	language: string,
): { title: string; barkLevel: BarkLevel } {
	const presentation = EVENT_PRESENTATION[type];
	return {
		...presentation,
		title: /^en(?:-|$)/i.test(language)
			? EN_EVENT_TITLES[type]
			: presentation.title,
	};
}

export function notificationFallback(
	type: NotificationType,
	language: string,
	configured: string,
): string {
	if (
		/^en(?:-|$)/i.test(language)
		&& configured === DEFAULT_CONFIG.fallbackMessages[type]
	) {
		return EN_FALLBACK_MESSAGES[type];
	}
	return configured;
}

export const DEFAULT_CONFIG: NotifyConfig = {
	configDirectory: MODULE_DIR,
	enabled: false,
	summaryLanguage: "zh-CN",
	notifyRootOnly: true,
	deliveryBackends: [],
	notifyPolicy: {
		idleDelayMs: 30_000,
		ignoreShortTasksSeconds: 10,
		dedupeWindowMs: 1000,
		quietHours: {
			enabled: false,
			start: "23:00",
			end: "08:00",
			allowDuringQuietHours: ["permission", "error"],
		},
	},
	summary: {
		enabled: true,
		targetLength: 120,
		model: "",
		instructions: "",
		timeoutMs: 20_000,
		maxContextCharacters: 12_000,
		maxOutputCharacters: 2000,
	},
	backends: {
		fishAudio: {
			apiKey: "$FISH_API_KEY",
			referenceId: "$FISH_REFERENCE_ID",
			model: "s2-pro",
			format: "mp3",
			latency: "normal",
			normalize: true,
			speed: 1,
			player: "/usr/bin/afplay",
			requestTimeoutMs: 20_000,
			playbackTimeoutMs: 60_000,
			maxAudioBytes: 10 * 1024 * 1024,
		},
		bark: {
			serverUrl: "$BARK_SERVER_URL",
			deviceKeys: "$BARK_DEVICES_KEYS",
			path: "/push",
			requestTimeoutMs: 10_000,
		},
	},
	detection: {
		questionToolNames: ["question", "ask_question", "request_user_input"],
		notifyRecoveredToolErrors: false,
		permission: {
			eventChannel: "permissions:ui_prompt",
			decisionChannel: "permissions:decision",
		},
	},
	fallbackMessages: {
		idle: "Pi 任务完成，正在等待你的下一步操作。",
		permission: "Pi 正在等待授权，需要你的确认。",
		question: "Pi 正在等待输入，需要你的决定。",
		error: "Pi 任务执行失败，请查看当前会话中的错误信息。",
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(max, Math.max(min, value))
		: fallback;
}

function timeValue(value: unknown, fallback: string): string {
	if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
		return fallback;
	}
	return value;
}

/** Parse only the small public schema; internal tuning is deliberately not configurable. */
export function parseConfig(value: unknown, configPath = resolveConfigPath()): NotifyConfig {
	const config = structuredClone(DEFAULT_CONFIG);
	config.configDirectory = dirname(resolve(configPath));
	if (!isRecord(value)) {
		warnOnce("config", "配置必须是 JSON 对象，通知已关闭。");
		return config;
	}
	const summary = isRecord(value.summary) ? value.summary : {};
	const notify = isRecord(value.notify) ? value.notify : {};
	const quiet = isRecord(notify.quietHours) ? notify.quietHours : {};
	const fish = isRecord(value.fishAudio) ? value.fishAudio : null;
	const bark = isRecord(value.bark) ? value.bark : null;
	config.enabled = booleanValue(value.enabled, true);
	config.summaryLanguage = stringValue(value.language, config.summaryLanguage);
	config.summary.enabled = value.summary !== false;
	config.summary.model = stringValue(summary.model, "");
	config.summary.instructions = stringValue(summary.instructions, "").slice(0, 2000);
	config.notifyPolicy.idleDelayMs = numberValue(notify.idleDelaySeconds, 30, 0, 600) * 1000;
	config.notifyPolicy.ignoreShortTasksSeconds = numberValue(notify.minTaskSeconds, 10, 0, 3600);
	if (Object.keys(quiet).length) {
		config.notifyPolicy.quietHours.enabled = true;
		config.notifyPolicy.quietHours.start = timeValue(quiet.start, "23:00");
		config.notifyPolicy.quietHours.end = timeValue(quiet.end, "08:00");
	}
	if (fish) {
		config.deliveryBackends.push("fishaudio");
		config.backends.fishAudio.apiKey = stringValue(fish.apiKey, config.backends.fishAudio.apiKey);
		config.backends.fishAudio.referenceId = stringValue(fish.referenceId, config.backends.fishAudio.referenceId);
		config.backends.fishAudio.model = stringValue(fish.model, config.backends.fishAudio.model);
	}
	if (bark) {
		config.deliveryBackends.push("bark");
		config.backends.bark.serverUrl = stringValue(bark.serverUrl, config.backends.bark.serverUrl);
		config.backends.bark.deviceKeys = Array.isArray(bark.deviceKeys)
			? bark.deviceKeys.filter((key): key is string => typeof key === "string" && Boolean(key.trim()))
			: stringValue(bark.deviceKeys, "$BARK_DEVICES_KEYS");
	}
	return config;
}

function warnOnce(key: string, message: string): void {
	if (warned.has(key)) return;
	warned.add(key);
	console.warn(`[pi-brief] ${message}`);
}

export function loadConfig(configPath = resolveConfigPath()): NotifyConfig {
	try {
		if (existsSync(configPath)) return parseConfig(JSON.parse(readFileSync(configPath, "utf8")), configPath);
	} catch {
		warnOnce("config", "配置文件无法读取，通知已关闭。");
	}
	return { ...structuredClone(DEFAULT_CONFIG), configDirectory: dirname(resolve(configPath)) };
}
