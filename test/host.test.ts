import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);

// A real packaged extension and Pi process; only the external Bark server is local.
test("packed extension loads in Pi and delivers without blocking RPC or changing the conversation", { timeout: 30_000 }, async () => {
	const root = fileURLToPath(new URL("../", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "pi-brief-rpc-"));
	let child: ChildProcess | undefined;
	let closed: Promise<unknown> | undefined;
	const requests: Array<{ body: Record<string, unknown>; response: ServerResponse }> = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		requests.push({ body: JSON.parse(body), response });
	});
	const events: Array<Record<string, unknown>> = [];
	const invalidLines: string[] = [];
	let stderr = "";
	async function until<T>(find: () => T | undefined): Promise<T> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const value = find();
			if (value !== undefined) return value;
			assert.equal(child?.exitCode ?? null, null, `Pi exited early: ${stderr}`);
			await delay(10);
		}
		assert.fail(`Timed out waiting for Pi RPC; stderr: ${stderr}`);
	}
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const { stdout } = await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], {
			cwd: root, timeout: 20_000,
			env: { ...process.env, npm_config_offline: "true", npm_config_cache: join(directory, "npm-cache") },
		});
		const [{ filename }] = JSON.parse(stdout) as Array<{ filename: string }>;
		await exec("tar", ["-xzf", join(directory, filename), "-C", directory]);
		assert.equal(existsSync(join(directory, "package", "node_modules")), false);
		const profile = join(directory, "agent");
		await mkdir(profile);
		const configPath = join(directory, "config.json");
		await writeFile(configPath, JSON.stringify({
			language: "en", summary: false,
			bark: {
				serverUrl: `http://127.0.0.1:${address.port}`,
				deviceKeys: "!{printf resolved > credential-read; printf fixture-device}",
			},
		}));
		const hostRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
		const host = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8"));
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_CODING_AGENT_DIR: profile,
			PI_BRIEF_CONFIG: configPath,
			OPENAI_API_KEY: "fixture-unused-key",
		};
		for (const key of ["PI_SUBAGENT_CHILD", "PI_LANDSTRIP_WORKER", "LANDSTRIP_CONTEXT"]) delete env[key];
		child = spawn(process.execPath, [join(hostRoot, host.bin.pi),
			"--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
			"-e", join(directory, "package", "index.ts"), "--mode", "rpc", "--no-session",
			"--provider", "openai", "--model", "gpt-4o",
		], { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] });
		closed = new Promise<void>((resolve, reject) => { child!.once("close", () => resolve()); child!.once("error", reject); });
		child.stderr!.on("data", (chunk) => { stderr += chunk.toString(); });
		createInterface({ input: child.stdout! }).on("line", (line) => {
			try { events.push(JSON.parse(line)); } catch { invalidLines.push(line); }
		});
		const send = (id: string, type: string, extra: Record<string, unknown> = {}) => {
			child!.stdin!.write(`${JSON.stringify({ id, type, ...extra })}\n`);
		};
		const response = (id: string) => until(() => events.find((event) => event.type === "response" && event.id === id));
		send("commands", "get_commands");
		const commands = await response("commands");
		assert.equal(commands.success, true);
		assert.equal((commands.data as { commands: Array<{ name: string }> }).commands.filter((c) => c.name === "pi-brief-test").length, 1);
		assert.equal(existsSync(join(directory, "credential-read")), false, "discovery must not execute credentials");
		assert.equal(requests.length, 0);

		send("test", "prompt", { message: "/pi-brief-test error" });
		const pending = await until(() => requests[0]);
		assert.equal(await readFile(join(directory, "credential-read"), "utf8"), "resolved");
		assert.deepEqual(pending.body.device_keys, ["fixture-device"]);
		assert.match(String(pending.body.body), /^Pi/);
		assert.equal((await response("test")).success, true, "command returns while delivery is pending");
		send("pending", "get_state");
		const pendingState = await response("pending");
		assert.equal((pendingState.data as { isStreaming: boolean }).isStreaming, false);
		pending.response.writeHead(200, { "content-type": "application/json" });
		pending.response.end(JSON.stringify({ code: 200, data: [{ code: 200 }] }));
		const success = await until(() => events.find((event) => event.method === "notify" && String(event.message).includes("bark ok")));
		assert.equal(success.notifyType, "info");

		send("failed-test", "prompt", { message: "/pi-brief-test error" });
		const failed = await until(() => requests[1]);
		failed.response.writeHead(503);
		failed.response.end();
		const warning = await until(() => events.find((event) => event.method === "notify" && String(event.message).includes("HTTP 503")));
		assert.equal(warning.notifyType, "warning");
		assert.match(String(warning.message), /^\[pi-brief\]/);
		assert.doesNotMatch(String(warning.message), /fixture-device|fixture-unused-key/);
		send("messages", "get_messages");
		assert.deepEqual((await response("messages")).data, { messages: [] });
		assert.deepEqual(invalidLines, [], "stdout must remain valid RPC JSON");
		assert.equal(stderr, "");
	} finally {
		if (child) {
			child.kill("SIGTERM");
			const forceKill = setTimeout(() => child!.kill("SIGKILL"), 1000);
			try { await closed; } finally { clearTimeout(forceKill); }
		}
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
