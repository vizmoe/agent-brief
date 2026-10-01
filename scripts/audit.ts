import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface AuditHost {
	version: string;
	braceExpansionVersion: string;
	developmentOnly: boolean;
}

// https://github.com/vizmoe/pi-brief/issues/3: remove when the upstream host is fixed.
const approvedAdvisories = new Set([
	"https://github.com/advisories/GHSA-qhr7-859c-m2p7",
	"https://github.com/advisories/GHSA-6j4f-fj2g-mc7p",
	"https://github.com/advisories/GHSA-q2hr-2g5m-vwhr",
]);
const dependencyPath = "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function auditDecision(report: unknown, status: number | null, host: AuditHost): "passed" | "upstream" | "failed" {
	if ((status !== 0 && status !== 1) || !isObject(report) || "error" in report
		|| report.auditReportVersion !== 2 || !isObject(report.vulnerabilities)) return "failed";
	const blocking: Array<[string, Record<string, unknown>]> = [];
	for (const [name, finding] of Object.entries(report.vulnerabilities)) {
		if (!isObject(finding) || typeof finding.severity !== "string"
			|| !["info", "low", "moderate", "high", "critical"].includes(finding.severity)) return "failed";
		if (finding.severity === "high" || finding.severity === "critical") blocking.push([name, finding]);
	}
	if (status === 0) return blocking.length === 0 ? "passed" : "failed";
	if (blocking.length === 0 || !host.developmentOnly || host.version !== "0.99.1" || host.braceExpansionVersion !== "5.0.9") return "failed";
	const approved = blocking.every(([name, finding]) => name === "brace-expansion" && finding.name === name
		&& finding.severity === "high" && finding.isDirect === false
		&& Array.isArray(finding.nodes) && finding.nodes.length === 1 && finding.nodes[0] === dependencyPath
		&& Array.isArray(finding.via) && finding.via.length > 0
		&& finding.via.every((advisory: unknown) => isObject(advisory) && typeof advisory.url === "string"
			&& typeof advisory.severity === "string" && ["info", "low", "moderate", "high"].includes(advisory.severity)
			&& approvedAdvisories.has(advisory.url)));
	return approved ? "upstream" : "failed";
}

function runAudit() {
	const root = fileURLToPath(new URL("../", import.meta.url));
	const result = spawnSync("npm", ["audit", "--json", "--audit-level=high"], {
		cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
	});
	process.stdout.write(result.stdout ?? "");
	process.stderr.write(result.stderr ?? "");
	if (result.error) throw result.error;
	const readJson = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
	const manifest = readJson("package.json");
	const hostName = "@earendil-works/pi-coding-agent";
	const version = readJson(`node_modules/${hostName}/package.json`).version;
	const decision = auditDecision(JSON.parse(result.stdout), result.status, {
		version,
		braceExpansionVersion: readJson(`${dependencyPath}/package.json`).version,
		developmentOnly: manifest.devDependencies?.[hostName] === version
			&& !manifest.dependencies?.[hostName] && !manifest.optionalDependencies?.[hostName],
	});
	if (decision === "upstream") console.warn("Accepted the known Pi 0.99.1 development-host advisories tracked in https://github.com/vizmoe/pi-brief/issues/3.");
	process.exitCode = decision === "failed" ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	try { runAudit(); }
	catch (error) {
		console.error("Dependency audit could not complete:", error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
