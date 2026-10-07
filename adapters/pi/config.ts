import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseConfig as parse, loadConfig as load } from "../../core/config.ts";
export { DEFAULT_CONFIG, EVENT_PRESENTATION, eventPresentation, notificationFallback } from "../../core/config.ts";
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
	const explicit = (env.AGENT_BRIEF_CONFIG || env.PI_BRIEF_CONFIG)?.trim();
	if (explicit) return expandHomePath(explicit);

	return join(resolveAgentDirectory(env), "pi-brief", "config.json");
}

export const parseConfig = (value: unknown, path = resolveConfigPath()) => parse(value, path);
export const loadConfig = (path = resolveConfigPath()) => load(path);
