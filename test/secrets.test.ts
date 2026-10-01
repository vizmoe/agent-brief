import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseConfig } from "../config.ts";
import { createRuntimeSecretsSource, createSecretResolver } from "../secrets.ts";

test("whole-value commands support nested braces, pipes, literals, and explicit env references", async () => {
	const run = promisify(execFile);
	let calls = 0;
	const env = { SHELL: "/bin/sh", EXISTING_KEY: "env-key" };
	const resolve = createSecretResolver(async (command, args, options) => {
		calls++;
		assert.equal(options?.cwd, tmpdir());
		assert.equal(options?.timeout, 10_000);
		const { stdout, stderr } = await run(command, args, { cwd: options?.cwd, env });
		return { stdout, stderr, code: 0, killed: false };
	}, tmpdir(), env);
	assert.equal((await resolve("literal-key")).value, "literal-key");
	assert.equal((await resolve("$EXISTING_KEY")).value, "env-key");
	assert.equal((await resolve("${EXISTING_KEY}")).value, "env-key");
	assert.equal((await resolve("$MISSING_KEY")).value, null);
	assert.equal((await resolve("!{printf '%s' \"${EXISTING_KEY:-fallback}\" | tr a-z A-Z}")).value, "ENV-KEY");
	assert.equal(calls, 1);
	assert.equal(env.EXISTING_KEY, "env-key");
});

test("successful command values are shared while failures retry without exposing output", async () => {
	let calls = 0;
	const resolve = createSecretResolver(async () => {
		calls++;
		return calls === 1
			? { stdout: "secret-partial", stderr: "secret-error", code: 1, killed: false }
			: { stdout: "  recovered-key\n", stderr: "", code: 0, killed: false };
	}, tmpdir());
	const failures = await Promise.all([resolve("!{read-key}"), resolve("!{read-key}")]);
	assert.deepEqual(failures.map((result) => result.value), [null, null]);
	assert.match(failures[0].error?.message ?? "", /退出码 1/);
	assert.doesNotMatch(JSON.stringify(failures), /secret-partial|secret-error|read-key/);
	assert.equal(calls, 1);
	assert.equal((await resolve("!{read-key}")).value, "recovered-key");
	assert.equal((await resolve("!{read-key}")).value, "recovered-key");
	assert.equal(calls, 2);
});

test("credential commands reject malformed, killed, empty, and oversized results", async () => {
	let output = "";
	let killed = false;
	let calls = 0;
	const resolve = createSecretResolver(async () => {
		calls++;
		return { stdout: output, stderr: "", code: 0, killed };
	}, tmpdir());
	for (const source of ["!{", "!{}", "!{echo key} suffix"]) assert.equal((await resolve(source)).value, null);
	assert.equal(calls, 0);
	assert.equal((await resolve("!{key}")).value, null);
	output = "x".repeat(65537);
	assert.equal((await resolve("!{key}")).value, null);
	output = "key"; killed = true;
	assert.equal((await resolve("!{key}")).value, null);
	const controller = new AbortController(); controller.abort();
	assert.deepEqual(await resolve("cached-key", controller.signal), { value: null });
});

test("disabled backend commands are never executed and reload gets fresh credentials", async () => {
	const config = parseConfig({ fishAudio: { apiKey: "!{fish-key}", referenceId: "voice" }, bark: false });
	let calls = 0;
	const source = createRuntimeSecretsSource(config, async (_command, _args, options) => {
		assert.ok(options?.signal);
		return { stdout: `key-${++calls}`, stderr: "", code: 0, killed: false };
	});
	const session = new AbortController();
	assert.equal((await source(session.signal)).fishAudio.apiKey, "key-1");
	assert.deepEqual((await source(session.signal)).bark.deviceKeys, []);
	session.abort();
	assert.equal((await source(new AbortController().signal)).fishAudio.apiKey, "key-2");
});

test("credential failures identify fields and classify stderr without disclosing command or output", async () => {
	const config = parseConfig({ fishAudio: { apiKey: "!{private-command --token private-token}", referenceId: "!{private-voice-command}" } });
	const source = createRuntimeSecretsSource(config, async (_command, args) => ({
		stdout: "partial-private-value",
		stderr: args[1].includes("voice") ? "lookup failed: ENOTFOUND private-host" : "Unauthorized: private-server-response",
		code: 1, killed: false,
	}));
	const result = await source(new AbortController().signal);
	const error = result.failures?.fishaudio;
	assert.match(error?.message ?? "", /fishAudio.apiKey.*退出码 1.*认证失败.*fishAudio.referenceId.*DNS.*ENOTFOUND/);
	assert.doesNotMatch(JSON.stringify(result), /private-|partial-/);
	assert.equal(result.failures?.bark, undefined);
});

test("credential deadline returns and aborts even when pi.exec ignores cancellation", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let signal: AbortSignal | undefined;
	const resolve = createSecretResolver(async (_command, _args, options) => {
		signal = options?.signal;
		return new Promise(() => undefined);
	}, tmpdir());
	const pending = resolve("!{stalled-command}");
	await new Promise((done) => setImmediate(done));
	t.mock.timers.tick(10_000);
	const result = await pending;
	assert.equal(signal?.aborted, true);
	assert.equal(result.value, null);
	assert.match(result.error?.message ?? "", /超时.*10 秒/);
});

test("session cancellation is silent even when the credential executor rejects late", async () => {
	let reject: (error: Error) => void = () => undefined;
	const resolve = createSecretResolver(async () => new Promise((_resolve, fail) => { reject = fail; }), tmpdir());
	const controller = new AbortController();
	const pending = resolve("!{credential-command}", controller.signal);
	await new Promise((done) => setImmediate(done));
	controller.abort();
	assert.deepEqual(await pending, { value: null });
	reject(new Error("private credential failure"));
	await new Promise((done) => setImmediate(done));
});
