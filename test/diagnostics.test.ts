import assert from "node:assert/strict";
import test from "node:test";
import { createDeliveryReporter, notifyLocal } from "../diagnostics.ts";
import type { HostContext } from "../host.ts";
import type { DeliveryResult } from "../types.ts";

const unavailable: DeliveryResult = {
	ok: false, error: { stage: "request", code: "http-503", message: "HTTP 503；服务暂时不可用。" },
};

function uiContext(notify: HostContext["ui"]["notify"], hasUI = true) {
	return { hasUI, ui: { notify, select: async () => undefined, input: async () => undefined } };
}

test("Pi local warnings deduplicate by backend and cause, reset on recovery, and keep cancellations quiet", () => {
	const messages: string[] = [];
	const report = createDeliveryReporter(uiContext((message, type) => {
		assert.equal(type, "warning"); messages.push(message);
	}));
	report("fishaudio", unavailable);
	report("fishaudio", unavailable);
	assert.equal(messages.length, 1);
	report("bark", unavailable);
	assert.equal(messages.length, 2);
	report("fishaudio", { ok: false, error: { stage: "request", code: "http-401", message: "HTTP 401；API key 无效。" } });
	assert.equal(messages.length, 3);
	report("fishaudio", { ok: true });
	assert.equal(messages.length, 3, "successful recovery needs no unsolicited message");
	report("fishaudio", unavailable);
	assert.equal(messages.length, 4);
	report("fishaudio", { ok: false });
	assert.equal(messages.length, 4);
	assert.match(messages[0], /^\[pi-brief\] Fish Audio 请求失败.*HTTP 503/);
});

test("headless mode and failing UI use stderr without throwing or writing to stdout", (t) => {
	const stderr: string[] = [];
	t.mock.method(console, "warn", (message: string) => stderr.push(message));
	t.mock.method(console, "log", () => assert.fail("must not corrupt stdout / RPC JSON"));
	notifyLocal(uiContext(() => assert.fail("headless UI must not be called"), false), "offline");
	notifyLocal(uiContext(() => { throw new Error("broken UI containing private data"); }), "HTTP 401");
	assert.deepEqual(stderr, ["[pi-brief] offline", "[pi-brief] HTTP 401"]);
	t.mock.method(console, "warn", () => { throw new Error("broken stderr"); });
	assert.doesNotThrow(() => notifyLocal(undefined, "still failure-open"));
});
