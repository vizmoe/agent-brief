import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), "utf8"));
const { name, version } = read("package.json");
const path = ".codex-plugin/plugin.json";
const plugin = read(path);
if (process.argv.includes("--check")) {
  const lock = read("package-lock.json");
  if (plugin.version !== version || plugin.name !== name || lock.version !== version
    || lock.packages[""].version !== version || lock.name !== name) {
    throw new Error("Package, lockfile and Codex manifest must share one name and version; run npm version or scripts/sync-version.ts.");
  }
} else {
  writeFileSync(new URL(path, root), JSON.stringify({ ...plugin, name, version }, null, 2) + "\n");
}
