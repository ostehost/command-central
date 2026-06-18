import { describe, expect, test } from "bun:test";
import type { ProcessScanDiagnosticEntry } from "../../src/discovery/process-scanner.js";
import {
	formatRetainedDiscoveryEntry,
	getDiscoveryDiagnosticName,
	getDiscoveryFilterCategory,
	summarizeFilteredDiscoveryMatches,
} from "../../src/providers/discovery-format.js";

function entry(
	overrides: Partial<ProcessScanDiagnosticEntry> = {},
): ProcessScanDiagnosticEntry {
	return {
		pid: 100,
		command: "node helper",
		startTime: new Date("2026-01-01T00:00:00Z"),
		...overrides,
	};
}

describe("discovery-format", () => {
	test("getDiscoveryFilterCategory maps reasons to labeled buckets", () => {
		expect(getDiscoveryFilterCategory("excluded-binary").key).toBe(
			"helper-binaries",
		);
		expect(getDiscoveryFilterCategory("shell-process").key).toBe(
			"interactive-cli",
		);
		expect(getDiscoveryFilterCategory(undefined)).toEqual({
			key: "other",
			label: "Other filtered matches",
		});
	});

	test("getDiscoveryDiagnosticName prefers binary name, else detects agent type", () => {
		expect(getDiscoveryDiagnosticName(entry({ binaryName: "Node" }))).toBe(
			"node",
		);
		expect(
			getDiscoveryDiagnosticName(entry({ command: "claude --print hi" })),
		).toBe("claude");
	});

	test("summarizeFilteredDiscoveryMatches groups by category, ordered by count", () => {
		const summary = summarizeFilteredDiscoveryMatches([
			entry({ reason: "excluded-binary", binaryName: "helperd" }),
			entry({ reason: "excluded-binary", binaryName: "helperd" }),
			entry({ reason: "shell-process", binaryName: "zsh" }),
		]);
		expect(summary[0]?.label).toBe("Helper binaries");
		expect(summary[0]?.count).toBe(2);
		expect(summary[0]?.names).toBe("2 helperd");
		expect(summary[1]?.label).toBe("Interactive CLIs");
	});

	test("formatRetainedDiscoveryEntry renders type · project · pid · elapsed", () => {
		const now = new Date("2026-01-01T01:00:00Z");
		const line = formatRetainedDiscoveryEntry(
			entry({
				command: "claude code",
				projectDir: "/Users/me/projects/app",
				pid: 4321,
			}),
			now,
		);
		expect(line).toBe("claude · app · PID 4321 · running 1h");
	});
});
