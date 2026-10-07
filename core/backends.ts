import { spawn, type ChildProcess } from "node:child_process";
import {
	mkdtemp,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	DeliveryFailure,
	DeliveryResult,
	NotificationPayload,
	NotifyConfig,
	RuntimeSecrets,
} from "./types.ts";

import { describeError, OperationError, safeErrorText } from "./diagnostics.ts";
import { isRecord, withTimeout } from "./util.ts";

const FISH_TTS_ENDPOINT = "https://api.fish.audio/v1/tts";
const MAX_ERROR_BYTES = 16 * 1024;

function failure(stage: DeliveryFailure["stage"], code: string, message: string): DeliveryResult {
	return { ok: false, error: { stage, code, message } };
}

// https://docs.fish.audio/api-reference/errors
const FISH_HTTP_ERRORS: Record<number, string> = {
	400: "参数无效或音色不存在，请检查 fishAudio.referenceId 和请求参数",
	401: "API key 无效或缺失，请检查 fishAudio.apiKey",
	402: "API 余额不足，请在 Fish Audio Billing 补充额度",
	403: "无权访问此资源，请检查 API key 权限和音色归属",
	404: "模型或音色不存在，请检查 fishAudio.model 和 fishAudio.referenceId",
	422: "参数校验失败，请根据服务端详情检查请求参数",
	429: "请求超过速率限制，请稍后重试",
};

/** HTTP status is authoritative; body.status is extra diagnostic context. */
function fishHttpFailure(response: Response, raw?: string, sensitive: readonly string[] = []): DeliveryFailure {
	const status = response.status;
	const hint = FISH_HTTP_ERRORS[status] ?? (status >= 500
		? "Fish Audio 服务暂时不可用，请稍后重试"
		: response.ok ? "返回的内容不是音频" : "请求被拒绝，请检查服务端详情");
	const details: string[] = [];
	let reason: string | undefined;
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	if (raw && !contentType.includes("html") && !/^\s*</.test(raw)) {
		let body: unknown;
		try { body = JSON.parse(raw); } catch { /* The API also returns plain-text parse errors. */ }
		if (isRecord(body)) {
			const message = safeErrorText(body.message, sensitive);
			reason = safeErrorText(body.reason, sensitive);
			if (message) details.push(message);
			if (reason && reason !== message) details.push(`reason: ${reason}`);
			if (typeof body.status === "number" && Number.isInteger(body.status) && body.status !== status) {
				details.push(`API status: ${body.status}`);
			}
			// Some validation responses use detail/loc/msg. Never display input or ctx.
			if (typeof body.detail === "string") {
				const detail = safeErrorText(body.detail, sensitive);
				if (detail) details.push(detail);
			} else if (Array.isArray(body.detail)) {
				for (const entry of body.detail.slice(0, 3)) {
					if (!isRecord(entry)) continue;
					const loc = Array.isArray(entry.loc) ? entry.loc
						.filter((part) => typeof part === "string" || typeof part === "number").join(".") : "";
					const detail = safeErrorText(`${loc}: ${typeof entry.msg === "string" ? entry.msg : "校验失败"}`, sensitive);
					if (detail) details.push(detail);
				}
			}
		} else if (body === undefined) {
			const message = safeErrorText(raw, sensitive);
			if (message) details.push(message);
		}
	}
	const retry = response.headers.get("retry-after");
	let retrySeconds: number | undefined;
	if (retry) {
		const value = /^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000;
		if (Number.isFinite(value) && value >= 0 && value <= 86_400) retrySeconds = Math.ceil(value);
	}
	return {
		stage: response.ok ? "response" : "request",
		code: `http-${status}${reason ? `:${reason}` : ""}`,
		message: `HTTP ${status}；${hint}。${details.length ? `服务端：${details.join("；")}。` : ""}`
			+ (retrySeconds !== undefined ? `建议 ${retrySeconds} 秒后重试。` : ""),
	};
}

export const FISH_AUDIO_PI_AGENT_PHONEME =
	"<|phoneme_start|>P AY1<|phoneme_end|>";
function terminateChild(child: ChildProcess, graceMs = 1000): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const forceKill = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}, graceMs);
	forceKill.unref?.();
	child.once("close", () => clearTimeout(forceKill));
}

export function fishAudioTextForPiAgent(summary: string): string {
	// Summary normalization owns this leading product label. Restrict the
	// rewrite to that exact position so unrelated "pi" text is never touched.
	return summary.replace(
		/^Pi(?=$|[\s\p{P}])/u,
		FISH_AUDIO_PI_AGENT_PHONEME,
	);
}

export function parseBarkDeviceKeys(raw: string | undefined): string[] {
	if (!raw?.trim()) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed)) {
			return [...new Set(
				parsed
					.filter((value): value is string => typeof value === "string")
					.map((value) => value.trim())
					.filter(Boolean),
			)];
		}
		if (typeof parsed === "string" && parsed.trim()) return [parsed.trim()];
	} catch {
		// Comma-separated fallback keeps local secret entry ergonomic.
	}
	return [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
}

function safeBarkUrl(serverUrl: string, path: string): string | null {
	try {
		const base = new URL(serverUrl);
		if (base.protocol !== "https:" && base.protocol !== "http:") return null;
		const suffix = path.startsWith("/") ? path : `/${path}`;
		base.pathname = `${base.pathname.replace(/\/+$/, "")}${suffix}`;
		base.search = "";
		base.hash = "";
		return base.toString();
	} catch {
		return null;
	}
}

export async function consumeFetchWithTimeout<T>(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	consume: (response: Response, signal: AbortSignal) => Promise<T>,
	fetchImplementation: typeof fetch = fetch,
	parentSignal?: AbortSignal,
): Promise<T> {
	return withTimeout(async (signal) => {
		const response = await fetchImplementation(url, {
			...init,
			signal,
		});
		if (signal.aborted) {
			void response.body?.cancel().catch(() => undefined);
			signal.throwIfAborted();
		}
		return await consume(response, signal);
	}, timeoutMs, parentSignal);
}

export function isSuccessfulBarkResponse(
	value: unknown,
	expectedDeviceCount: number,
): boolean {
	if (
		!isRecord(value)
		|| value.code !== 200
		|| !Array.isArray(value.data)
		|| value.data.length !== expectedDeviceCount
	) {
		return false;
	}
	return value.data.every((item) => isRecord(item) && item.code === 200);
}

export async function sendBark(
	payload: NotificationPayload,
	config: NotifyConfig,
	secrets: RuntimeSecrets,
	signal?: AbortSignal,
): Promise<DeliveryResult> {
	if (signal?.aborted) return { ok: false };
	if (secrets.failures?.bark) return { ok: false, error: secrets.failures.bark };
	const server = secrets.bark.serverUrl;
	const keys = secrets.bark.deviceKeys;
	if (!server || keys.length === 0) {
		return failure("credentials", "missing", "缺少 bark.serverUrl 或 bark.deviceKeys。");
	}
	const url = safeBarkUrl(server, config.backends.bark.path);
	if (!url) {
		return failure("credentials", "url", "bark.serverUrl 必须是有效的 HTTP(S) 地址。");
	}
	try {
		return await consumeFetchWithTimeout(
			url,
			{
				method: "POST",
				headers: { "content-type": "application/json; charset=utf-8" },
				body: JSON.stringify({
					body: payload.summary,
					title: payload.title,
					device_keys: keys,
					level: payload.barkLevel,
				}),
			},
			config.backends.bark.requestTimeoutMs,
			async (response, responseSignal) => {
				if (!response.ok) {
					void response.body?.cancel().catch(() => undefined);
					return failure("request", `http-${response.status}`, `HTTP ${response.status}；请检查 Bark 服务和 device key。`);
				}
				const body = await readResponseBodyLimited(response, 64 * 1024, responseSignal);
				let parsed: unknown;
				try {
					parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
				} catch {
					return failure("response", "invalid-json", "返回的响应不是有效 JSON，无法确认推送结果。");
				}
				const delivered = isSuccessfulBarkResponse(parsed, keys.length);
				return delivered ? { ok: true } : failure("delivery", "device", "至少有一个设备未确认投递成功，请检查 device key 和 Bark 服务。");
			},
			fetch,
			signal,
		);
	} catch (error) {
		if (signal?.aborted) return { ok: false };
		const cause = describeError(error);
		return failure("request", cause.code, cause.message);
	}
}

async function readResponseBodyLimited(
	response: Response,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	if (!response.body) throw new OperationError("empty", "响应内容为空");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const cancel = (): void => { void reader.cancel().catch(() => undefined); };
	signal?.addEventListener("abort", cancel, { once: true });
	try {
		signal?.throwIfAborted();
		while (true) {
			const result = await reader.read();
			signal?.throwIfAborted();
			if (result.done) break;
			size += result.value.byteLength;
			if (size > maxBytes) throw new OperationError("size", `响应超过 ${Math.round(maxBytes / 1024)} KiB 上限`);
			chunks.push(result.value);
		}
	} catch (error) {
		void reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		signal?.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
	const output = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function playAudio(
	filePath: string,
	player: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("playback aborted"));
			return;
		}
		let settled = false;
		const child = spawn(player, [filePath], {
			stdio: "ignore",
			windowsHide: true,
		});
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve();
		};
		const abort = (): void => {
			terminateChild(child);
			finish(new Error("playback aborted"));
		};
		const timer = setTimeout(() => {
			terminateChild(child);
			finish(new OperationError("timeout", `播放超时（上限 ${timeoutMs / 1000} 秒）`));
		}, timeoutMs);
		timer.unref?.();
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		child.once("error", (error) => finish(error));
		child.once("exit", (code, childSignal) => {
			if (code === 0) finish();
			else finish(new OperationError(`exit-${code ?? childSignal ?? "unknown"}`, `播放器异常退出（${code === null ? `信号 ${childSignal ?? "未知"}` : `退出码 ${code}`}）`));
		});
	});
}

/** Keep native playback optional while exercising the same transport on every platform. */
export function createFishAudioSender(
	audioPlayer: typeof playAudio | null = process.platform === "darwin" ? playAudio : null,
) {
	return async function sendFishAudio(
		payload: NotificationPayload,
		config: NotifyConfig,
		secrets: RuntimeSecrets,
		signal?: AbortSignal,
	): Promise<DeliveryResult> {
		if (signal?.aborted) return { ok: false };
		if (secrets.failures?.fishaudio) return { ok: false, error: secrets.failures.fishaudio };
		if (!audioPlayer) {
			return failure("playback", "platform", "本地音频播放需要 macOS。");
		}
		const { apiKey, referenceId, model } = secrets.fishAudio;
		if (!apiKey || !referenceId || !model) {
			const missing = [!apiKey && "fishAudio.apiKey", !referenceId && "fishAudio.referenceId", !model && "fishAudio.model"].filter(Boolean);
			return failure("credentials", "missing", `缺少 ${missing.join("、")}。`);
		}

		let temporaryDirectory: string | null = null;
		let stage: DeliveryFailure["stage"] = "request";
		let httpError: DeliveryFailure | undefined;
		const speechText = fishAudioTextForPiAgent(payload.summary);
		const sensitive = [apiKey, referenceId, model, payload.summary, speechText];
		try {
			const audio = await consumeFetchWithTimeout(
				FISH_TTS_ENDPOINT,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${apiKey}`,
						"content-type": "application/json",
						model,
					},
					body: JSON.stringify({
						text: speechText,
						reference_id: referenceId,
						format: config.backends.fishAudio.format,
						latency: config.backends.fishAudio.latency,
						normalize: config.backends.fishAudio.normalize,
						prosody: {
							speed: config.backends.fishAudio.speed,
							volume: 0,
						},
					}),
				},
				config.backends.fishAudio.requestTimeoutMs,
				async (response, responseSignal) => {
					const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
					if (
						!response.ok || (contentType && !contentType.startsWith("audio/")
						&& !contentType.startsWith("application/octet-stream"))
					) {
						// Preserve the known HTTP failure even if its body stalls or is malformed.
						httpError = fishHttpFailure(response);
						const body = await readResponseBodyLimited(response, MAX_ERROR_BYTES, responseSignal);
						httpError = fishHttpFailure(response, new TextDecoder().decode(body), sensitive);
						return null;
					}
					stage = "response";
					return readResponseBodyLimited(
						response,
						config.backends.fishAudio.maxAudioBytes,
						responseSignal,
					);
				},
				fetch,
				signal,
			);
			if (signal?.aborted) return { ok: false };
			if (httpError) return { ok: false, error: httpError };
			if (!audio || audio.byteLength === 0) return failure("response", "empty", "返回的音频为空。");
			stage = "storage";
			temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-brief-"));
			const filePath = join(
				temporaryDirectory,
				`notification.${config.backends.fishAudio.format}`,
			);
			await writeFile(filePath, audio, { mode: 0o600 });
			stage = "playback";
			await audioPlayer(
				filePath,
				config.backends.fishAudio.player,
				config.backends.fishAudio.playbackTimeoutMs,
				signal,
			);
			return { ok: true };
		} catch (error) {
			if (signal?.aborted) return { ok: false };
			const cause = describeError(error);
			if (httpError) return { ok: false, error: {
				...httpError, message: `${httpError.message}错误详情读取失败：${cause.message}。`,
			} };
			return failure(stage, cause.code, cause.code === "timeout" && stage !== "playback"
				? `请求或音频读取超时（上限 ${config.backends.fishAudio.requestTimeoutMs / 1000} 秒）。`
				: cause.message);
		} finally {
			if (temporaryDirectory) {
				try {
					await rm(temporaryDirectory, { recursive: true, force: true });
				} catch {
					// Best-effort cleanup of the private temporary directory.
				}
			}
		}
	}
}

export const sendFishAudio = createFishAudioSender();
