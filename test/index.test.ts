import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExtensionRuntime, ExtensionRunner } from "@earendil-works/pi-coding-agent";

import {
	consumeFetchWithTimeout,
	createFishAudioSender,
	FISH_AUDIO_PI_AGENT_PHONEME,
	fishAudioTextForPiAgent,
	isSuccessfulBarkResponse,
	parseBarkDeviceKeys,
} from "../backends.ts";
import {
	DEFAULT_CONFIG,
	eventPresentation,
	loadConfig,
	notificationFallback,
	resolveAgentDirectory,
	resolveConfigPath,
} from "../config.ts";
import agentNotifyExtension from "../index.ts";
import { installAgentNotify } from "../runtime.ts";
import {
	isBlockingQuestionText,
	isInternalWorkerProcess,
	readAssistantOutcome,
	readPermissionUiPromptEvent,
	shouldDispatchNotification,
	summarizePermissionAction,
} from "../detection.ts";
import {
	isNotificationAllowedNow,
	isQuietHours,
	shouldIgnoreShortIdle,
} from "../policy.ts";
import {
	buildSummaryPrompt,
	evidenceAwareFallback,
	normalizeSummaryOutput,
	runSummaryAgent,
	sanitizeEvidenceText,
	sessionModelRef,
	SUMMARY_SYSTEM_PROMPT,
	summaryConfigForSession,
} from "../summary.ts";
import type { HostContext } from "../host.ts";
import { createRuntimeSecretsSource } from "../secrets.ts";
import type {
	DeliveryResult,
	NotifyConfig,
	RuntimeSecrets,
	SummaryContext,
} from "../types.ts";

const TEST_SECRETS: RuntimeSecrets = {
	fishAudio: {
		apiKey: "test-key",
		referenceId: "test-voice",
		model: "s2-pro",
	},
	bark: {
		serverUrl: "https://example.invalid",
		deviceKeys: ["test-device"],
	},
};

function config(): NotifyConfig {
	const value = structuredClone(DEFAULT_CONFIG);
	value.enabled = true;
	value.deliveryBackends = ["fishaudio", "bark"];
	return value;
}

function context(sessionId = "root-session"): HostContext {
	return {
		mode: "tui",
		hasUI: true,
		ui: {
			select: async () => undefined,
			input: async () => undefined,
			notify: () => undefined,
		},
		sessionManager: { getSessionId: () => sessionId },
		isIdle: () => true,
		hasPendingMessages: () => false,
	};
}

function fakePi() {
	const handlers = new Map<string, Array<(event: Record<string, unknown>, ctx: HostContext) => unknown>>();
	const eventHandlers = new Map<string, (payload: unknown) => void>();
	const commands: string[] = [];
	const commandHandlers = new Map<
		string,
		(args: string, ctx: HostContext) => unknown
	>();
	let toolRegistrations = 0;
	const api = {
		on(event: string, handler: (event: Record<string, unknown>, ctx: HostContext) => unknown) {
			const values = handlers.get(event) ?? [];
			values.push(handler);
			handlers.set(event, values);
		},
		events: {
			on(channel: string, handler: (payload: unknown) => void) {
				eventHandlers.set(channel, handler);
				return () => eventHandlers.delete(channel);
			},
		},
		registerCommand(
			name: string,
			command: { handler(args: string, ctx: HostContext): unknown },
		) {
			commands.push(name);
			commandHandlers.set(name, command.handler);
		},
		exec: async () => { throw new Error("Unexpected credential command"); },
		registerTool() {
			toolRegistrations += 1;
		},
	};
	return {
		api,
		handlers,
		eventHandlers,
		commands,
		commandHandlers,
		get toolRegistrations() {
			return toolRegistrations;
		},
		async emit(name: string, event: Record<string, unknown>, ctx = context()) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

test("worker detection covers pi-subagents and pi-landstrip", () => {
	assert.equal(isInternalWorkerProcess({ PI_SUBAGENT_CHILD: "1" }), true);
	assert.equal(isInternalWorkerProcess({ PI_LANDSTRIP_WORKER: "encoded" }), true);
	const landstrip = Buffer.from(JSON.stringify({ role: "subagent" })).toString("base64url");
	assert.equal(isInternalWorkerProcess({ LANDSTRIP_CONTEXT: landstrip }), true);
	const primary = Buffer.from(JSON.stringify({ role: "primary" })).toString("base64url");
	assert.equal(isInternalWorkerProcess({ LANDSTRIP_CONTEXT: primary }), false);
	assert.equal(
		isInternalWorkerProcess({ PI_SUBAGENT_PARENT_SESSION: "root-session" }),
		false,
	);
});

test("worker factory guard registers nothing", async () => {
	const previous = process.env.PI_LANDSTRIP_WORKER;
	process.env.PI_LANDSTRIP_WORKER = "worker";
	let registrations = 0;
	const api = {
		on: () => { registrations += 1; },
		events: { on: () => { registrations += 1; return () => undefined; } },
		registerCommand: () => { registrations += 1; },
		registerTool: () => { registrations += 1; },
	};
	try {
		await agentNotifyExtension(api as never);
		assert.equal(registrations, 0);
	} finally {
		if (previous === undefined) delete process.env.PI_LANDSTRIP_WORKER;
		else process.env.PI_LANDSTRIP_WORKER = previous;
	}
});

test("root installation observes hooks but never registers a root tool", () => {
	const pi = fakePi();
	installAgentNotify(pi.api as never, config(), TEST_SECRETS);
	assert.ok(pi.handlers.has("before_agent_start"));
	assert.ok(pi.handlers.has("agent_settled"));
	assert.deepEqual(pi.commands, ["pi-brief-test"]);
	assert.equal(pi.toolRegistrations, 0);
});

test("enabled factory installs hooks without waiting for session_start", async () => {
	const previous = process.env.PI_BRIEF_CONFIG;
	const previousFishApiKey = process.env.FISH_API_KEY;
	const configPath = join(
		tmpdir(),
		`pi-brief-factory-${process.pid}-${Date.now()}.json`,
	);
	writeFileSync(configPath, JSON.stringify({
		fishAudio: { apiKey: "!{/does/not/exist}", referenceId: "test" },
		summary: false,
	}));
	process.env.PI_BRIEF_CONFIG = configPath;
	process.env.FISH_API_KEY = "factory-test-secret";
	try {
		const { default: factory } = await import(`../index.ts?factory=${Date.now()}`);
		const pi = fakePi();
		factory(pi.api as never);
		assert.equal(process.env.FISH_API_KEY, "factory-test-secret");
		assert.ok(pi.handlers.has("before_agent_start"));
		assert.ok(pi.handlers.has("agent_settled"));
		assert.deepEqual(pi.commands, ["pi-brief-test"]);
		await pi.emit("session_start", {}, context());
	} finally {
		rmSync(configPath, { force: true });
		if (previous === undefined) delete process.env.PI_BRIEF_CONFIG;
		else process.env.PI_BRIEF_CONFIG = previous;
		if (previousFishApiKey === undefined) delete process.env.FISH_API_KEY;
		else process.env.FISH_API_KEY = previousFishApiKey;
	}
});

test("runtime resolves secrets once when first delivery needs them", { timeout: 1000 }, async () => {
	const pi = fakePi();
	const cfg = config();
	cfg.summary.enabled = false;
	let resolveCalls = 0;
	let releaseSecrets: (secrets: RuntimeSecrets) => void = () => undefined;
	const pendingSecrets = new Promise<RuntimeSecrets>((resolve) => {
		releaseSecrets = resolve;
	});
	const delivered: string[] = [];
	let markDeliveriesComplete: () => void = () => undefined;
	const deliveriesComplete = new Promise<void>((resolve) => {
		markDeliveriesComplete = resolve;
	});
	const recordDelivery = (value: string): void => {
		delivered.push(value);
		if (delivered.length === 4) markDeliveriesComplete();
	};
	installAgentNotify(
		pi.api as never,
		cfg,
		async () => {
			resolveCalls += 1;
			return pendingSecrets;
		},
		{
			sendFish: async (payload, _config, secrets) => {
				assert.equal(secrets, TEST_SECRETS);
				recordDelivery(`fish:${payload.type}`);
				return { ok: true };
			},
			sendBark: async (payload, _config, secrets) => {
				assert.equal(secrets, TEST_SECRETS);
				recordDelivery(`bark:${payload.type}`);
				return { ok: true };
			},
		},
	);

	const ctx = context();
	await pi.emit("session_start", {}, ctx);
	assert.equal(resolveCalls, 0);

	const handler = pi.commandHandlers.get("pi-brief-test");
	assert.ok(handler);
	const first = Promise.resolve(handler("permission", ctx));
	const second = Promise.resolve(handler("error", ctx));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(resolveCalls, 1);

	releaseSecrets(TEST_SECRETS);
	await Promise.all([first, second]);
	await deliveriesComplete;
	assert.deepEqual(delivered.sort(), [
		"bark:error",
		"bark:permission",
		"fish:error",
		"fish:permission",
	]);
});

test("pi-brief-test returns before a pending Fish delivery rejects", async () => {
	const pi = fakePi();
	const cfg = config();
	cfg.deliveryBackends = ["fishaudio"];
	cfg.summary.enabled = false;
	let rejectFish: (reason: Error) => void = () => undefined;
	const fishResult = new Promise<DeliveryResult>((_resolve, reject) => {
		rejectFish = reject;
	});
	let notificationMessage = "";
	let notificationType = "";
	let markNotified: () => void = () => undefined;
	const notified = new Promise<void>((resolve) => {
		markNotified = resolve;
	});
	installAgentNotify(pi.api as never, cfg, TEST_SECRETS, {
		runSummary: async () => null,
		sendFish: async () => fishResult,
		sendBark: async () => ({ ok: true }),
	});

	const baseContext = context();
	const ctx: HostContext = {
		...baseContext,
		ui: {
			...baseContext.ui,
			notify(message, type) {
				notificationMessage = message;
				notificationType = type ?? "";
				markNotified();
			},
		},
	};
	await pi.emit("session_start", {}, ctx);
	const handler = pi.commandHandlers.get("pi-brief-test");
	assert.ok(handler);

	let commandReturned = false;
	const command = Promise.resolve(handler("error", ctx)).then(() => {
		commandReturned = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	const returnedBeforeFish = commandReturned;
	rejectFish(new Error("synthetic Fish failure"));
	await command;
	await notified;

	assert.equal(returnedBeforeFish, true);
	assert.match(notificationMessage, /fishaudio failed/);
	assert.equal(notificationType, "warning");
});

test("Bark device keys accept arrays, strings, and comma-separated values", () => {
	assert.deepEqual(parseBarkDeviceKeys('["one", "two", "one"]'), ["one", "two"]);
	assert.deepEqual(parseBarkDeviceKeys('"one"'), ["one"]);
	assert.deepEqual(parseBarkDeviceKeys("one, two,one"), ["one", "two"]);
	assert.deepEqual(parseBarkDeviceKeys(undefined), []);
});

test("Bark batch response validates every configured device result", () => {
	assert.equal(isSuccessfulBarkResponse({
		code: 200,
		data: [
			{ code: 200, device_key: "one" },
			{ code: 200, device_key: "two" },
		],
	}, 2), true);
	assert.equal(isSuccessfulBarkResponse({
		code: 200,
		data: [
			{ code: 200, device_key: "one" },
			{ code: 500, device_key: "two" },
		],
	}, 2), false);
	assert.equal(isSuccessfulBarkResponse({ code: 200, message: "success" }, 1), false);
});

test("Fish Audio rewrites only the leading Pi Agent product identifier", () => {
	assert.equal(
		fishAudioTextForPiAgent("Pi 任务已经完成。"),
		`${FISH_AUDIO_PI_AGENT_PHONEME} 任务已经完成。`,
	);
	assert.equal(
		fishAudioTextForPiAgent("Pi。修复了缓存失效问题。"),
		`${FISH_AUDIO_PI_AGENT_PHONEME}。修复了缓存失效问题。`,
	);
	for (const unchanged of [
		"pi 任务已经完成。",
		"PiAgent 任务已经完成。",
		"任务涉及 Pi 和 Raspberry Pi。",
		"Pipeline task complete.",
	]) {
		assert.equal(fishAudioTextForPiAgent(unchanged), unchanged);
	}
});

test("current config needs no version field and keeps transport tuning internal", () => {
	const configPath = new URL("./unsafe-config.json", import.meta.url);
	writeFileSync(configPath, JSON.stringify({
		notifyRootOnly: false,
		fishAudio: { apiKey: "$FISH_API_KEY", referenceId: "voice" },
		notify: { idleDelaySeconds: -1, quietHours: { start: "not-a-time", end: "08:00" } },
		summary: { timeoutMs: 0, thinking: "max" },
		backends: { fishAudio: { requestTimeoutMs: 0, player: "/bad/player" } },
	}));
	try {
		const loaded = loadConfig(configPath.pathname);
		assert.equal(loaded.notifyRootOnly, true);
		assert.deepEqual(loaded.deliveryBackends, ["fishaudio"]);
		assert.equal(loaded.notifyPolicy.idleDelayMs, 0);
		assert.equal(loaded.notifyPolicy.quietHours.start, "23:00");
		assert.deepEqual(loaded.notifyPolicy.quietHours.allowDuringQuietHours, ["permission", "error"]);
		assert.equal(loaded.summary.timeoutMs, DEFAULT_CONFIG.summary.timeoutMs);
		assert.equal(loaded.backends.fishAudio.player, DEFAULT_CONFIG.backends.fishAudio.player);
	} finally { rmSync(configPath); }
});

test("missing user config is a safe no-op", () => {
	const configPath = join(
		tmpdir(),
		`pi-brief-missing-${process.pid}-${Date.now()}.json`,
	);
	const loaded = loadConfig(configPath);
	assert.equal(loaded.enabled, false);
	assert.deepEqual(loaded.deliveryBackends, []);


});

test("example configuration uses placeholders and is loaded only through an explicit fixture", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-brief-config-"));
	try {
		const fixturePath = join(directory, "config.json");
		const example = readFileSync(new URL("../config.example.json", import.meta.url), "utf8");
		writeFileSync(fixturePath, example);
		const loaded = loadConfig(fixturePath);
		assert.equal(loaded.enabled, true);
		assert.deepEqual(loaded.deliveryBackends, ["fishaudio"]);
		assert.equal(loaded.configDirectory, directory);
		assert.equal(loaded.backends.fishAudio.apiKey, "$FISH_API_KEY");
		assert.equal(loaded.backends.fishAudio.referenceId, "$FISH_REFERENCE_ID");
		assert.equal(loaded.summary.model, "");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a fresh Pi profile stays disabled even with the packaged example present", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-brief-profile-"));
	const previousDirectory = process.env.PI_CODING_AGENT_DIR;
	const previousConfig = process.env.PI_BRIEF_CONFIG;
	try {
		process.env.PI_CODING_AGENT_DIR = directory;
		delete process.env.PI_BRIEF_CONFIG;
		const pi = fakePi();
		agentNotifyExtension(pi.api as never);
		assert.equal(pi.handlers.size, 0);
		assert.equal(pi.eventHandlers.size, 0);
		assert.equal(pi.commands.length, 0);
	} finally {
		if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDirectory;
		if (previousConfig === undefined) delete process.env.PI_BRIEF_CONFIG;
		else process.env.PI_BRIEF_CONFIG = previousConfig;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("config resolution uses only explicit or host-owned user paths", () => {
	assert.equal(
		resolveConfigPath(
			{
				PI_BRIEF_CONFIG: "/custom/pi-brief.json",
				PI_CODING_AGENT_DIR: "/custom/agent",
			},
		),
		"/custom/pi-brief.json",
	);
	assert.equal(
		resolveConfigPath(
			{ PI_CODING_AGENT_DIR: "/custom/agent" },
		),
		"/custom/agent/pi-brief/config.json",
	);
	assert.equal(
		resolveAgentDirectory({ PI_CODING_AGENT_DIR: "~/custom-agent" }),
		join(process.env.HOME ?? tmpdir(), "custom-agent"),
	);
});

test("built-in Bark presentation and fallback follow English summary language", () => {
	assert.equal(eventPresentation("permission", "en-US").title, "Pi · Permission required");
	assert.equal(
		notificationFallback(
			"question",
			"en-US",
			DEFAULT_CONFIG.fallbackMessages.question,
		),
		"Pi needs your input before it can continue.",
	);
	assert.equal(
		notificationFallback("question", "en-US", "Pi custom fallback."),
		"Pi custom fallback.",
	);
});

test("permission public event parser accepts current contract only", () => {
	assert.deepEqual(
		readPermissionUiPromptEvent({
			requestId: "request-1",
			source: "tool_call",
			surface: "bash",
			value: "sensitive command",
			message: "Permission required",
			forwarding: {
				requesterAgentName: "worker",
				requesterSessionId: "child-session",
			},
		}),
		{
			requestId: "request-1",
			source: "tool_call",
			surface: "bash",
			value: "sensitive command",
			message: "Permission required",
			agentName: null,
			forwarding: {
				requesterAgentName: "worker",
				requesterSessionId: "child-session",
			},
		},
	);
	assert.equal(readPermissionUiPromptEvent({ requestId: "request-1" }), null);
});

test("permission summaries retain safe action labels but never raw values", () => {
	assert.equal(
		summarizePermissionAction(
			"bash",
			"git push https://user:password@example.com/private-token",
		),
		"Permission is required to run git push.",
	);
	const network = summarizePermissionAction(
		"bash",
		"curl -u alice:swordfish -H 'X-Auth: opaque-secret' https://example.com/device-key", // gitleaks:allow -- synthetic redaction fixture
	);
	assert.equal(network, "Permission is required to run a network request.");
	assert.ok(!network.includes("swordfish"));
	assert.ok(!network.includes("opaque-secret"));
	assert.ok(!network.includes("device-key"));
});

test("assistant terminal outcomes distinguish errors and aborts", () => {
	assert.equal(readAssistantOutcome({ role: "assistant", stopReason: "error" }), "error");
	assert.equal(
		readAssistantOutcome({ role: "assistant", stopReason: "stop", errorMessage: "failure" }),
		"error",
	);
	assert.equal(readAssistantOutcome({ role: "assistant", stopReason: "aborted" }), "aborted");
	assert.equal(readAssistantOutcome({ role: "assistant", stopReason: "stop" }), "completed");
	assert.equal(readAssistantOutcome({ role: "user" }), "unknown");
});

test("distinct scoped permission requests are not swallowed by debounce", () => {
	const scopes = new Set<string>();
	const last = new Map<"permission", number>();
	assert.equal(
		shouldDispatchNotification(scopes, last, "permission", "root:permission:one", true, 1000, 1000),
		true,
	);
	assert.equal(
		shouldDispatchNotification(scopes, last, "permission", "root:permission:two", true, 1001, 1000),
		true,
	);
	assert.equal(
		shouldDispatchNotification(scopes, last, "permission", "root:permission:one", true, 2000, 1000),
		false,
	);
});

test("quiet hours support daytime and cross-midnight windows", () => {
	const crossMidnight = {
		enabled: true,
		start: "23:00",
		end: "08:00",
		allowDuringQuietHours: ["permission", "error"] as const,
	};
	assert.equal(isQuietHours(new Date(2026, 0, 1, 23, 30), crossMidnight as never), true);
	assert.equal(isQuietHours(new Date(2026, 0, 2, 7, 59), crossMidnight as never), true);
	assert.equal(isQuietHours(new Date(2026, 0, 2, 12, 0), crossMidnight as never), false);
	assert.equal(
		isNotificationAllowedNow("idle", crossMidnight as never, new Date(2026, 0, 1, 23, 30)),
		false,
	);
	assert.equal(
		isNotificationAllowedNow("permission", crossMidnight as never, new Date(2026, 0, 1, 23, 30)),
		true,
	);
});

test("short task suppression applies to idle durations", () => {
	assert.equal(shouldIgnoreShortIdle(9999, 10), true);
	assert.equal(shouldIgnoreShortIdle(10_000, 10), false);
	assert.equal(shouldIgnoreShortIdle(undefined, 10), false);
});

test("summary model follows the live session unless config overrides it", () => {
	assert.equal(sessionModelRef({ provider: "xai", id: "grok-4.6" }), "xai/grok-4.6");
	assert.equal(sessionModelRef({ provider: "xai" }), undefined);
	const inherited = summaryConfigForSession(config().summary, "xai/grok-4.6");
	assert.equal(inherited.model, "xai/grok-4.6");
	const overridden = summaryConfigForSession(
		{ ...config().summary, model: "openai/gpt-5" },
		"xai/grok-4.6",
	);
	assert.equal(overridden.model, "openai/gpt-5");
});

test("summary prompt contains only bounded structured evidence", () => {
	const summaryContext: SummaryContext = {
		language: "zh-CN",
		event: "idle",
		session: { id: "root", rootOnly: true },
		state: {
			currentTask: "token=secret-value; finish work",
			recentActions: Array.from({ length: 20 }, (_, index) => `action ${index}`),
		},
		recentMessages: [{ role: "assistant", text: "Authorization: Bearer abcdef" }],
	};
	const prompt = buildSummaryPrompt(summaryContext, 120, 500);
	const boundedContext = JSON.parse(prompt.split("\n").at(-1) ?? "{}") as unknown;
	assert.ok(prompt.includes('"rootOnly":true'));
	assert.ok(JSON.stringify(boundedContext).length <= 500);
	assert.ok(!prompt.includes("secret-value"));
	assert.ok(!prompt.includes("Bearer abcdef"));
});

test("summary context limit is enforced after every optional field is populated", () => {
	const repeated = "x".repeat(1900);
	const prompt = buildSummaryPrompt({
		language: "zh-CN",
		event: "permission",
		session: { id: repeated, rootOnly: true },
		state: {
			durationMs: 123,
			currentTask: repeated,
			changedFiles: Array.from({ length: 10 }, () => repeated),
			recentActions: Array.from({ length: 8 }, () => repeated),
			validation: repeated,
			pendingAction: repeated,
			errorMessage: repeated,
		},
		recentMessages: [
			{ role: "user", text: repeated },
			{ role: "assistant", text: repeated },
		],
	}, 120, 1000);
	const bounded = JSON.parse(prompt.split("\n").at(-1) ?? "{}") as unknown;
	assert.ok(JSON.stringify(bounded).length <= 1000);
});

test("evidence-aware fallback briefs the task outcome instead of a canned status", () => {
	const context: SummaryContext = {
		language: "zh-CN",
		event: "idle",
		session: { id: "root", rootOnly: true },
		state: {
			currentTask: "修复 markdown 表格分隔行对齐",
			recentActions: ["Updated markdown-modern delimiter rendering."],
		},
		recentMessages: [
			{ role: "user", text: "修复 markdown 表格分隔行对齐" },
			{
				role: "assistant",
				text: "已让 markdown-modern 在 valign 开启时跳过分隔线美化，测试全部通过。",
			},
		],
	};
	const text = evidenceAwareFallback(
		"idle",
		"zh-CN",
		context,
		DEFAULT_CONFIG.fallbackMessages.idle,
	);
	assert.ok(text);
	assert.match(text, /^Pi/);
	assert.match(text, /markdown|表格|对齐|valign/i);
	assert.notEqual(text, DEFAULT_CONFIG.fallbackMessages.idle);
	assert.ok(!/正在等待你的下一步操作/.test(text) || /完成/.test(text));
});

test("summary system prompt asks for a concrete recap, not a template", () => {
	assert.match(SUMMARY_SYSTEM_PROMPT, /spoken recap/i);
	assert.match(SUMMARY_SYSTEM_PROMPT, /untrusted evidence/i);
	assert.match(SUMMARY_SYSTEM_PROMPT, /finished result/i);
	assert.match(SUMMARY_SYSTEM_PROMPT, /NO_NOTIFICATION/);
	assert.ok(!/Explain:\s*\n\s*1\. Current status/i.test(SUMMARY_SYSTEM_PROMPT));
});

test("summary output starts with Pi and is never hard-truncated", () => {
	assert.equal(normalizeSummaryOutput("修复了缓存失效问题。", 100), "Pi。修复了缓存失效问题。");
	assert.equal(normalizeSummaryOutput("Pi 缓存修复已通过验证。", 100), "Pi 缓存修复已通过验证。");
	assert.equal(normalizeSummaryOutput("Pi " + "a".repeat(101), 100), null);
	assert.equal(normalizeSummaryOutput("- first\n- second", 100), null);
	assert.equal(
		normalizeSummaryOutput("The cache fix passed validation.", 100, "en-US"),
		"Pi. The cache fix passed validation.",
	);
	assert.equal(normalizeSummaryOutput("Cache fix passed.", 100, "zh-CN"), null);
	assert.equal(normalizeSummaryOutput("缓存修复通过验证。", 100, "en-US"), null);
	const redactedOutput = normalizeSummaryOutput(
		"Pi。password is hunter2，任务等待处理。",
		200,
		"zh-CN",
	);
	assert.ok(redactedOutput);
	assert.ok(!redactedOutput.includes("hunter2"));
});

test("summary evidence redacts credentials", () => {
	assert.equal(
		sanitizeEvidenceText("Authorization: Bearer abc.def and token=secret", 200),
		"Authorization: [redacted] and token=[redacted]",
	);
	const sensitive = sanitizeEvidenceText(
		'{"api_key":"top-secret"} --token ghp_abcdefghijklmnopqrstuvwxyz123456 https://user:pass@example.com/path?key=value -----BEGIN PRIVATE KEY----- abc -----END PRIVATE KEY-----',
		1000,
	);
	assert.ok(sensitive);
	assert.ok(!sensitive.includes("top-secret"));
	assert.ok(!sensitive.includes("ghp_"));
	assert.ok(!sensitive.includes("user:pass"));
	assert.ok(!sensitive.includes("BEGIN PRIVATE KEY"));
	assert.ok(!sensitive.includes("key=value"));
	const commandSecrets = sanitizeEvidenceText(
		"curl -u alice:swordfish -H 'X-Auth: opaque-secret' https://api.day.app/device-key mysql -pSuperSecret password is hunter2 dbpass=hunter2", // gitleaks:allow -- synthetic redaction fixture
		1000,
	);
	assert.ok(commandSecrets);
	for (const secret of [
		"swordfish",
		"opaque-secret",
		"device-key",
		"SuperSecret",
		"hunter2",
	]) {
		assert.ok(!commandSecrets.includes(secret));
	}

});

test("blocking question detection is conservative", () => {
	assert.equal(isBlockingQuestionText("需要你选择数据库迁移方案，才能继续。请选择 A 还是 B？"), true);
	assert.equal(isBlockingQuestionText("请选择 A 或 B。"), true);
	assert.equal(isBlockingQuestionText("实现已经完成。还有什么需要帮助的吗？"), false);
	assert.equal(isBlockingQuestionText("Pi needs your confirmation before I continue?"), true);
	assert.equal(isBlockingQuestionText("I need your confirmation before I continue."), true);
	assert.equal(
		isBlockingQuestionText("Which option should I use?\n\n1. PostgreSQL\n2. SQLite"),
		true,
	);
	assert.equal(
		isBlockingQuestionText("There are two approaches. Which do you prefer?"),
		true,
	);
	assert.equal(isBlockingQuestionText("两个方案：A 和 B，你更倾向哪个？"), true);
	assert.equal(isBlockingQuestionText("要继续执行吗？"), true);
	assert.equal(
		isBlockingQuestionText("Would you like me to proceed with deployment?"),
		true,
	);
	assert.equal(
		isBlockingQuestionText("请告诉我你希望使用哪个数据库。"),
		true,
	);
	assert.equal(
		isBlockingQuestionText(
			"Which option should I use? I chose PostgreSQL and completed the migration.",
		),
		false,
	);
	assert.equal(
		isBlockingQuestionText("需要你选择数据库迁移方案吗？我已经选择 PostgreSQL 并完成迁移。"),
		false,
	);
	for (const completionOffer of [
		"The task is complete. Do you want anything else?",
		"All done. Do you want me to help with anything else?",
		"任务完成。你还要我做什么吗？",
		"任务完成。要我继续帮你处理其他事情吗？",
	]) {
		assert.equal(isBlockingQuestionText(completionOffer), false);
	}
});

test("missing model registry returns fallback signal without throwing", async () => {
	const cfg = config().summary;
	cfg.timeoutMs = 1000;
	const value = await runSummaryAgent({
		language: "zh-CN",
		event: "idle",
		session: { id: "root", rootOnly: true },
		state: {},
	}, cfg);
	assert.equal(value, null);
});

test("fetch timeout remains active while streamed body is consumed", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let readingBody = false;
	const fakeFetch: typeof fetch = async (_input, init) => {
		const signal = init?.signal;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
				signal?.addEventListener("abort", () => {
					controller.error(new DOMException("aborted", "AbortError"));
				}, { once: true });
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { "content-type": "application/octet-stream" },
		});
	};
	const rejection = assert.rejects(
		consumeFetchWithTimeout(
			"https://example.invalid",
			{},
			20,
			(response) => { readingBody = true; return response.arrayBuffer(); },
			fakeFetch,
		),
		/timed out/i,
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(readingBody, true, "the response arrived and its body is still pending");
	t.mock.timers.tick(20);
	await rejection;
});

test("lifecycle waits for idle delay and reuses one summary for both backends", async () => {
	const pi = fakePi();
	const cfg = config();
	cfg.notifyPolicy.idleDelayMs = 15;
	cfg.notifyPolicy.ignoreShortTasksSeconds = 0;
	let now = 1000;
	let summaryCalls = 0;
	const delivered: string[] = [];
	const summaryModels: string[] = [];
	installAgentNotify(pi.api as never, cfg, TEST_SECRETS, {
		now: () => now,
		runSummary: async (summaryContext, summaryConfig) => {
			summaryCalls += 1;
			summaryModels.push(summaryConfig.model);
			assert.equal(summaryContext.event, "idle");
			assert.equal(summaryContext.session.rootOnly, true);
			assert.deepEqual(summaryContext.recentMessages, [
				{ role: "user", text: "Implement feature" },
				{
					role: "assistant",
					text: "Implemented feature and tests passed.",
				},
			]);
			return "Pi 任务完成，验证通过。";
		},
		sendFish: async (payload) => {
			delivered.push(`fish:${payload.summary}`);
			return { ok: true };
		},
		sendBark: async (payload) => {
			delivered.push(`bark:${payload.summary}`);
			return { ok: true };
		},
	});
	const ctx = { ...context(), model: { provider: "xai", id: "grok-4.6" } };
	await pi.emit("session_start", {}, ctx);
	await pi.emit("model_select", { model: { provider: "xai", id: "grok-4.1" } }, ctx);
	await pi.emit("before_agent_start", { prompt: "Implement feature" }, ctx);
	await pi.emit("agent_start", {}, ctx);
	now = 12_000;
	await pi.emit("message_end", {
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "Implemented feature and tests passed." }],
		},
	}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(summaryCalls, 0);
	await new Promise((resolve) => setTimeout(resolve, 35));
	assert.equal(summaryCalls, 1);
	assert.deepEqual(summaryModels, ["xai/grok-4.1"]);
	assert.deepEqual(
		delivered.sort(),
		[
			"bark:Pi 任务完成，验证通过。",
			"fish:Pi 任务完成，验证通过。",
		],
	);
});

test("a new root task cancels the previous delayed idle notification", async () => {
	const pi = fakePi();
	const cfg = config();
	cfg.notifyPolicy.idleDelayMs = 30;
	cfg.notifyPolicy.ignoreShortTasksSeconds = 0;
	let now = 0;
	let summaries = 0;
	installAgentNotify(pi.api as never, cfg, TEST_SECRETS, {
		now: () => now,
		runSummary: async () => {
			summaries += 1;
			return "Pi 完成。";
		},
		sendFish: async () => ({ ok: true }),
		sendBark: async () => ({ ok: true }),
	});
	const ctx = context();
	await pi.emit("session_start", {}, ctx);
	await pi.emit("before_agent_start", { prompt: "first" }, ctx);
	await pi.emit("agent_start", {}, ctx);
	now = 20_000;
	await pi.emit("message_end", {
		message: { role: "assistant", stopReason: "stop", content: "done" },
	}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	now = 20_001;
	await pi.emit("before_agent_start", { prompt: "second" }, ctx);
	await pi.emit("agent_start", {}, ctx);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(summaries, 0);
});

test("root settlement preserves an asynchronous permission notification and suppresses idle", async () => {
	const pi = fakePi();
	const cfg = config();
	cfg.deliveryBackends = ["bark"];
	cfg.notifyPolicy.idleDelayMs = 5;
	cfg.notifyPolicy.ignoreShortTasksSeconds = 0;
	let now = 1000;
	let summaryAborted = false;
	const delivered: string[] = [];
	installAgentNotify(pi.api as never, cfg, TEST_SECRETS, {
		now: () => now,
		runSummary: async (summaryContext, _summaryConfig, signal) => (
			new Promise((resolve) => {
				const timer = setTimeout(() => resolve(`Pi ${summaryContext.event}.`), 15);
				signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					summaryAborted = true;
					resolve(null);
				}, { once: true });
			})
		),
		sendFish: async () => ({ ok: true }),
		sendBark: async (payload) => {
			delivered.push(payload.type);
			return { ok: true };
		},
	});
	const ctx = context();
	await pi.emit("session_start", {}, ctx);
	await pi.emit("before_agent_start", { prompt: "Run a background task" }, ctx);
	await pi.emit("agent_start", {}, ctx);
	now = 20_000;
	pi.eventHandlers.get(cfg.detection.permission.eventChannel)?.({
		requestId: "async-permission",
		source: "tool_call",
		surface: "bash",
		value: "git push",
		message: "permission",
		forwarding: {
			requesterAgentName: "worker",
			requesterSessionId: "worker-session",
		},
	});
	await pi.emit("agent_settled", {}, ctx);
	await new Promise((resolve) => setTimeout(resolve, 35));
	assert.equal(summaryAborted, false);
	assert.deepEqual(delivered, ["permission"]);
});

test("forwarded permissions close through native UI or public decision events without disk state", async () => {
	for (const closeVia of ["ui", "decision"]) {
		const pi = fakePi();
		const cfg = config();
		cfg.deliveryBackends = ["bark"];
		cfg.summary.enabled = false;
		cfg.notifyPolicy.idleDelayMs = 5;
		cfg.notifyPolicy.ignoreShortTasksSeconds = 0;
		const delivered: string[] = [];
		installAgentNotify(pi.api as never, cfg, TEST_SECRETS, {
			sendBark: async (payload) => { delivered.push(payload.type); return { ok: true }; },
		});
		const ctx = context();
		await pi.emit("session_start", {}, ctx);
		await pi.emit("before_agent_start", { prompt: "Run forwarded work" }, ctx);
		await pi.emit("agent_start", {}, ctx);
		pi.eventHandlers.get(cfg.detection.permission.eventChannel)?.({
			requestId: "forwarded-1", source: "tool_call", surface: "bash", value: "git push",
			agentName: "worker", message: "permission",
			forwarding: { requesterAgentName: "worker", requesterSessionId: "child-session" },
		});
		if (closeVia === "ui") await pi.emit("ui_prompt_start", { kind: "custom", title: "" }, ctx);
		await pi.emit("agent_settled", {}, ctx);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(delivered, ["permission"]);
		if (closeVia === "ui") await pi.emit("ui_prompt_end", { kind: "custom" }, ctx);
		else pi.eventHandlers.get(cfg.detection.permission.decisionChannel)?.({
			surface: "bash", value: "git push", agentName: "worker", resolution: "user_approved",
		});
		await pi.emit("before_agent_start", { prompt: "Continue after approval" }, ctx);
		await pi.emit("agent_start", {}, ctx);
		await pi.emit("message_end", { message: { role: "assistant", stopReason: "stop", content: "已修复缓存错误，12 项测试通过。" } }, ctx);
		await pi.emit("agent_settled", {}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(delivered, ["permission", "idle"]);
		await pi.emit("session_shutdown", {}, ctx);
	}
});

test("orphaned public permissions expire while native prompt lifetimes remain authoritative", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const nativePrompt of [false, true]) {
		const pi = fakePi();
		const cfg = config();
		let aborted = false;
		installAgentNotify(pi.api as never, cfg, TEST_SECRETS, {
			runSummary: async (_context, _config, signal) => new Promise((resolve) => {
				signal?.addEventListener("abort", () => { aborted = true; resolve(null); }, { once: true });
			}),
			sendBark: async () => assert.fail("expired permission must not be delivered"),
			sendFish: async () => assert.fail("expired permission must not be delivered"),
		});
		const ctx = context();
		await pi.emit("session_start", {}, ctx);
		pi.eventHandlers.get(cfg.detection.permission.eventChannel)?.({
			requestId: "orphan-1", source: "tool_call", surface: "bash", value: "git push",
			message: "permission", forwarding: { requesterAgentName: "worker" },
		});
		if (nativePrompt) await pi.emit("ui_prompt_start", { kind: "custom", title: "" }, ctx);
		await new Promise((resolve) => setImmediate(resolve));
		t.mock.timers.tick(10 * 60 * 1000);
		assert.equal(aborted, !nativePrompt);
		if (nativePrompt) {
			await pi.emit("ui_prompt_end", { kind: "custom" }, ctx);
			assert.equal(aborted, true);
		}
		await pi.emit("session_shutdown", {}, ctx);
	}
});

test("unrelated or automatic permission decisions do not cancel a UI notification", async () => {
	const pi = fakePi();
	const cfg = config();
	cfg.deliveryBackends = ["bark"];
	let aborted = false;
	let delivered = 0;
	installAgentNotify(pi.api as never, cfg, TEST_SECRETS, {
		runSummary: async (_summaryContext, _summaryConfig, signal) => (
			new Promise((resolve) => {
				const timer = setTimeout(() => resolve("Pi 等待授权。"), 20);
				signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					aborted = true;
					resolve(null);
				}, { once: true });
			})
		),
		sendFish: async () => ({ ok: true }),
		sendBark: async () => {
			delivered += 1;
			return { ok: true };
		},
	});
	const ctx = context();
	await pi.emit("session_start", {}, ctx);
	pi.eventHandlers.get(cfg.detection.permission.eventChannel)?.({
		requestId: "decision-scope",
		source: "tool_call",
		surface: "bash",
		value: "git push",
		agentName: "root",
		message: "permission",
		forwarding: null,
	});
	pi.eventHandlers.get(cfg.detection.permission.decisionChannel)?.({
		surface: "bash",
		value: "git push",
		result: "allow",
		resolution: "policy_allow",
		agentName: "root",
	});
	pi.eventHandlers.get(cfg.detection.permission.decisionChannel)?.({
		surface: "bash",
		value: "git push",
		result: "allow",
		resolution: "user_approved",
		agentName: "another-agent",
	});
	await new Promise((resolve) => setTimeout(resolve, 35));
	assert.equal(aborted, false);
	assert.equal(delivered, 1);
});

test("one user decision resolves only one identical concurrent permission request", async () => {
	const pi = fakePi();
	const cfg = config();
	cfg.deliveryBackends = ["bark"];
	let aborted = 0;
	installAgentNotify(pi.api as never, cfg, TEST_SECRETS, {
		runSummary: async (_summaryContext, _summaryConfig, signal) => (
			new Promise((resolve) => {
				signal?.addEventListener("abort", () => {
					aborted += 1;
					resolve(null);
				}, { once: true });
			})
		),
		sendFish: async () => ({ ok: true }),
		sendBark: async () => ({ ok: true }),
	});
	const ctx = context();
	await pi.emit("session_start", {}, ctx);
	for (const requestId of ["same-1", "same-2"]) {
		pi.eventHandlers.get(cfg.detection.permission.eventChannel)?.({
			requestId,
			source: "tool_call",
			surface: "bash",
			value: "git push",
			agentName: "root",
			message: "permission",
			forwarding: null,
		});
	}
	await new Promise((resolve) => setTimeout(resolve, 0));
	pi.eventHandlers.get(cfg.detection.permission.decisionChannel)?.({
		surface: "bash",
		value: "git push",
		result: "allow",
		resolution: "user_approved",
		agentName: "root",
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(aborted, 1);
	await pi.emit("session_shutdown", {}, ctx);
	assert.equal(aborted, 2);
});

test("session shutdown aborts an in-flight summary before delivery", async () => {
	const pi = fakePi();
	const cfg = config();
	let summaryAborted = false;
	let deliveries = 0;
	installAgentNotify(pi.api as never, cfg, TEST_SECRETS, {
		runSummary: async (_summaryContext, _summaryConfig, signal) => (
			new Promise((resolve) => {
				signal?.addEventListener("abort", () => {
					summaryAborted = true;
					resolve(null);
				}, { once: true });
			})
		),
		sendFish: async () => {
			deliveries += 1;
			return { ok: true };
		},
		sendBark: async () => {
			deliveries += 1;
			return { ok: true };
		},
	});
	const ctx = context();
	await pi.emit("session_start", {}, ctx);
	await pi.emit("before_agent_start", { prompt: "push changes" }, ctx);
	await pi.emit("agent_start", {}, ctx);
	pi.eventHandlers.get(cfg.detection.permission.eventChannel)?.({
		requestId: "permission-1",
		source: "tool_call",
		surface: "bash",
		message: "permission",
		forwarding: null,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	await pi.emit("session_shutdown", {}, ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(summaryAborted, true);
	assert.equal(deliveries, 0);
});

test("official Pi runner coalesces native custom/select prompts and cancels the notice on close", async () => {
	const pi = fakePi();
	let summaries = 0;
	let aborted = 0;
	let deliveries = 0;
	const cfg = config();
	installAgentNotify(pi.api as never, cfg, TEST_SECRETS, {
		runSummary: async (_context, _config, signal) => {
			summaries++;
			return new Promise((resolve) => signal?.addEventListener("abort", () => { aborted++; resolve(null); }));
		},
		sendFish: async () => { deliveries++; return { ok: true }; },
		sendBark: async () => { deliveries++; return { ok: true }; },
	});
	const runner = new ExtensionRunner([{
		path: "pi-brief", resolvedPath: "pi-brief", handlers: pi.handlers,
		tools: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(), messageRenderers: new Map(),
	}] as never, createExtensionRuntime(), process.cwd(), { getSessionId: () => "root-session" } as never, {} as never);
	const errors: string[] = [];
	runner.onError((event) => errors.push(event.error));
	let closeCustom: () => void = () => undefined;
	let closeSelect: () => void = () => undefined;
	runner.setUIContext({
		custom: () => new Promise((resolve) => { closeCustom = () => resolve(undefined); }),
		select: () => new Promise((resolve) => { closeSelect = () => resolve(undefined); }),
		input: async () => undefined,
		notify: () => undefined,
	} as never, "tui");
	const ui = runner.getUIContext();
	const select = ui.select;
	await runner.emit({ type: "session_start", reason: "startup" });
	assert.equal(ui.select, select, "pi-brief must not replace host UI methods");
	await runner.emit({ type: "agent_start" });
	const custom = ui.custom(() => undefined as never);
	const nested = ui.select("Choose an option", ["one", "two"]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(summaries, 1);
	closeCustom(); await custom;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(aborted, 0, "overlapping select still blocks");
	closeSelect(); await nested;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(aborted, 1);
	assert.equal(deliveries, 0);
	assert.deepEqual(errors, []);
	await runner.emit({ type: "session_shutdown", reason: "quit" });
});

test("native UI hooks observe all prompt kinds and deduplicate known question tools", async () => {
	for (const kind of ["select", "confirm", "input", "editor", "custom"]) {
		const pi = fakePi();
		let calls = 0;
		let cancelled = 0;
		installAgentNotify(pi.api as never, config(), TEST_SECRETS, {
			runSummary: async (_context, _config, signal) => {
				calls++;
				return new Promise((resolve) => signal?.addEventListener("abort", () => { cancelled++; resolve(null); }));
			},
		});
		const ctx = context();
		await pi.emit("session_start", {}, ctx);
		await pi.emit("agent_start", {}, ctx);
		await pi.emit("ui_prompt_start", { kind, reason: "ui_prompt", title: "选择缓存策略" }, ctx);
		await pi.emit("ui_prompt_end", { kind, reason: "ui_prompt" }, ctx);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls, 1, kind);
		assert.equal(cancelled, 1, kind);
		await pi.emit("tool_execution_start", { toolName: "question", toolCallId: "q", args: { question: "缓存策略？" } }, ctx);
		await pi.emit("ui_prompt_start", { kind, reason: "ui_prompt" }, ctx);
		await pi.emit("ui_prompt_end", { kind, reason: "ui_prompt" }, ctx);
		assert.equal(calls, 2);
		await pi.emit("tool_execution_end", { toolName: "question", toolCallId: "q", isError: false }, ctx);
		assert.equal(cancelled, 2);
		await pi.emit("session_shutdown", {}, ctx);
	}
});

test("public permission details and the native custom prompt share one notification", async () => {
	const pi = fakePi();
	const cfg = config();
	let calls = 0;
	let cancelled = 0;
	installAgentNotify(pi.api as never, cfg, TEST_SECRETS, {
		runSummary: async (evidence, _config, signal) => {
			calls++;
			assert.equal(evidence.event, "permission");
			assert.match(evidence.state.pendingAction ?? "", /git push/);
			return new Promise((resolve) => signal?.addEventListener("abort", () => { cancelled++; resolve(null); }));
		},
	});
	const ctx = context();
	await pi.emit("session_start", {}, ctx);
	await pi.emit("agent_start", {}, ctx);
	pi.eventHandlers.get(cfg.detection.permission.eventChannel)?.({
		requestId: "native-permission", source: "tool_call", surface: "bash", value: "git push", message: "permission", forwarding: null,
	});
	await pi.emit("ui_prompt_start", { kind: "custom", reason: "ui_prompt" }, ctx);
	assert.equal(calls, 1);
	await pi.emit("ui_prompt_end", { kind: "custom", reason: "ui_prompt" }, ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(cancelled, 1);
	await pi.emit("session_shutdown", {}, ctx);
});

test("a permission prompt cancels an idle summary already in flight", async () => {
	const pi = fakePi();
	const cfg = config();
	cfg.notifyPolicy.idleDelayMs = 0;
	cfg.notifyPolicy.ignoreShortTasksSeconds = 0;
	let idleSignal: AbortSignal | undefined;
	let idleStarted: () => void = () => undefined;
	const started = new Promise<void>((resolve) => { idleStarted = resolve; });
	installAgentNotify(pi.api as never, cfg, TEST_SECRETS, {
		runSummary: async (context, _config, signal) => {
			if (context.event === "idle") { idleSignal = signal; idleStarted(); }
			return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(null)));
		},
	});
	const ctx = context();
	await pi.emit("session_start", {}, ctx);
	await pi.emit("before_agent_start", { prompt: "修改缓存" }, ctx);
	await pi.emit("message_end", { message: { role: "assistant", content: "缓存已修改。", stopReason: "stop" } }, ctx);
	await pi.emit("agent_settled", {}, ctx);
	const keepAlive = setTimeout(() => undefined, 1000);
	try {
		await started;
		await pi.emit("ui_prompt_start", { kind: "select", title: "Permission Required\ngit push" }, ctx);
		assert.equal(idleSignal?.aborted, true);
	} finally {
		clearTimeout(keepAlive);
		await pi.emit("session_shutdown", {}, ctx);
	}
});

test("tree navigation and user input discard stale notices, while shutdown cancels secret lookup", async () => {
	const pi = fakePi();
	const cfg = config();
	cfg.summary.enabled = false;
	let signal: AbortSignal | undefined;
	let deliveries = 0;
	installAgentNotify(pi.api as never, cfg, (value) => {
		signal = value;
		return new Promise((resolve) => value?.addEventListener("abort", () => resolve(TEST_SECRETS)));
	}, { sendFish: async () => { deliveries++; return { ok: true }; }, sendBark: async () => { deliveries++; return { ok: true }; } });
	const ctx = context();
	await pi.emit("session_start", {}, ctx);
	await pi.commandHandlers.get("pi-brief-test")?.("permission", ctx);
	await new Promise((resolve) => setImmediate(resolve));
	await pi.emit("session_tree", {}, ctx);
	assert.equal(signal?.aborted, true);
	await pi.commandHandlers.get("pi-brief-test")?.("error", ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(signal?.aborted, false);
	await pi.emit("input", { source: "interactive", text: "继续" }, ctx);
	await pi.emit("session_shutdown", {}, ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(signal?.aborted, true);
	assert.equal(deliveries, 0);
});

test("aborted assistant messages never become error notifications because of their error text", async () => {
	const pi = fakePi();
	let notifications = 0;
	installAgentNotify(pi.api as never, config(), TEST_SECRETS, {
		runSummary: async () => { notifications++; return null; },
		sendFish: async () => ({ ok: true }),
		sendBark: async () => ({ ok: true }),
	});
	const ctx = context();
	await pi.emit("session_start", {}, ctx);
	await pi.emit("before_agent_start", { prompt: "会被用户取消的任务" }, ctx);
	await pi.emit("message_end", {
		message: { role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted", content: [] },
	}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(notifications, 0);
	await pi.emit("session_shutdown", {}, ctx);
});

test("a prompt that opens and closes in the same tick leaves no late notification", async () => {
	const pi = fakePi();
	let deliveries = 0;
	installAgentNotify(pi.api as never, config(), TEST_SECRETS, {
		runSummary: async () => "Pi 需要选择缓存策略。",
		sendFish: async () => { deliveries++; return { ok: true }; },
		sendBark: async () => { deliveries++; return { ok: true }; },
	});
	const ctx = context();
	await pi.emit("session_start", {}, ctx);
	await pi.emit("agent_start", {}, ctx);
	// Pi schedules notification-only hooks without awaiting them.
	const start = pi.emit("ui_prompt_start", { kind: "select", title: "选择缓存策略" }, ctx);
	const end = pi.emit("ui_prompt_end", { kind: "select", title: "选择缓存策略" }, ctx);
	await Promise.all([start, end]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(deliveries, 0);
	await pi.emit("session_shutdown", {}, ctx);
});

async function emitFailedTurn(pi: ReturnType<typeof fakePi>, ctx: HostContext): Promise<void> {
	await pi.emit("before_agent_start", { prompt: "Synthetic notification failure check" }, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "Synthetic failure", content: [] } }, ctx);
	await pi.emit("agent_settled", {}, ctx);
}

test("automatic Fish errors reach TUI and RPC without waiting for another backend", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ status: 402, message: "Insufficient credits" }), { status: 402 }));
	for (const mode of ["tui", "rpc"] as const) {
		const pi = fakePi();
		const cfg = config();
		cfg.summary.enabled = false;
		const messages: string[] = [];
		const ctx = context();
		ctx.mode = mode;
		ctx.ui.notify = (message) => messages.push(message);
		let releaseBark: (result: DeliveryResult) => void = () => undefined;
		let barkStarted = false;
		installAgentNotify(pi.api as never, cfg, TEST_SECRETS, {
			sendFish: createFishAudioSender(async () => assert.fail("an HTTP error must not play audio")),
			sendBark: async () => { barkStarted = true; return new Promise((resolve) => { releaseBark = resolve; }); },
		});
		await pi.emit("session_start", {}, ctx);
		await emitFailedTurn(pi, ctx);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(barkStarted, true);
		assert.equal(messages.length, 1, "automatic errors need no test command or backend completion");
		assert.match(messages[0], /Fish Audio 请求失败.*HTTP 402.*余额不足.*Insufficient credits/);
		releaseBark({ ok: true });
		await pi.emit("session_shutdown", {}, ctx);
	}
});

test("automatic credential errors name the field, deduplicate, and reset on session change", async () => {
	const pi = fakePi();
	const cfg = config();
	cfg.summary.enabled = false;
	cfg.deliveryBackends = ["fishaudio"];
	cfg.notifyPolicy.dedupeWindowMs = 0;
	cfg.backends.fishAudio.apiKey = "!{private-key-command}";
	const source = createRuntimeSecretsSource(cfg, async () => ({ stdout: "partial-private-secret", stderr: "private-tool: command not found", code: 127, killed: false }));
	const messages: string[] = [];
	const ctx = context();
	ctx.ui.notify = (message) => messages.push(message);
	installAgentNotify(pi.api as never, cfg, source, { sendFish: async () => assert.fail("missing credentials must prevent HTTP") });
	await pi.emit("session_start", {}, ctx);
	for (let i = 0; i < 2; i++) {
		await emitFailedTurn(pi, ctx);
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.equal(messages.length, 1);
	assert.match(messages[0], /fishAudio.apiKey.*退出码 127.*命令不存在/);
	assert.doesNotMatch(messages[0], /private-/);
	await pi.emit("session_tree", {}, ctx);
	await emitFailedTurn(pi, ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(messages.length, 2);
	await pi.emit("session_shutdown", {}, ctx);
});

test("a synchronous backend throw cannot prevent the other backend, and stale errors remain silent", async () => {
	const pi = fakePi();
	const cfg = config();
	cfg.summary.enabled = false;
	cfg.notifyPolicy.dedupeWindowMs = 0;
	const messages: string[] = [];
	const ctx = context();
	ctx.ui.notify = (message) => messages.push(message);
	let barkCalls = 0;
	let rejectFish: (error: Error) => void = () => undefined;
	let failSynchronously = true;
	installAgentNotify(pi.api as never, cfg, TEST_SECRETS, {
		sendFish: () => {
			if (failSynchronously) throw Object.assign(new Error("private URL"), { code: "ECONNREFUSED" });
			return new Promise((_resolve, reject) => { rejectFish = reject; });
		},
		sendBark: async () => { barkCalls++; return { ok: true }; },
	});
	await pi.emit("session_start", {}, ctx);
	await emitFailedTurn(pi, ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(barkCalls, 1);
	assert.match(messages[0], /ECONNREFUSED/);
	assert.doesNotMatch(messages[0], /private URL/);
	failSynchronously = false;
	await emitFailedTurn(pi, ctx);
	await new Promise((resolve) => setImmediate(resolve));
	await pi.emit("session_tree", {}, context("next-session"));
	rejectFish(new Error("late private error"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(messages.length, 1);
	assert.equal(barkCalls, 2);
	await pi.emit("session_shutdown", {}, ctx);
});

test("print and JSON modes keep best-effort backend notifications and local errors on stderr", async (t) => {
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: string) => warnings.push(message));
	for (const mode of ["print", "json"] as const) {
		const pi = fakePi();
		const cfg = config();
		cfg.deliveryBackends = ["bark"];
		cfg.summary.enabled = false;
		let delivered = 0;
		installAgentNotify(pi.api as never, cfg, TEST_SECRETS, {
			sendBark: async () => {
				delivered++;
				return { ok: false, error: { stage: "request", code: "http-503", message: "HTTP 503" } };
			},
		});
		const ctx = context();
		ctx.mode = mode;
		ctx.hasUI = false;
		ctx.ui.notify = () => assert.fail("headless mode must not access the UI");
		await pi.emit("session_start", {}, ctx);
		await emitFailedTurn(pi, ctx);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(delivered, 1);
		await pi.emit("session_shutdown", {}, ctx);
	}
	assert.equal(warnings.length, 2);
	assert.ok(warnings.every((message) => /\[pi-brief\] Bark 请求失败.*HTTP 503/.test(message)));
});
