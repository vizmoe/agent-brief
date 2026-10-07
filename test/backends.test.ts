import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { consumeFetchWithTimeout, createFishAudioSender, sendBark, sendFishAudio as sendNativeFishAudio } from "../core/backends.ts";
import { parseConfig } from "../adapters/pi/config.ts";
import type { DeliveryResult, NotificationPayload, RuntimeSecrets } from "../core/types.ts";

const config = () => parseConfig({ fishAudio: { apiKey: "key", referenceId: "voice" } });
const secrets: RuntimeSecrets = {
	fishAudio: { apiKey: "test-private-api-key", referenceId: "test-private-voice", model: "s2-pro" },
	bark: { serverUrl: "https://example.invalid", deviceKeys: ["test-private-device"] },
};
const payload: NotificationPayload = {
	type: "error", title: "Pi", summary: "Pi。合成的测试通知，不含真实会话内容。", barkLevel: "active",
};
const mac = { skip: process.platform !== "darwin" };
const sendFishAudio = createFishAudioSender(async () => assert.fail("error responses must not reach playback"));

function errorOf(result: DeliveryResult) {
	assert.equal(result.ok, false);
	assert.ok(!result.ok && result.error);
	return result.error;
}

test("Fish HTTP errors explain documented status codes, body message, reason, and retry hints", async (t) => {
	let response: Response;
	t.mock.method(globalThis, "fetch", async () => response);
	const cases: Array<[number, unknown, RegExp]> = [
		[400, { status: 400, message: "Reference model not found" }, /参数无效或音色不存在.*Reference model not found/],
		[401, { status: 401, message: "Invalid Token" }, /API key 无效.*Invalid Token/],
		[402, { status: 402, message: "Insufficient credits" }, /余额不足.*Insufficient credits/],
		[403, { status: 403, message: "Forbidden" }, /无权访问.*Forbidden/],
		[404, { status: 404, message: "Voice not found" }, /模型或音色不存在.*Voice not found/],
		[422, { detail: [{ loc: ["body", "reference_id"], msg: "Expected a string", input: "never-show-input", ctx: { secret: "never-show-context" } }] }, /参数校验失败.*body.reference_id: Expected a string/],
		[429, { status: 429, message: "Too many requests" }, /速率限制.*建议 12 秒后重试/],
		[500, { status: 500, message: "Internal server error" }, /服务暂时不可用.*Internal server error/],
		[503, { status: 503, message: "Unavailable", reason: "upstream_unavailable" }, /reason: upstream_unavailable/],
		[418, { status: 999, message: "Unexpected response" }, /HTTP 418.*API status: 999/],
	];
	for (const [status, body, expected] of cases) {
		response = new Response(JSON.stringify(body), { status, headers: {
			"content-type": "application/json", ...(status === 429 ? { "retry-after": "12" } : {}),
		} });
		const error = errorOf(await sendFishAudio(payload, config(), secrets));
		assert.equal(error.stage, "request");
		assert.match(error.message, expected);
		assert.doesNotMatch(error.message, /never-show-input|never-show-context/);
	}
});

test("Fish error details redact request secrets, input text, credentials, and terminal controls", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
		message: `Invalid ${secrets.fishAudio.apiKey} ${secrets.fishAudio.referenceId}; token=other-token; ${payload.summary} \u001b[31mred\u001b[0m \u001b]8;;https://unsafe.invalid\u0007link\u001b]8;;\u0007`,
		reason: "x".repeat(5000),
	}), { status: 400, headers: { "content-type": "application/json" } }));
	const error = errorOf(await sendFishAudio(payload, config(), secrets));
	assert.match(error.message, /\[redacted\]/);
	assert.doesNotMatch(error.message, /test-private|other-token|合成的测试通知|unsafe.invalid|\u001b|\u0007/);
	assert.ok(error.message.length < 650);
});

test("Fish plain-text parse errors and HTML proxies have safe fallbacks", async (t) => {
	let response = new Response("Failed to parse request body: expected object", { status: 400 });
	t.mock.method(globalThis, "fetch", async () => response);
	assert.match(errorOf(await sendFishAudio(payload, config(), secrets)).message, /Failed to parse request body/);
	response = new Response("<html>private proxy diagnostics</html>", { status: 502, headers: { "content-type": "text/html" } });
	const error = errorOf(await sendFishAudio(payload, config(), secrets));
	assert.match(error.message, /HTTP 502.*服务暂时不可用/);
	assert.doesNotMatch(error.message, /private proxy|html/);
	response = new Response(JSON.stringify({ message: "Not audio" }), { status: 200, headers: { "content-type": "application/json" } });
	assert.equal(errorOf(await sendFishAudio(payload, config(), secrets)).stage, "response");
});

test("Fish preserves HTTP status when an error body exceeds the limit or stalls", async (t) => {
	let response = new Response("x".repeat(16 * 1024 + 1), { status: 401 });
	let signal: AbortSignal | null | undefined;
	t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { signal = init.signal; return response; });
	const oversized = errorOf(await sendFishAudio(payload, config(), secrets));
	assert.match(oversized.message, /HTTP 401.*详情读取失败.*16 KiB/);
	const cfg = config();
	cfg.backends.fishAudio.requestTimeoutMs = 10;
	response = new Response(new ReadableStream({ start() { /* Deliberately ignores abort. */ } }), { status: 503 });
	const [result] = await Promise.all([sendFishAudio(payload, cfg, secrets), delay(30)]);
	assert.equal(signal?.aborted, true);
	assert.match(errorOf(result).message, /HTTP 503.*详情读取失败.*超时/);
});

test("network diagnostics expose safe cause codes while cancelled Fish requests remain silent", async (t) => {
	t.mock.method(globalThis, "fetch", async () => {
		throw new TypeError("fetch failed with private-transport-data", { cause: Object.assign(new Error("secret URL"), { code: "ENOTFOUND" }) });
	});
	const error = errorOf(await sendFishAudio(payload, config(), secrets));
	assert.match(error.message, /DNS.*ENOTFOUND/);
	assert.doesNotMatch(error.message, /private-transport-data|secret URL/);
	const controller = new AbortController();
	controller.abort();
	assert.deepEqual(await sendFishAudio(payload, config(), secrets, controller.signal), { ok: false });
});

test("Fish rejects empty audio and oversized responses before playback", async (t) => {
	let audio = new Uint8Array();
	t.mock.method(globalThis, "fetch", async () => new Response(audio, { headers: { "content-type": "audio/mpeg" } }));
	assert.match(errorOf(await sendFishAudio(payload, config(), secrets)).message, /音频为空/);
	audio = new Uint8Array(10);
	const cfg = config();
	cfg.backends.fishAudio.maxAudioBytes = 5;
	assert.equal(errorOf(await sendFishAudio(payload, cfg, secrets)).stage, "response");
});

test("native player failures include exit status and launch errors", mac, async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(10), { headers: { "content-type": "audio/mpeg" } }));
	const cfg = config();
	cfg.backends.fishAudio.player = "/usr/bin/false";
	const exit = errorOf(await sendNativeFishAudio(payload, cfg, secrets));
	assert.equal(exit.stage, "playback");
	assert.match(exit.message, /退出码 1/);
	cfg.backends.fishAudio.player = "/does-not-exist/pi-brief-test-player";
	assert.match(errorOf(await sendNativeFishAudio(payload, cfg, secrets)).message, /ENOENT/);
	cfg.backends.fishAudio.player = "/usr/bin/true";
	assert.deepEqual(await sendNativeFishAudio(payload, cfg, secrets), { ok: true });
});

test("portable Fish transport writes a private audio file and cleans it after playback or failure", async (t) => {
	const audio = new Uint8Array([1, 2, 3]);
	t.mock.method(globalThis, "fetch", async () => new Response(audio, { headers: { "content-type": "audio/mpeg" } }));
	let file = "";
	let fail = false;
	const sender = createFishAudioSender(async (filePath, _player, _timeout, signal) => {
		file = filePath;
		assert.equal(signal?.aborted, false);
		assert.deepEqual(new Uint8Array(await readFile(filePath)), audio);
		assert.equal((await stat(filePath)).mode & 0o777, 0o600);
		if (fail) throw Object.assign(new Error("private player path"), { code: "EACCES" });
	});
	const signal = new AbortController().signal;
	assert.deepEqual(await sender(payload, config(), secrets, signal), { ok: true });
	assert.equal(existsSync(file), false);
	fail = true;
	const error = errorOf(await sender(payload, config(), secrets, signal));
	assert.equal(error.stage, "playback");
	assert.match(error.message, /EACCES/);
	assert.equal(existsSync(file), false);
});

test("an unavailable native player skips Fish before any network request", async (t) => {
	t.mock.method(globalThis, "fetch", async () => assert.fail("unsupported platforms must not call TTS"));
	assert.equal(errorOf(await createFishAudioSender(null)(payload, config(), secrets)).code, "platform");
});

test("HTTP deadline also bounds a fetch implementation that ignores its abort signal", async () => {
	let signal: AbortSignal | null | undefined;
	const pending = consumeFetchWithTimeout("https://example.invalid", {}, 10, (response) => response.text(), async (_url, init) => {
		signal = init?.signal;
		return new Promise(() => undefined);
	});
	await Promise.all([assert.rejects(pending, { name: "TimeoutError" }), delay(30)]);
	assert.equal(signal?.aborted, true);
});

test("Bark returns structured failures and verifies every target device", async (t) => {
	let response = new Response("", { status: 503 });
	t.mock.method(globalThis, "fetch", async () => response);
	assert.match(errorOf(await sendBark(payload, config(), secrets)).message, /HTTP 503/);
	response = new Response(JSON.stringify({ code: 200, data: [{ code: 400 }] }));
	assert.equal(errorOf(await sendBark(payload, config(), secrets)).stage, "delivery");
	response = new Response(JSON.stringify({ code: 200, data: [{ code: 200 }] }));
	assert.deepEqual(await sendBark(payload, config(), secrets), { ok: true });
});
