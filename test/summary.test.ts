import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.ts";
import type { HostModelRegistry } from "../host.ts";
import { evidenceAwareFallback, normalizeSummaryOutput, runSummaryAgent, SUMMARY_SYSTEM_PROMPT } from "../summary.ts";
import type { SummaryContext } from "../types.ts";

const evidence: SummaryContext = {
	language: "zh-CN", event: "idle", session: { id: "root", rootOnly: true },
	state: { currentTask: "修复缓存", validation: "测试通过" },
};
const config = () => ({ ...DEFAULT_CONFIG.summary, model: "test/model" });

test("summary uses the host registry, bounded evidence, and no tools or root history", async () => {
	const model = { provider: "test", id: "model" };
	let calls = 0;
	const registry: HostModelRegistry = {
		find(provider, id) { assert.equal(`${provider}/${id}`, "test/model"); return model as never; },
		complete: async (selected, context, options) => {
			calls++;
			assert.equal(selected, model);
			assert.ok(context.systemPrompt?.startsWith(SUMMARY_SYSTEM_PROMPT));
			assert.equal(context.tools, undefined);
			assert.equal(context.messages.length, 1);
			assert.equal(context.messages[0].role, "user");
			assert.ok(options?.signal);
			assert.equal(options?.maxTokens, 512);
			return { stopReason: "stop", content: [{ type: "text", text: "缓存修复已通过测试。" }] } as never;
		},
	};
	assert.equal(await runSummaryAgent(evidence, config(), undefined, registry), "Pi。缓存修复已通过测试。");
	assert.equal(calls, 1);
});

test("model silence suppresses idle but never discards a permission or error", async () => {
	const registry: HostModelRegistry = {
		find: () => ({ provider: "test", id: "model" }) as never,
		complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "NO_NOTIFICATION" }] }) as never,
	};
	assert.equal(await runSummaryAgent(evidence, config(), undefined, registry), "");
	for (const event of ["permission", "question", "error"] as const) {
		assert.equal(await runSummaryAgent({ ...evidence, event }, config(), undefined, registry), null);
	}
	assert.equal(evidenceAwareFallback("idle", "zh-CN", { ...evidence, state: { currentTask: "修复缓存" } }, "完成"), null);
	assert.equal(normalizeSummaryOutput("好的。", 100), "");
	assert.equal(normalizeSummaryOutput("Pi", 100), "");
	assert.equal(normalizeSummaryOutput("\"NO_NOTIFICATION\"", 100), null);
});

test("timeout and session cancellation stop a summary even if the provider stalls", async () => {
	let aborted = false;
	const registry: HostModelRegistry = {
		find: () => ({ provider: "test", id: "model" }) as never,
		complete: async (_model, _context, options) => {
			options?.signal?.addEventListener("abort", () => { aborted = true; });
			return new Promise(() => undefined);
		},
	};
	const keepAlive = setTimeout(() => undefined, 1000);
	try {
		assert.equal(await runSummaryAgent(evidence, { ...config(), timeoutMs: 10 }, undefined, registry), null);
		assert.equal(aborted, true);
		aborted = false;
		const controller = new AbortController();
		const summary = runSummaryAgent(evidence, config(), controller.signal, registry);
		controller.abort();
		assert.equal(await summary, null);
		assert.equal(aborted, true);
	} finally { clearTimeout(keepAlive); }
});

test("failed or truncated model output never becomes a success notification", async () => {
	for (const stopReason of ["error", "aborted", "length", "toolUse"]) {
		const registry: HostModelRegistry = {
			find: () => ({ provider: "test", id: "model" }) as never,
			complete: async () => ({ stopReason, content: [{ type: "text", text: "成功。" }] }) as never,
		};
		assert.equal(await runSummaryAgent(evidence, config(), undefined, registry), null);
	}
});
