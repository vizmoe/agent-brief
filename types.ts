export const NOTIFICATION_TYPES = ["idle", "permission", "question", "error"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type DeliveryBackend = "fishaudio" | "bark";
export interface DeliveryFailure {
	stage: "credentials" | "request" | "response" | "storage" | "playback" | "delivery";
	code: string;
	/** Safe, bounded user-facing text; never raw commands, credentials, or exceptions. */
	message: string;
}
export type DeliveryResult = { ok: true } | { ok: false; error?: DeliveryFailure };
export type BarkLevel = "critical" | "timeSensitive" | "active" | "passive";
export type AssistantOutcome = "completed" | "error" | "aborted" | "unknown";

/** A literal, $ENV_VAR, or a whole-value !{shell command}. */
export type SecretValue = string;

/** Public configuration. Transport and lifecycle tuning stays internal. */
export interface BriefConfig {
	enabled?: boolean;
	language?: string;
	summary?: false | { model?: string; instructions?: string };
	notify?: {
		idleDelaySeconds?: number;
		minTaskSeconds?: number;
		quietHours?: { start: string; end: string };
	};
	fishAudio?: false | { apiKey: SecretValue; referenceId: SecretValue; model?: SecretValue };
	bark?: false | { serverUrl: SecretValue; deviceKeys: SecretValue | SecretValue[] };
}

export interface QuietHoursConfig {
	enabled: boolean;
	start: string;
	end: string;
	allowDuringQuietHours: NotificationType[];
}

export interface NotifyConfig {
	configDirectory: string;
	enabled: boolean;
	summaryLanguage: string;
	notifyRootOnly: true;
	deliveryBackends: DeliveryBackend[];
	notifyPolicy: {
		idleDelayMs: number;
		ignoreShortTasksSeconds: number;
		dedupeWindowMs: number;
		quietHours: QuietHoursConfig;
	};
	summary: {
		enabled: boolean;
		targetLength: number;
		model: string;
		instructions: string;
		timeoutMs: number;
		maxContextCharacters: number;
		maxOutputCharacters: number;
	};
	backends: {
		fishAudio: {
			apiKey: SecretValue;
			referenceId: SecretValue;
			model: SecretValue;
			format: "mp3" | "wav" | "pcm" | "opus";
			latency: "low" | "normal" | "balanced";
			normalize: boolean;
			speed: number;
			player: string;
			requestTimeoutMs: number;
			playbackTimeoutMs: number;
			maxAudioBytes: number;
		};
		bark: {
			serverUrl: SecretValue;
			deviceKeys: SecretValue | SecretValue[];
			path: string;
			requestTimeoutMs: number;
		};
	};
	detection: {
		questionToolNames: string[];
		notifyRecoveredToolErrors: boolean;
		permission: {
			eventChannel: string;
			decisionChannel: string;
		};
	};
	fallbackMessages: Record<NotificationType, string>;
}

export interface SummaryContext {
	language: string;
	event: NotificationType;
	session: {
		id: string;
		rootOnly: true;
	};
	state: {
		durationMs?: number;
		currentTask?: string;
		changedFiles?: string[];
		recentActions?: string[];
		validation?: string;
		pendingAction?: string;
		errorMessage?: string;
	};
	recentMessages?: Array<{
		role: "user" | "assistant";
		text: string;
	}>;
}

export interface NotificationPayload {
	type: NotificationType;
	title: string;
	summary: string;
	barkLevel: BarkLevel;
}

export interface RuntimeSecrets {
	failures?: Partial<Record<DeliveryBackend, DeliveryFailure>>;
	fishAudio: {
		apiKey: string | null;
		referenceId: string | null;
		model: string | null;
	};
	bark: {
		serverUrl: string | null;
		deviceKeys: string[];
	};
}
