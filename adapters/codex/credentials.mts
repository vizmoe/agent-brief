import { homedir } from "node:os";
import { POLICY, type UserConfig } from "./config.mts";
import { createSecretResolver, createRuntimeSecretsSource } from "../../core/secrets.ts";
import { nativeCredentialExec } from "../../core/command.ts";

export async function resolveValue(value: string, label: string, timeoutMs: number = POLICY.secretTimeoutMs): Promise<string> {
  const resolve = createSecretResolver(nativeCredentialExec(POLICY.secretMaxBytes), homedir(), process.env,
    { timeoutMs, maxBytes: POLICY.secretMaxBytes, singleLine: true });
  const result = await resolve(value);
  if (result.value !== null) return result.value;
  if (result.error?.code === "syntax") throw new Error(`${label}: invalid command reference`);
  if (value.startsWith("!{")) throw new Error(`${label}: credential command failed or timed out`);
  throw new Error(`${label}: expected one nonempty output line`);
}

export async function resolveDeliverySecrets(config: UserConfig, backend: "fishaudio" | "bark", signal?: AbortSignal) {
  const source = createRuntimeSecretsSource({ ...config, deliveryBackends: [backend] }, nativeCredentialExec(POLICY.secretMaxBytes), {
    cwd: homedir(), timeoutMs: POLICY.secretTimeoutMs, maxBytes: POLICY.secretMaxBytes, singleLine: true, sequential: true,
  });
  return source(signal);
}
