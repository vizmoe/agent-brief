import assert from "node:assert/strict";
import test from "node:test";
import { auditDecision, type AuditHost } from "../scripts/audit.ts";

const host: AuditHost = { version: "0.99.1", braceExpansionVersion: "5.0.9", developmentOnly: true };

function finding() {
	return {
		name: "brace-expansion", severity: "high", isDirect: false,
		nodes: ["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"],
		via: ["GHSA-qhr7-859c-m2p7", "GHSA-6j4f-fj2g-mc7p", "GHSA-q2hr-2g5m-vwhr"]
			.map((id) => ({ url: `https://github.com/advisories/${id}`, severity: id === "GHSA-q2hr-2g5m-vwhr" ? "moderate" : "high" })),
	};
}

function report(vulnerabilities: Record<string, unknown> = { "brace-expansion": finding() }) {
	return { auditReportVersion: 2, vulnerabilities };
}

test("audit accepts only the approved upstream advisories in the pinned development host", () => {
	assert.equal(auditDecision(report(), 1, host), "upstream");
});

test("audit preserves the high-severity threshold for clean and moderate-only reports", () => {
	assert.equal(auditDecision(report({}), 0, host), "passed");
	const moderate = { ...finding(), name: "another-package", severity: "moderate" };
	assert.equal(auditDecision(report({ "another-package": moderate }), 0, host), "passed");
	assert.equal(auditDecision(report({ "brace-expansion": finding(), "another-package": moderate }), 1, host), "upstream");
});

test("audit blocks new advisories, other vulnerable packages, and critical findings", () => {
	const changed = finding();
	changed.via.push({ url: "https://github.com/advisories/GHSA-new-advisory", severity: "high" });
	assert.equal(auditDecision(report({ "brace-expansion": changed }), 1, host), "failed");
	assert.equal(auditDecision(report({ "brace-expansion": finding(), unrelated: { ...finding(), name: "unrelated" } }), 1, host), "failed");
	assert.equal(auditDecision(report({ "brace-expansion": { ...finding(), severity: "critical" } }), 1, host), "failed");
	assert.equal(auditDecision(report({ "brace-expansion": { ...finding(), via: [{ ...finding().via[0], severity: "critical" }] } }), 1, host), "failed");
	assert.equal(auditDecision(report({ "brace-expansion": { ...finding(), via: ["another-package"] } }), 1, host), "failed");
});

test("audit exception cannot move to another package version, path, or runtime dependency", () => {
	for (const changedHost of [
		{ ...host, version: "0.99.2" },
		{ ...host, braceExpansionVersion: "5.0.10" },
		{ ...host, developmentOnly: false },
	]) assert.equal(auditDecision(report(), 1, changedHost), "failed");
	for (const nodes of [[], ["node_modules/brace-expansion"], [...finding().nodes, "node_modules/brace-expansion"]]) {
		assert.equal(auditDecision(report({ "brace-expansion": { ...finding(), nodes } }), 1, host), "failed");
	}
	assert.equal(auditDecision(report({ "brace-expansion": { ...finding(), isDirect: true } }), 1, host), "failed");
});

test("audit failures and malformed reports never become accepted upstream warnings", () => {
	for (const status of [null, 2, 127]) assert.equal(auditDecision(report(), status, host), "failed");
	for (const invalid of [
		null, "invalid JSON", {}, { auditReportVersion: 1, vulnerabilities: {} },
		{ auditReportVersion: 2, vulnerabilities: [] },
		{ ...report(), error: { code: "ENOTFOUND" } },
		report({ "brace-expansion": { ...finding(), severity: "unknown" } }),
		report({ "brace-expansion": { ...finding(), severity: ["high"] } }),
		report({ "brace-expansion": { ...finding(), via: [{ ...finding().via[0], severity: null }] } }),
	]) {
		assert.equal(auditDecision(invalid, 1, host), "failed");
		assert.equal(auditDecision(invalid, 0, host), "failed");
	}
	assert.equal(auditDecision(report({ "brace-expansion": { ...finding(), via: [] } }), 1, host), "failed");
	assert.equal(auditDecision(report(), 0, host), "failed", "a successful exit must not conceal a high finding");
	assert.equal(auditDecision(report({}), 1, host), "failed", "an unexplained failure must not be waived");
});
