import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseBarkDeviceKeys } from "./backends.ts";
import { describeError } from "./diagnostics.ts";
import type { DeliveryFailure, NotifyConfig, RuntimeSecrets } from "./types.ts";
import { withTimeout } from "./util.ts";

type Exec = ExtensionAPI["exec"];
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_SECRET_BYTES = 64 * 1024;
interface SecretResolution {
	value: string | null;
	error?: Pick<DeliveryFailure, "code" | "message">;
}

function failed(code: string, message: string): SecretResolution {
	return { value: null, error: { code, message } };
}

/** Successful values and concurrent lookups share one cache per session. */
export function createSecretResolver(exec: Exec, cwd: string, env: NodeJS.ProcessEnv = process.env) {
	const cache = new Map<string, Promise<SecretResolution>>();
	return function resolve(value: string, signal?: AbortSignal): Promise<SecretResolution> {
		if (signal?.aborted) return Promise.resolve({ value: null });
		const source = value.trim();
		const cached = cache.get(source);
		if (cached) return cached;
		const pending = (async (): Promise<SecretResolution> => {
			try {
				let result: string | undefined = source;
				if (source.startsWith("!{")) {
					if (!source.endsWith("}") || !source.slice(2, -1).trim()) {
						return failed("syntax", "命令格式无效，!{command} 必须占据整个字段");
					}
					const shell = env.SHELL || "/bin/sh";
					const output = await withTimeout((commandSignal) => exec(shell, ["-c", source.slice(2, -1)], {
						cwd, timeout: COMMAND_TIMEOUT_MS, signal: commandSignal,
					}), COMMAND_TIMEOUT_MS, signal);
					if (signal?.aborted) return { value: null };
					if (output.killed) return failed("killed", "命令超时或被终止（上限 10 秒）");
					if (output.code !== 0) {
						const cause = describeError(output.stderr);
						return failed(`exit-${output.code}-${cause.code}`, `命令退出码 ${output.code}；${cause.message}`);
					}
					result = output.stdout;
				} else {
					const variable = source.match(/^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/);
					if (variable) {
						result = env[variable[1] ?? variable[2]];
						if (!result?.trim()) return failed("environment", "环境变量未设置或为空");
					}
				}
				const trimmed = result?.trim();
				if (!trimmed) return failed("empty", source.startsWith("!{") ? "命令输出为空" : "配置值为空");
				if (trimmed.includes("\0")) return failed("nul", "取值包含无效的 NUL 字符");
				if (Buffer.byteLength(trimmed) > MAX_SECRET_BYTES) return failed("size", "取值超过 64 KiB 上限");
				return { value: trimmed };
			} catch (error) {
				if (signal?.aborted) return { value: null };
				const cause = describeError(error);
				return failed(cause.code, cause.code === "timeout" ? "命令读取超时（上限 10 秒）" : cause.message);
			}
		})();
		cache.set(source, pending);
		void pending.then((result) => {
			if (result.value === null && cache.get(source) === pending) cache.delete(source);
		});
		return pending;
	};
}

/** Called lazily; disabled backends never execute their credential commands. */
export function createRuntimeSecretsSource(config: NotifyConfig, exec: Exec) {
	let sessionSignal: AbortSignal | undefined;
	let resolve = createSecretResolver(exec, config.configDirectory);
	return async (signal?: AbortSignal): Promise<RuntimeSecrets> => {
		if (signal !== sessionSignal) {
			sessionSignal = signal;
			resolve = createSecretResolver(exec, config.configDirectory);
		}
		const fish = config.backends.fishAudio;
		const bark = config.backends.bark;
		const fishEnabled = config.deliveryBackends.includes("fishaudio");
		const barkEnabled = config.deliveryBackends.includes("bark");
		const get = (enabled: boolean, value: string): Promise<SecretResolution> => enabled
			? resolve(value, signal) : Promise.resolve({ value: null });
		const [apiKey, referenceId, model, serverUrl, deviceKeys] = await Promise.all([
			get(fishEnabled, fish.apiKey), get(fishEnabled, fish.referenceId), get(fishEnabled, fish.model),
			get(barkEnabled, bark.serverUrl),
			Promise.all((Array.isArray(bark.deviceKeys) ? bark.deviceKeys : [bark.deviceKeys])
				.map((value) => get(barkEnabled, value))),
		]);
		const failures: NonNullable<RuntimeSecrets["failures"]> = {};
		const collect = (fields: Array<[string, SecretResolution]>): DeliveryFailure | undefined => {
			const errors = fields.filter(([, result]) => result.error);
			return errors.length ? {
				stage: "credentials",
				code: errors.map(([field, result]) => `${field}:${result.error!.code}`).join("|"),
				message: errors.map(([field, result]) => `${field}：${result.error!.message}`).join("；"),
			} : undefined;
		};
		failures.fishaudio = collect([["fishAudio.apiKey", apiKey], ["fishAudio.referenceId", referenceId], ["fishAudio.model", model]]);
		failures.bark = collect([["bark.serverUrl", serverUrl], ...deviceKeys.map((value, i): [string, SecretResolution] => [`bark.deviceKeys[${i}]`, value])]);
		return {
			failures,
			fishAudio: { apiKey: apiKey.value, referenceId: referenceId.value, model: model.value },
			bark: {
				serverUrl: serverUrl.value,
				deviceKeys: deviceKeys.some((result) => !result.value) ? []
					: [...new Set(deviceKeys.flatMap((result) => parseBarkDeviceKeys(result.value ?? undefined)))],
			},
		};
	};
}
