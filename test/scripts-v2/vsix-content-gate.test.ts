import { describe, expect, test } from "bun:test";
import {
	DEFAULT_BUDGET,
	evaluateVsixEntries,
	formatGateReport,
	parseUnzipListing,
	REQUIRED_ENTRIES,
	type VsixEntry,
} from "../../scripts-v2/vsix-content-gate.ts";

function cleanEntries(): VsixEntry[] {
	return [
		{ path: "extension.vsixmanifest", uncompressedBytes: 2_000 },
		{ path: "[Content_Types].xml", uncompressedBytes: 500 },
		{ path: "extension/package.json", uncompressedBytes: 66_000 },
		{ path: "extension/dist/extension.js", uncompressedBytes: 390_000 },
		{ path: "extension/readme.md", uncompressedBytes: 11_000 },
		{ path: "extension/changelog.md", uncompressedBytes: 26_000 },
		{ path: "extension/LICENSE.txt", uncompressedBytes: 1_000 },
		{
			path: "extension/resources/bin/ghostty-launcher",
			uncompressedBytes: 60_000,
		},
		{
			path: "extension/resources/bin/scripts/oste-steer.sh",
			uncompressedBytes: 4_000,
		},
		{ path: "extension/resources/icons/icon.png", uncompressedBytes: 50_000 },
		{
			path: "extension/resources/icons/activity-bar.svg",
			uncompressedBytes: 1_000,
		},
	];
}

describe("parseUnzipListing", () => {
	test("parses entry lines and skips header, footer, and directories", () => {
		const listing = `Archive:  releases/command-central-0.6.0-rc.50.vsix
  Length      Date    Time    Name
---------  ---------- -----   ----
     2581  05-27-2026 15:27   extension.vsixmanifest
        0  05-27-2026 15:27   extension/dist/
   391234  05-27-2026 15:27   extension/dist/extension.js
     9065  05-27-2026 15:27   extension/.claude/skills/references/agent-status-sources.md
---------                     -------
 21217743                     488 files
`;
		const entries = parseUnzipListing(listing);
		expect(entries).toEqual([
			{ path: "extension.vsixmanifest", uncompressedBytes: 2581 },
			{ path: "extension/dist/extension.js", uncompressedBytes: 391234 },
			{
				path: "extension/.claude/skills/references/agent-status-sources.md",
				uncompressedBytes: 9065,
			},
		]);
	});

	test("preserves entry names containing spaces", () => {
		const listing = `     1024  05-27-2026 15:27   extension/resources/some file.png\n`;
		expect(parseUnzipListing(listing)).toEqual([
			{ path: "extension/resources/some file.png", uncompressedBytes: 1024 },
		]);
	});
});

describe("evaluateVsixEntries", () => {
	test("clean runtime payload passes with no violations", () => {
		const result = evaluateVsixEntries("test.vsix", cleanEntries(), 450_000);
		expect(result.violations).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.fileCount).toBe(cleanEntries().length);
	});

	test("flags every forbidden artifact directory from the rc50 leak", () => {
		const leaked = [
			"extension/logs/installed-vsix-agent-status-proof-1.json",
			"extension/research/prerelease-gate/latest.json",
			"extension/.clawpatch/reports/report.md",
			"extension/releases/digest-v0.6.0-rc.49.md",
			"extension/.claude/skills/cut-preview/SKILL.md",
			"extension/specs/spec.md",
			"extension/.preview-status/cut-preview.log",
			"extension/drafts/draft.json",
			"extension/coverage-ci/lcov.info",
			"extension/.vscode/settings.json",
			"extension/scripts/release.sh",
			"extension/src/extension.ts",
			"extension/test/extension.test.ts",
		];
		const entries = [
			...cleanEntries(),
			...leaked.map((path) => ({ path, uncompressedBytes: 100 })),
		];
		const result = evaluateVsixEntries("test.vsix", entries, 450_000);
		expect(result.ok).toBe(false);
		const flagged = result.violations
			.filter((violation) => violation.rule.startsWith("forbidden directory"))
			.map((violation) => violation.detail);
		expect(flagged.sort()).toEqual([...leaked].sort());
	});

	test("flags sourcemaps anywhere in the package", () => {
		const entries = [
			...cleanEntries(),
			{ path: "extension/dist/extension.js.map", uncompressedBytes: 1_400_000 },
		];
		const result = evaluateVsixEntries("test.vsix", entries, 450_000);
		expect(
			result.violations.some(
				(violation) =>
					violation.rule === "forbidden suffix .map" &&
					violation.detail === "extension/dist/extension.js.map",
			),
		).toBe(true);
	});

	test("flags markdown outside the root readme/changelog allowlist", () => {
		const entries = [
			...cleanEntries(),
			{ path: "extension/ARCHITECTURE.md", uncompressedBytes: 5_000 },
			{ path: "extension/resources/notes.md", uncompressedBytes: 100 },
		];
		const result = evaluateVsixEntries("test.vsix", entries, 450_000);
		const flagged = result.violations
			.filter((violation) => violation.rule === "markdown outside allowlist")
			.map((violation) => violation.detail);
		expect(flagged.sort()).toEqual([
			"extension/ARCHITECTURE.md",
			"extension/resources/notes.md",
		]);
	});

	test("package metadata outside extension/ is exempt from content rules", () => {
		const result = evaluateVsixEntries("test.vsix", cleanEntries(), 450_000);
		expect(
			result.violations.some((violation) =>
				violation.detail.includes("[Content_Types].xml"),
			),
		).toBe(false);
	});

	test("flags missing required runtime entries", () => {
		const withoutLauncher = cleanEntries().filter(
			(entry) => entry.path !== "extension/resources/bin/ghostty-launcher",
		);
		const result = evaluateVsixEntries("test.vsix", withoutLauncher, 450_000);
		expect(
			result.violations.some(
				(violation) =>
					violation.rule === "missing required entry" &&
					violation.detail === "extension/resources/bin/ghostty-launcher",
			),
		).toBe(true);
	});

	test("required entries cover the runtime payload contract", () => {
		expect(REQUIRED_ENTRIES).toContain("extension/dist/extension.js");
		expect(REQUIRED_ENTRIES).toContain("extension/package.json");
	});

	test("rc50-scale package fails compressed, uncompressed, and count budgets", () => {
		const entries = [
			...cleanEntries(),
			...Array.from({ length: 480 }, (_, index) => ({
				path: `extension/research/receipt-${index}.json`,
				uncompressedBytes: 45_000,
			})),
		];
		const result = evaluateVsixEntries("test.vsix", entries, 2_667_775);
		const rules = result.violations.map((violation) => violation.rule);
		expect(rules).toContain("compressed size budget");
		expect(rules).toContain("uncompressed size budget");
		expect(rules).toContain("file count budget");
	});

	test("budget boundaries are inclusive", () => {
		const entries: VsixEntry[] = [
			...cleanEntries(),
			{
				path: "extension/resources/padding.bin",
				uncompressedBytes:
					DEFAULT_BUDGET.maxUncompressedBytes -
					cleanEntries().reduce(
						(sum, entry) => sum + entry.uncompressedBytes,
						0,
					),
			},
		];
		const result = evaluateVsixEntries(
			"test.vsix",
			entries,
			DEFAULT_BUDGET.maxCompressedBytes,
		);
		expect(result.ok).toBe(true);
	});
});

describe("formatGateReport", () => {
	test("lists each violation for a failing package", () => {
		const entries = [
			...cleanEntries(),
			{ path: "extension/logs/proof.json", uncompressedBytes: 1_000 },
		];
		const report = formatGateReport(
			evaluateVsixEntries("releases/test.vsix", entries, 450_000),
		);
		expect(report).toContain("❌");
		expect(report).toContain("forbidden directory logs/");
		expect(report).toContain("extension/logs/proof.json");
	});

	test("reports success for a clean package", () => {
		const report = formatGateReport(
			evaluateVsixEntries("releases/test.vsix", cleanEntries(), 450_000),
		);
		expect(report).toContain("✅");
	});
});
