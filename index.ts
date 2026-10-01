import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createRuntimeSecretsSource } from "./secrets.ts";
import { loadConfig } from "./config.ts";
import { isInternalWorkerProcess } from "./detection.ts";
import { installAgentNotify } from "./runtime.ts";

export default function agentNotifyExtension(pi: ExtensionAPI): void {
	// Worker processes inherit global extensions. Guard before config or hooks.
	if (isInternalWorkerProcess()) return;

	const config = loadConfig();
	if (!config.enabled) return;

	// No credential commands or background resources run during discovery.
	installAgentNotify(
		pi,
		config,
		createRuntimeSecretsSource(config, pi.exec.bind(pi)),
	);
}
