import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const minimatchRequire = createRequire(hostRequire.resolve("minimatch"));

test("Pi's glob matcher resolves a patched brace-expansion release", () => {
	const { version } = minimatchRequire("brace-expansion/package.json");
	const { satisfies } = hostRequire("semver");
	assert.ok(satisfies(version, ">=5.0.12"), `Pi's minimatch resolves vulnerable brace-expansion ${version}`);
});
