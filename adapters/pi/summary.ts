import type { HostModelRegistry } from "./host.ts";
import type { NotifyConfig, SummaryContext } from "../../core/types.ts";
import { SUMMARY_SYSTEM_PROMPT, buildSummaryPrompt, normalizeSummaryOutput } from "../../core/summary.ts";
export * from "../../core/summary.ts";
/** null means unavailable; an empty string intentionally suppresses an idle notice. */
export async function runSummaryAgent(
	context: SummaryContext,
	config: NotifyConfig["summary"],
	signal?: AbortSignal,
	registry?: HostModelRegistry,
): Promise<string | null> {
	if (!config.enabled || signal?.aborted || !registry) return null;
	const slash = config.model.indexOf("/");
	if (slash < 1) return null;
	const model = registry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
	if (!model) return null;
	const controller = new AbortController();
	let finishAbort: () => void = () => undefined;
	const cancelled = new Promise<null>((resolve) => { finishAbort = () => resolve(null); });
	const abort = () => { controller.abort(); finishAbort(); };
	const timer = setTimeout(abort, config.timeoutMs);
	timer.unref?.();
	signal?.addEventListener("abort", abort, { once: true });
	try {
		if (signal?.aborted) return null;
		const response = await Promise.race([
			registry.complete(model, {
				systemPrompt: SUMMARY_SYSTEM_PROMPT + (config.instructions ? `\n\nLocal style preferences:\n${config.instructions}` : ""),
				messages: [{
					role: "user",
					content: [{ type: "text", text: buildSummaryPrompt(context, config.targetLength, config.maxContextCharacters) }],
					timestamp: Date.now(),
				}],
			}, { signal: controller.signal, maxTokens: 512 }),
			cancelled,
		]);
		if (!response || controller.signal.aborted || response.stopReason !== "stop") return null;
		const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join(" ");
		const result = normalizeSummaryOutput(text, config.maxOutputCharacters, context.language);
		return result === "" && context.event !== "idle" ? null : result;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}
