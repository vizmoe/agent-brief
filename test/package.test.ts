import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

test("npm packaging excludes machine configuration, tests, dependencies, and private metadata", async () => {
	const root = fileURLToPath(new URL("../", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "pi-brief-package-"));
	try {
		for (const name of await readdir(root)) {
			if (name.endsWith(".ts") || ["package.json", "config.example.json", "README.md", "LICENSE"].includes(name)) {
				await copyFile(join(root, name), join(directory, name));
			}
		}
		await writeFile(join(directory, "config.json"), '{"private":"must-not-ship"}');
		await writeFile(join(directory, ".env"), "SECRET=must-not-ship");
		await writeFile(join(directory, "debug.ts"), "// must-not-ship");
		await mkdir(join(directory, "test"));
		await writeFile(join(directory, "test", "fixture.json"), '{"private":"must-not-ship"}');
		const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			cwd: directory, timeout: 20_000,
			env: { ...process.env, npm_config_offline: "true", npm_config_cache: join(directory, "npm-cache") },
		});
		const packed = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
		const paths = packed[0].files.map((file) => file.path);
		assert.ok(paths.includes("index.ts"));
		assert.ok(paths.includes("config.example.json"));
		assert.ok(paths.includes("LICENSE"));
		assert.ok(paths.every((path) => !/^(?:config\.json$|\.env$|debug\.ts$|test\/|node_modules\/)/.test(path)));
		const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
		assert.deepEqual(new Set(paths), new Set(["package.json", ...manifest.files]));
	} finally { await rm(directory, { recursive: true, force: true }); }
});
