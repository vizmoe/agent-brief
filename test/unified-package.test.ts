import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test("one agent-brief version identifies the Pi package and Codex plugin", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "agent-brief");
  const plugin = JSON.parse(await readFile(join(root, ".codex-plugin/plugin.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  assert.equal(plugin.name, manifest.name);
  assert.equal(plugin.version, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  assert.equal(manifest.repository.url, "https://github.com/vizmoe/agent-brief.git");
});

test("both native entrypoints ship with their shared core in one standalone artifact", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-brief-package-"));
  try {
    const { stdout } = await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], { cwd: root });
    const [{ filename }] = JSON.parse(stdout);
    await exec("tar", ["-xzf", join(directory, filename), "-C", directory]);
    const packed = join(directory, "package");
    for (const path of ["index.ts", "adapters/pi/index.ts", "core/backends.ts", "core/secrets.ts", "hooks/hooks.json", "skills/codex-brief/SKILL.md", "scripts/codex-brief.mts"]) {
      await access(join(packed, path));
    }
    await assert.rejects(access(join(packed, "node_modules")));
    const result = await exec(process.execPath, [join(packed, "scripts/codex-brief.mts"), "--paths"], {
      cwd: tmpdir(), env: { ...process.env, CODEX_HOME: join(directory, "profile"), CODEX_BRIEF_CONFIG: join(directory, "fixture.json") },
    });
    const paths = JSON.parse(result.stdout);
    assert.equal(await realpath(paths.pluginRoot), await realpath(packed));
    assert.equal(paths.config, join(directory, "fixture.json"));
    assert.equal(result.stderr.replace(/\(node:\d+\) ExperimentalWarning:[\s\S]*/, ""), "");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("npm version updates both native distributions and drift blocks packaging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-brief-version-"));
  try {
    const { mkdir, copyFile, writeFile } = await import("node:fs/promises");
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, ".codex-plugin"));
    for (const file of ["package.json", "package-lock.json", ".codex-plugin/plugin.json", "scripts/sync-version.ts"]) {
      await copyFile(join(root, file), join(directory, file));
    }
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await exec("npm", ["version", "patch", "--no-git-tag-version"], { cwd: directory });
    const read = async (name: string) => JSON.parse(await readFile(join(directory, name), "utf8"));
    const manifest = await read("package.json"), plugin = await read(".codex-plugin/plugin.json"), lock = await read("package-lock.json");
    assert.equal(plugin.version, manifest.version);
    assert.equal(lock.packages[""].version, manifest.version);
    assert.notEqual(manifest.version, JSON.parse(await readFile(join(root, "package.json"), "utf8")).version);
    await exec("npm", ["run", "check:version"], { cwd: directory });
    await writeFile(join(directory, ".codex-plugin/plugin.json"), JSON.stringify({ ...plugin, version: "0.0.0" }));
    await assert.rejects(exec("npm", ["run", "check:version"], { cwd: directory }), /must share one name and version/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
