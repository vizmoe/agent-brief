import type { HostContext } from "./host.ts";
import type { DeliveryBackend, DeliveryResult } from "../../core/types.ts";
import { formatDeliveryFailure } from "../../core/diagnostics.ts";
export { describeError, formatDeliveryFailure } from "../../core/diagnostics.ts";
type LocalUI = Pick<HostContext, "hasUI" | "ui">;
/** Pi notify is fire-and-forget in TUI/RPC. Headless output belongs on stderr. */
export function notifyLocal(ctx: LocalUI | undefined, message: string, level: "info" | "warning" = "warning"): void {
	const text = `[pi-brief] ${message}`;
	try {
		if (ctx?.hasUI) {
			ctx.ui.notify(text, level);
			return;
		}
	} catch { /* A broken UI must not escape into the agent or hide the diagnostic. */ }
	try { console.warn(text); } catch { /* Reporting is also failure-open. */ }
}

/** One reporter per session; repeated failures stay quiet until that backend succeeds. */
export function createDeliveryReporter(ctx?: LocalUI) {
	const seen = new Set<string>();
	return (backend: DeliveryBackend, result: DeliveryResult, showFailure = true): void => {
		if (result.ok) {
			for (const key of seen) if (key.startsWith(`${backend}:`)) seen.delete(key);
			return;
		}
		if (!result.error || !showFailure) return;
		const key = `${backend}:${result.error.stage}:${result.error.code}`;
		if (seen.has(key)) return;
		if (seen.size >= 128) seen.delete(seen.values().next().value!);
		seen.add(key);
		notifyLocal(ctx, formatDeliveryFailure(backend, result.error));
	};
}
