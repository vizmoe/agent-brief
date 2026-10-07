import {
	sendBark,
	sendFishAudio,
} from "../../core/backends.ts";
import {
	eventPresentation,
	notificationFallback,
} from "./config.ts";
import {
	boundedAdd,
	boundedPush,
	isBlockingQuestionText,
	isInternalAgentTool,
	isValidationCommand,
	notificationKey,
	normalizeSessionId,
	permissionFingerprint,
	questionText,
	readAgentError,
	readAgentOutcome,
	readAssistantError,
	readAssistantOutcome,
	readPermissionDecisionEvent,
	readPermissionUiPromptEvent,
	safeToolArgs,
	shouldDispatchNotification,
	summarizePermissionAction,
	summarizePermissionUiTitle,
	toolFilePath,
} from "./detection.ts";
import type { HostAPI, HostContext, HostModelRegistry } from "./host.ts";
import { createDeliveryReporter, describeError, formatDeliveryFailure, notifyLocal } from "./diagnostics.ts";
import {
	isNotificationAllowedNow,
	shouldIgnoreShortIdle,
} from "../../core/policy.ts";
import {
	evidenceAwareFallback,
	runSummaryAgent,
	sanitizeEvidenceText,
	sessionModelRef,
	summaryConfigForSession,
	textFromMessage,
} from "./summary.ts";
import {
	NOTIFICATION_TYPES,
	type AssistantOutcome,
	type DeliveryBackend,
	type DeliveryResult,
	type NotificationPayload,
	type NotificationType,
	type NotifyConfig,
	type RuntimeSecrets,
	type SummaryContext,
} from "../../core/types.ts";

type DeliveryResults = Partial<Record<DeliveryBackend, DeliveryResult>>;
// Event-only integrations must not leave a stale permission scope forever.
const PUBLIC_PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

export function getSessionId(ctx: HostContext): string | null {
	try {
		return normalizeSessionId(ctx.sessionManager.getSessionId());
	} catch {
		return null;
	}
}

interface ToolCallEvidence {
	name: string;
	args: Record<string, unknown>;
}

interface PermissionPromptToken {
	scope: string;
	expectedTitle: string;
}

interface UiPromptScope {
	type?: "permission" | "question";
	scope?: string;
	permissionScopes: string[];
}

interface RuntimeState {
	activeSessionId: string | null;
	activeMode: HostContext["mode"] | null;
	activeModel: string | undefined;
	modelRegistry: HostModelRegistry | undefined;
	taskSequence: number;
	taskStartedAt: number | null;
	agentRunning: boolean;
	outcome: AssistantOutcome;
	hadToolError: boolean;
	errorMessage: string | undefined;
	currentTask: string | undefined;
	changedFiles: Set<string>;
	recentActions: string[];
	validation: string | undefined;
	lastAssistantText: string | undefined;
	toolCalls: Map<string, ToolCallEvidence>;
	fishQueue: Promise<void>;
	idleTimer: NodeJS.Timeout | null;
	pendingPermissionScopes: Set<string>;
	pendingPermissionFingerprints: Map<string, string>;
	permissionTimeouts: Map<string, NodeJS.Timeout>;
	permissionPromptTokens: PermissionPromptToken[];
	pendingQuestionScopes: Set<string>;
	activeQuestionToolCalls: Set<string>;
	notificationScopes: Set<string>;
	lastNotificationAt: Map<NotificationType, number>;
	notificationControllers: Map<string, AbortController>;
	eventUnsubscribes: Array<() => void>;
	uiPrompt: UiPromptScope | null;
	uiSequence: number;
	shuttingDown: boolean;
}

export interface RuntimeDependencies {
	now(): number;
	runSummary(
		context: SummaryContext,
		config: NotifyConfig["summary"],
		signal?: AbortSignal,
		registry?: HostModelRegistry,
	): Promise<string | null>;
	sendFish(
		payload: NotificationPayload,
		config: NotifyConfig,
		secrets: RuntimeSecrets,
		signal?: AbortSignal,
	): Promise<DeliveryResult>;
	sendBark(
		payload: NotificationPayload,
		config: NotifyConfig,
		secrets: RuntimeSecrets,
		signal?: AbortSignal,
	): Promise<DeliveryResult>;
}

export type RuntimeSecretsSource =
	| RuntimeSecrets
	| ((signal?: AbortSignal) => Promise<RuntimeSecrets>);

const DEFAULT_DEPENDENCIES: RuntimeDependencies = {
	now: Date.now,
	runSummary: runSummaryAgent,
	sendFish: sendFishAudio,
	sendBark,
};

function runFailureOpen(
	operation: () => Promise<unknown>,
	onError?: () => void,
): void {
	const failed = (): void => {
		try { onError?.(); } catch { /* Keep failures inside the notification task. */ }
	};
	try { void operation().catch(failed); } catch { failed(); }
}

function resetTaskEvidence(state: RuntimeState): void {
	state.outcome = "unknown";
	state.hadToolError = false;
	state.errorMessage = undefined;
	state.currentTask = undefined;
	state.changedFiles.clear();
	state.recentActions.length = 0;
	state.validation = undefined;
	state.lastAssistantText = undefined;
	state.toolCalls.clear();
}

function buildSummaryContext(
	state: RuntimeState,
	config: NotifyConfig,
	type: NotificationType,
	options: {
		durationMs?: number;
		pendingAction?: string;
		errorMessage?: string;
	} = {},
): SummaryContext | null {
	const sessionId = state.activeSessionId;
	if (!sessionId) return null;
	const stateEvidence: SummaryContext["state"] = {};
	if (typeof options.durationMs === "number") {
		stateEvidence.durationMs = Math.max(0, Math.round(options.durationMs));
	}
	if (state.currentTask) stateEvidence.currentTask = state.currentTask;
	if (state.changedFiles.size > 0) {
		stateEvidence.changedFiles = [...state.changedFiles].slice(-10);
	}
	if (state.recentActions.length > 0) {
		stateEvidence.recentActions = state.recentActions.slice(-6);
	}
	if (state.validation) stateEvidence.validation = state.validation;
	const pendingAction = sanitizeEvidenceText(options.pendingAction, 600);
	if (pendingAction) stateEvidence.pendingAction = pendingAction;
	const errorMessage = sanitizeEvidenceText(
		options.errorMessage ?? (type === "error" ? state.errorMessage : undefined),
		600,
	);
	if (errorMessage) stateEvidence.errorMessage = errorMessage;

	const recentMessages: NonNullable<SummaryContext["recentMessages"]> = [];
	const userTask = sanitizeEvidenceText(state.currentTask, 800);
	if (userTask) recentMessages.push({ role: "user", text: userTask });
	const assistant = sanitizeEvidenceText(state.lastAssistantText, 2000);
	if (assistant) recentMessages.push({ role: "assistant", text: assistant });

	return {
		language: config.summaryLanguage,
		event: type,
		session: {
			id: sessionId,
			rootOnly: true,
		},
		state: stateEvidence,
		recentMessages: recentMessages.length > 0 ? recentMessages : undefined,
	};
}

export function installAgentNotify(
	pi: HostAPI,
	config: NotifyConfig,
	secretSource: RuntimeSecretsSource,
	dependencies: Partial<RuntimeDependencies> = {},
): { beginSession(ctx: HostContext): void } {
	const deps: RuntimeDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	let reportDelivery = createDeliveryReporter();
	let sessionController = new AbortController();
	let runtimeSecretsPromise: Promise<RuntimeSecrets> | undefined;
	const resolveSecrets = (): Promise<RuntimeSecrets> => {
		if (!runtimeSecretsPromise) {
			const signal = sessionController.signal;
			const promise = typeof secretSource === "function"
				? Promise.resolve().then(() => {
					if (signal.aborted) throw new Error("Session ended");
					return secretSource(signal);
				})
				: Promise.resolve(secretSource);
			runtimeSecretsPromise = promise;
			void promise.finally(() => {
				if (runtimeSecretsPromise === promise) runtimeSecretsPromise = undefined;
			}).catch(() => undefined);
		}
		return runtimeSecretsPromise;
	};
	const state: RuntimeState = {
		activeSessionId: null,
		activeMode: null,
		activeModel: undefined,
		modelRegistry: undefined,
		taskSequence: 0,
		taskStartedAt: null,
		agentRunning: false,
		outcome: "unknown",
		hadToolError: false,
		errorMessage: undefined,
		currentTask: undefined,
		changedFiles: new Set(),
		recentActions: [],
		validation: undefined,
		lastAssistantText: undefined,
		toolCalls: new Map(),
		fishQueue: Promise.resolve(),
		idleTimer: null,
		pendingPermissionScopes: new Set(),
		pendingPermissionFingerprints: new Map(),
		permissionTimeouts: new Map(),
		permissionPromptTokens: [],
		pendingQuestionScopes: new Set(),
		activeQuestionToolCalls: new Set(),
		notificationScopes: new Set(),
		lastNotificationAt: new Map(),
		notificationControllers: new Map(),
		eventUnsubscribes: [],
		uiPrompt: null,
		uiSequence: 0,
		shuttingDown: false,
	};

	const cancelIdleTimer = (): void => {
		if (!state.idleTimer) return;
		clearTimeout(state.idleTimer);
		state.idleTimer = null;
	};

	const cancelNotification = (type: NotificationType, scope: string): void => {
		const sessionId = state.activeSessionId;
		if (!sessionId) return;
		const key = notificationKey(sessionId, type, scope);
		state.notificationControllers.get(key)?.abort();
		state.notificationControllers.delete(key);
	};

	const cancelNotificationsByType = (type: NotificationType): void => {
		for (const [key, controller] of state.notificationControllers) {
			if (!key.includes(`:${type}:`)) continue;
			controller.abort();
			state.notificationControllers.delete(key);
		}
	};

	const cancelAllNotifications = (): void => {
		for (const controller of state.notificationControllers.values()) {
			controller.abort();
		}
		state.notificationControllers.clear();
	};

	const markBlocking = (
		type: "permission" | "question",
		scope: string,
	): void => {
		cancelIdleTimer();
		cancelNotificationsByType("idle");
		const scopes = type === "permission"
			? state.pendingPermissionScopes
			: state.pendingQuestionScopes;
		scopes.add(scope);
	};

	const resolveBlocking = (
		type: "permission" | "question",
		scope: string,
	): void => {
		const scopes = type === "permission"
			? state.pendingPermissionScopes
			: state.pendingQuestionScopes;
		scopes.delete(scope);
		if (type === "permission") {
			clearPermissionTimeout(scope);
			state.pendingPermissionFingerprints.delete(scope);
			for (let index = state.permissionPromptTokens.length - 1; index >= 0; index -= 1) {
				if (state.permissionPromptTokens[index]?.scope === scope) {
					state.permissionPromptTokens.splice(index, 1);
				}
			}
		}
		cancelNotification(type, scope);
	};

	const clearPermissionTimeout = (scope: string): void => {
		const timer = state.permissionTimeouts.get(scope);
		if (timer) clearTimeout(timer);
		state.permissionTimeouts.delete(scope);
	};

	const resolveAllBlocking = (type: "permission" | "question"): void => {
		const scopes = type === "permission"
			? state.pendingPermissionScopes
			: state.pendingQuestionScopes;
		for (const scope of scopes) resolveBlocking(type, scope);
		scopes.clear();
		if (type === "permission") {
			state.pendingPermissionFingerprints.clear();
			state.permissionPromptTokens.length = 0;
		}
	};

	const enqueueFish = (
		payload: NotificationPayload,
		secrets: RuntimeSecrets,
		signal: AbortSignal,
	): Promise<DeliveryResult> => {
		const result: Promise<DeliveryResult> = state.fishQueue
			.then(() => signal.aborted
				? { ok: false }
				: deps.sendFish(payload, config, secrets, signal));
		state.fishQueue = result.then(() => undefined, () => undefined);
		return result;
	};

	const deliver = async (
		payload: NotificationPayload,
		signal: AbortSignal,
		showFailures = true,
	): Promise<DeliveryResults> => {
		const results: DeliveryResults = {};
		if (signal.aborted) return results;
		const report = reportDelivery;
		const record = (backend: DeliveryBackend, result: DeliveryResult): void => {
			if (signal.aborted) return;
			if (!result.ok && !result.error) result = {
				ok: false, error: { stage: "delivery", code: "unknown", message: "通知未完成，后端未提供错误详情。" },
			};
			results[backend] = result;
			report(backend, result, showFailures);
		};
		let secrets: RuntimeSecrets;
		try {
			secrets = await resolveSecrets();
		} catch (error) {
			for (const backend of config.deliveryBackends) record(backend, {
				ok: false, error: { stage: "credentials", ...describeError(error) },
			});
			return results;
		}
		if (signal.aborted) return {};
		await Promise.all(config.deliveryBackends.map(async (backend) => {
			try {
				const secretFailure = secrets.failures?.[backend];
				record(backend, secretFailure ? { ok: false, error: secretFailure }
					: await (backend === "fishaudio" ? enqueueFish(payload, secrets, signal)
						: deps.sendBark(payload, config, secrets, signal)));
			} catch (error) {
				record(backend, { ok: false, error: { stage: "delivery", ...describeError(error) } });
			}
		}));
		return results;
	};

	const dispatchNotification = async (
		type: NotificationType,
		context: SummaryContext,
		options: {
			scope?: string;
			sticky?: boolean;
			bypassPolicy?: boolean;
			sessionScoped?: boolean;
		} = {},
	): Promise<DeliveryResults> => {
		const sessionId = state.activeSessionId;
		if (
			!sessionId
			|| context.session.id !== sessionId
			|| state.shuttingDown
			|| config.deliveryBackends.length === 0
		) {
			return {};
		}
		// A prompt may close before the background dispatch microtask starts.
		if (options.scope && !options.scope.startsWith("task:")) {
			if (type === "permission" && !state.pendingPermissionScopes.has(options.scope)) return {};
			if (type === "question" && !state.pendingQuestionScopes.has(options.scope)) return {};
		}
		if (
			!options.bypassPolicy
			&& !isNotificationAllowedNow(
				type,
				config.notifyPolicy.quietHours,
				new Date(deps.now()),
			)
		) {
			return {};
		}
		const scope = options.scope ?? `event:${deps.now()}`;
		const scopedKey = options.scope
			? notificationKey(sessionId, type, scope)
			: null;
		if (
			!options.bypassPolicy
			&& !shouldDispatchNotification(
				state.notificationScopes,
				state.lastNotificationAt,
				type,
				scopedKey,
				options.sticky === true,
				deps.now(),
				config.notifyPolicy.dedupeWindowMs,
			)
		) {
			return {};
		}

		const key = notificationKey(sessionId, type, scope);
		const controller = new AbortController();
		state.notificationControllers.set(key, controller);
		const taskSequence = state.taskSequence;
		try {
			let summary: string | null = null;
			if (config.summary.enabled) {
				try {
					summary = await deps.runSummary(
						context,
						summaryConfigForSession(config.summary, state.activeModel),
						controller.signal,
						state.modelRegistry,
					);
				} catch {
					summary = null;
				}
			}
			if (
				controller.signal.aborted
				|| state.shuttingDown
				|| state.activeSessionId !== sessionId
				|| (
					options.sessionScoped !== true
					&& state.taskSequence !== taskSequence
				)
			) {
				return {};
			}
			const presentation = eventPresentation(type, config.summaryLanguage);
			const text = summary ?? evidenceAwareFallback(
				type, config.summaryLanguage, context,
				notificationFallback(type, config.summaryLanguage, config.fallbackMessages[type]),
			);
			if (!text) return {};
			const payload: NotificationPayload = {
				type, title: presentation.title, summary: text, barkLevel: presentation.barkLevel,
			};
			return await deliver(payload, controller.signal);
		} finally {
			if (state.notificationControllers.get(key) === controller) {
				state.notificationControllers.delete(key);
			}
		}
	};

	pi.on("ui_prompt_start", (event, ctx) => {
		if (state.shuttingDown || !state.activeSessionId || getSessionId(ctx) !== state.activeSessionId) return;
		cancelIdleTimer();
		cancelNotificationsByType("idle");
		const token = state.permissionPromptTokens.find((candidate) =>
			event.kind === "custom" || candidate.expectedTitle === event.title);
		state.uiPrompt = { permissionScopes: token ? [token.scope] : [] };
		if (token) clearPermissionTimeout(token.scope);
		if (token || state.activeQuestionToolCalls.size > 0) return;
		const permission = /^(?:Permission Required(?: \(Subagent\))?|Permission request)(?:\n|$)/i.test(event.title ?? "");
		if (!permission && !state.agentRunning) return;
		const type = permission ? "permission" : "question";
		const scope = `ui:${++state.uiSequence}`;
		state.uiPrompt.type = type;
		state.uiPrompt.scope = scope;
		markBlocking(type, scope);
		const context = buildSummaryContext(state, config, type, {
			pendingAction: permission ? summarizePermissionUiTitle(event.title ?? "") : event.title,
		});
		if (context) runFailureOpen(() => dispatchNotification(type, context, {
			scope, sticky: true, sessionScoped: true,
		}));
	});

	pi.on("ui_prompt_end", (_event, ctx) => {
		if (getSessionId(ctx) !== state.activeSessionId) return;
		const prompt = state.uiPrompt;
		state.uiPrompt = null;
		if (prompt?.scope && prompt.type) resolveBlocking(prompt.type, prompt.scope);
		for (const scope of prompt?.permissionScopes ?? []) resolveBlocking("permission", scope);
	});

	state.eventUnsubscribes.push(
		pi.events.on(config.detection.permission.eventChannel, (payload) => {
			const event = readPermissionUiPromptEvent(payload);
			if (!event || !state.activeSessionId || state.shuttingDown) return;
			const permissionScope = `request:${event.requestId}`;
			markBlocking("permission", permissionScope);
			clearPermissionTimeout(permissionScope);
			const timer = setTimeout(() => resolveBlocking("permission", permissionScope), PUBLIC_PERMISSION_TIMEOUT_MS);
			timer.unref?.();
			state.permissionTimeouts.set(permissionScope, timer);
			const fingerprint = permissionFingerprint(
				event.surface,
				event.value,
				event.agentName,
			);
			if (fingerprint) {
				state.pendingPermissionFingerprints.set(permissionScope, fingerprint);
			}
			if (event.message !== null || state.activeMode === "tui") {
				const token: PermissionPromptToken = {
					scope: permissionScope,
					expectedTitle: `${
						event.forwarding
							? "Permission Required (Subagent)"
							: "Permission Required"
					}\n${event.message}`,
				};
				state.permissionPromptTokens.push(token);
				// Pi emits UI hooks on a microtask; keep this token through that emission.
				setImmediate(() => {
					const index = state.permissionPromptTokens.indexOf(token);
					if (index >= 0) {
						state.permissionPromptTokens.splice(index, 1);
					}
				});
			}
			state.uiPrompt?.permissionScopes.push(permissionScope);
			if (state.uiPrompt) clearPermissionTimeout(permissionScope);
			const context = buildSummaryContext(state, config, "permission", {
				durationMs: state.taskStartedAt === null
					? undefined
					: deps.now() - state.taskStartedAt,
				pendingAction: summarizePermissionAction(event.surface, event.value),
			});
			if (context && state.pendingPermissionScopes.has(permissionScope)) {
				runFailureOpen(() => dispatchNotification("permission", context, {
					scope: permissionScope,
					sticky: true,
					sessionScoped: true,
				}));
			}
		}),
	);
	state.eventUnsubscribes.push(
		pi.events.on(config.detection.permission.decisionChannel, (payload) => {
			const decision = readPermissionDecisionEvent(payload);
			if (!decision) return;
			const fingerprint = permissionFingerprint(
				decision.surface,
				decision.value,
				decision.agentName,
			);
			if (!fingerprint) return;
			for (const [scope, pendingFingerprint] of state.pendingPermissionFingerprints) {
				if (pendingFingerprint === fingerprint) {
					resolveBlocking("permission", scope);
					break;
				}
			}
		}),
	);

	const rememberSessionModel = (model: unknown): void => {
		const next = sessionModelRef(model);
		if (next) state.activeModel = next;
	};

	const beginSession = (ctx: HostContext): void => {
		sessionController.abort();
		sessionController = new AbortController();
		runtimeSecretsPromise = undefined;
		reportDelivery = createDeliveryReporter(ctx);
		state.shuttingDown = false;
		state.activeSessionId = getSessionId(ctx);
		state.activeMode = ctx.mode;
		state.activeModel = sessionModelRef(ctx.model);
		state.modelRegistry = ctx.modelRegistry;
		state.taskSequence = 0;
		state.taskStartedAt = null;
		state.agentRunning = false;
		cancelIdleTimer();
		cancelAllNotifications();
		for (const scope of state.permissionTimeouts.keys()) clearPermissionTimeout(scope);
		state.pendingPermissionScopes.clear();
		state.pendingPermissionFingerprints.clear();
		state.permissionPromptTokens.length = 0;
		state.pendingQuestionScopes.clear();
		state.activeQuestionToolCalls.clear();
		resetTaskEvidence(state);
		state.notificationScopes.clear();
		state.lastNotificationAt.clear();
		state.uiPrompt = null;
	};

	pi.on("session_start", (_event, ctx) => {
		beginSession(ctx);
	});

	pi.on("session_tree", (_event, ctx) => beginSession(ctx));

	pi.on("input", (event) => {
		if (event.source === "extension") return;
		cancelIdleTimer();
		cancelNotificationsByType("idle");
		cancelNotificationsByType("question");
		cancelNotificationsByType("error");
	});

	pi.on("session_shutdown", () => {
		state.shuttingDown = true;
		sessionController.abort();
		runtimeSecretsPromise = undefined;
		cancelIdleTimer();
		resolveAllBlocking("permission");
		resolveAllBlocking("question");
		cancelAllNotifications();
		state.activeQuestionToolCalls.clear();
		state.uiPrompt = null;
		for (const unsubscribe of state.eventUnsubscribes.splice(0)) unsubscribe();
		state.activeSessionId = null;
		state.activeMode = null;
		state.activeModel = undefined;
		state.modelRegistry = undefined;
		state.taskStartedAt = null;
		state.agentRunning = false;
	});

	pi.on("model_select", (event, ctx) => {
		rememberSessionModel(event.model);
		state.modelRegistry = ctx.modelRegistry;
	});

	pi.on("before_agent_start", (event) => {
		cancelIdleTimer();
		if (state.taskStartedAt === null) {
			cancelNotificationsByType("idle");
			cancelNotificationsByType("error");
			if (state.pendingQuestionScopes.size === 0) {
				cancelNotificationsByType("question");
			}
			state.taskSequence += 1;
			resetTaskEvidence(state);
			state.taskStartedAt = deps.now();
		}
		state.outcome = "unknown";
		const prompt = sanitizeEvidenceText(event.prompt, 800);
		if (prompt) {
			state.currentTask = prompt;
		}
	});

	pi.on("agent_start", () => {
		state.agentRunning = true;
		cancelIdleTimer();
	});

	pi.on("message_end", (event) => {
		const outcome = readAssistantOutcome(event.message);
		if (outcome !== "unknown") state.outcome = outcome;
		const error = readAssistantError(event.message);
		if (error) state.errorMessage = error;
		if (event.message.role !== "assistant") return;
		const text = textFromMessage(event.message);
		state.lastAssistantText = text;
	});

	pi.on("agent_end", (event) => {
		const outcome = readAgentOutcome(event.messages);
		if (outcome !== "unknown") state.outcome = outcome;
		state.errorMessage ||= readAgentError(event.messages);
	});

	pi.on("tool_execution_start", (event) => {
		const toolName = typeof event.toolName === "string"
			? event.toolName.toLowerCase()
			: "";
		const toolCallId = typeof event.toolCallId === "string"
			? event.toolCallId
			: `${state.taskSequence}:${toolName}:${deps.now()}`;
		const args = safeToolArgs(event.args);
		state.toolCalls.set(toolCallId, { name: toolName, args });
		if (state.toolCalls.size > 100) {
			const first = state.toolCalls.keys().next().value;
			if (typeof first === "string") state.toolCalls.delete(first);
		}
		if (!config.detection.questionToolNames.includes(toolName)) return;
		const questionScope = `tool:${toolCallId}`;
		state.activeQuestionToolCalls.add(toolCallId);
		markBlocking("question", questionScope);
		const pendingAction = questionText(args)
			?? "The current root session needs user input.";
		const context = buildSummaryContext(state, config, "question", {
			durationMs: state.taskStartedAt === null
				? undefined
				: deps.now() - state.taskStartedAt,
			pendingAction,
		});
		if (context) {
			runFailureOpen(() => dispatchNotification("question", context, {
				scope: questionScope,
				sticky: true,
			}));
		}
	});

	pi.on("tool_execution_end", (event) => {
		const toolCallId = typeof event.toolCallId === "string"
			? event.toolCallId
			: "";
		const evidence = state.toolCalls.get(toolCallId);
		if (toolCallId) state.toolCalls.delete(toolCallId);
		const toolName = evidence?.name
			?? (typeof event.toolName === "string" ? event.toolName.toLowerCase() : "");
		if (config.detection.questionToolNames.includes(toolName) && toolCallId) {
			state.activeQuestionToolCalls.delete(toolCallId);
			resolveBlocking("question", `tool:${toolCallId}`);
		}
		if (event.isError === true) {
			state.hadToolError = true;
			state.errorMessage ||= sanitizeEvidenceText(`${toolName || "tool"} failed.`, 200);
		}
		if (!evidence || !toolName || isInternalAgentTool(toolName)) return;

		const path = toolFilePath(evidence.args);
		if ((toolName === "edit" || toolName === "write") && path) {
			if (!event.isError) boundedAdd(state.changedFiles, path, 20);
			boundedPush(
				state.recentActions,
				`${event.isError === true ? "Failed to update" : "Updated"} ${path}.`,
				8,
			);
			return;
		}
		if (toolName === "bash" && isValidationCommand(evidence.args)) {
			state.validation = event.isError === true
				? "A validation command failed."
				: "A validation command completed successfully.";
			boundedPush(state.recentActions, state.validation, 8);
			return;
		}
		boundedPush(
			state.recentActions,
			`${toolName} ${event.isError === true ? "failed" : "completed"}.`,
			8,
		);
	});

	pi.on("agent_settled", (_event, ctx) => {
		state.agentRunning = false;
		if (!state.activeSessionId || state.taskStartedAt === null) return;
		try {
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		} catch {
			return;
		}

		const taskSequence = state.taskSequence;
		const durationMs = Math.max(0, deps.now() - state.taskStartedAt);
		const isError = state.outcome === "error"
			|| (config.detection.notifyRecoveredToolErrors && state.hadToolError);
		if (isError) {
			const context = buildSummaryContext(state, config, "error", {
				durationMs,
				errorMessage: state.errorMessage,
			});
			state.taskStartedAt = null;
			if (context) {
				runFailureOpen(() => dispatchNotification("error", context, {
					scope: `task:${taskSequence}`,
					sticky: true,
				}));
			}
			return;
		}
		if (state.outcome === "aborted") {
			state.taskStartedAt = null;
			return;
		}
		if (
			state.pendingPermissionScopes.size > 0
			|| state.pendingQuestionScopes.size > 0
		) {
			state.taskStartedAt = null;
			return;
		}
		if (isBlockingQuestionText(state.lastAssistantText)) {
			const context = buildSummaryContext(state, config, "question", {
				durationMs,
				pendingAction: state.lastAssistantText,
			});
			state.taskStartedAt = null;
			if (context) {
				runFailureOpen(() => dispatchNotification("question", context, {
					scope: `task:${taskSequence}`,
					sticky: true,
				}));
			}
			return;
		}
		if (shouldIgnoreShortIdle(
			durationMs,
			config.notifyPolicy.ignoreShortTasksSeconds,
		)) {
			state.taskStartedAt = null;
			return;
		}

		const context = buildSummaryContext(state, config, "idle", { durationMs });
		state.taskStartedAt = null;
		if (!context) return;
		state.idleTimer = setTimeout(() => {
			state.idleTimer = null;
			if (
				state.shuttingDown
				|| state.taskSequence !== taskSequence
				|| state.activeSessionId !== context.session.id
				|| state.pendingPermissionScopes.size > 0
				|| state.pendingQuestionScopes.size > 0
			) {
				return;
			}
			try {
				if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
			} catch {
				return;
			}
			runFailureOpen(() => dispatchNotification("idle", context, {
				scope: `task:${taskSequence}`,
				sticky: true,
			}));
		}, config.notifyPolicy.idleDelayMs);
		state.idleTimer.unref?.();
	});

	pi.registerCommand("pi-brief-test", {
		description: "Test Pi model summary and enabled notification backends",
		getArgumentCompletions(prefix) {
			const items = (NOTIFICATION_TYPES as readonly string[]).map((value) => ({
				value,
				label: value,
			}));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const type = args.trim() as NotificationType;
			if (
				type !== "idle"
				&& type !== "permission"
				&& type !== "question"
				&& type !== "error"
			) {
				notifyLocal(ctx,
					"Usage: /pi-brief-test idle|permission|question|error",
					"warning",
				);
				return;
			}
			if (config.deliveryBackends.length === 0) {
				notifyLocal(ctx,
					"Notification test skipped: no delivery backend is enabled.",
					"warning",
				);
				return;
			}
			const sessionId = getSessionId(ctx) ?? "notification-test";
			const context: SummaryContext = {
				language: config.summaryLanguage,
				event: type,
				session: { id: sessionId, rootOnly: true },
				state: {
					currentTask: "Verify the Pi notification extension.",
					recentActions: ["The user requested an end-to-end notification test."],
					pendingAction: type === "permission" || type === "question"
						? "User action is required to complete this test."
						: undefined,
					errorMessage: type === "error"
						? "This is a synthetic error notification test."
						: undefined,
				},
				recentMessages: [
					{ role: "user", text: "Verify the Pi notification extension." },
					{
						role: "assistant",
						text: type === "error"
							? "Synthetic error notification test finished with a failure signal."
							: "Synthetic notification test completed successfully.",
					},
				],
			};
			rememberSessionModel(ctx.model);
			state.modelRegistry = ctx.modelRegistry;
			const controller = new AbortController();
			const key = notificationKey(
				sessionId,
				type,
				`test:${++state.uiSequence}`,
			);
			state.notificationControllers.set(key, controller);
			runFailureOpen(async () => {
				try {
					let summary: string | null = null;
					if (config.summary.enabled) {
						try {
							summary = await deps.runSummary(
								context,
								summaryConfigForSession(config.summary, state.activeModel),
								controller.signal,
								state.modelRegistry,
							);
						} catch {
							summary = null;
						}
					}
					if (controller.signal.aborted) return;
					const presentation = eventPresentation(type, config.summaryLanguage);
					if (summary === "") {
						notifyLocal(ctx, "Notification test: no useful summary; skipped.", "info");
						return;
					}
					const payload: NotificationPayload = {
						type,
						title: presentation.title,
						summary: summary ?? evidenceAwareFallback(
							type,
							config.summaryLanguage,
							context,
							notificationFallback(
								type,
								config.summaryLanguage,
								config.fallbackMessages[type],
							),
						) ?? config.fallbackMessages[type],
						barkLevel: presentation.barkLevel,
					};
					const results = await deliver(payload, controller.signal, false);
					if (controller.signal.aborted) return;
					const summaryStatus = summary ? "ok" : "fallback";
					const backendStatus = config.deliveryBackends
						.map((backend) => `${backend} ${results[backend]?.ok ? "ok" : "failed"}`)
						.join(", ");
					const errors = config.deliveryBackends.flatMap((backend) => {
						const result = results[backend];
						return result && !result.ok && result.error ? [formatDeliveryFailure(backend, result.error)] : [];
					});
					notifyLocal(ctx,
						[`Notification test: summary ${summaryStatus}${backendStatus ? `, ${backendStatus}` : ""}.`, ...errors].join("\n"),
						Object.values(results).every((result) => result.ok) ? "info" : "warning",
					);
				} finally {
					if (state.notificationControllers.get(key) === controller) {
						state.notificationControllers.delete(key);
					}
				}
			}, () => {
				if (!controller.signal.aborted) {
					notifyLocal(ctx, "Notification test failed in the background.", "warning");
				}
			});
		},
	});

	return { beginSession };
}
