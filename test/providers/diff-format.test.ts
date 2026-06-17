import { describe, expect, test } from "bun:test";
import type { FileChangeNode } from "../../src/providers/agent-status-tree-provider.js";
import {
	buildGitDiffArgs,
	deriveFallbackFileChangeStatus,
	extractCommitHash,
	formatFileChangeDescription,
	formatNotificationDiffSummary,
	formatPerFileDiffSummary,
	getFileChangePathParts,
	parsePerFileDiffsFromNumstat,
	parsePerFileStatusesFromNameStatus,
	shortenCommitHash,
} from "../../src/providers/diff-format.js";

describe("diff-format", () => {
	test("parsePerFileDiffsFromNumstat handles text and binary (-) rows", () => {
		const diffs = parsePerFileDiffsFromNumstat(
			"3\t1\tsrc/a.ts\n-\t-\tassets/logo.png\n",
		);
		expect(diffs).toEqual([
			{ filePath: "src/a.ts", additions: 3, deletions: 1 },
			{ filePath: "assets/logo.png", additions: -1, deletions: -1 },
		]);
		expect(parsePerFileDiffsFromNumstat("")).toEqual([]);
	});

	test("parsePerFileStatusesFromNameStatus normalizes to A/D/M", () => {
		const statuses = parsePerFileStatusesFromNameStatus(
			"A\tnew.ts\nD\tgone.ts\nR100\told.ts\tmoved.ts\n",
		);
		expect(statuses.get("new.ts")).toBe("A");
		expect(statuses.get("gone.ts")).toBe("D");
		// Renames take the final path and fall through to "M".
		expect(statuses.get("moved.ts")).toBe("M");
	});

	test("buildGitDiffArgs targets working tree or a commit range", () => {
		expect(buildGitDiffArgs("/repo", "--numstat")).toEqual([
			"-C",
			"/repo",
			"diff",
			"--numstat",
		]);
		expect(buildGitDiffArgs("/repo", "--numstat", "abc")).toEqual([
			"-C",
			"/repo",
			"diff",
			"--numstat",
			"abc..HEAD",
		]);
		expect(buildGitDiffArgs("/repo", "--name-status", "abc", "def")).toEqual([
			"-C",
			"/repo",
			"diff",
			"--name-status",
			"abc..def",
		]);
	});

	test("deriveFallbackFileChangeStatus infers from additions/deletions", () => {
		expect(
			deriveFallbackFileChangeStatus({
				filePath: "x",
				additions: 0,
				deletions: 4,
			}),
		).toBe("D");
		expect(
			deriveFallbackFileChangeStatus({
				filePath: "x",
				additions: 4,
				deletions: 0,
			}),
		).toBe("A");
		expect(
			deriveFallbackFileChangeStatus({
				filePath: "x",
				additions: 2,
				deletions: 2,
			}),
		).toBe("M");
	});

	test("commit-hash helpers extract and shorten", () => {
		expect(extractCommitHash("a1b2c3d done thing")).toBe("a1b2c3d");
		expect(extractCommitHash("not a hash")).toBeUndefined();
		expect(shortenCommitHash("a1b2c3d4e5f6")).toBe("a1b2c3d");
	});

	test("summaries and file-change description format counts + path", () => {
		expect(formatNotificationDiffSummary(null)).toBe("no changes detected");
		expect(
			formatPerFileDiffSummary([
				{ filePath: "a", additions: 2, deletions: 1 },
				{ filePath: "b", additions: 3, deletions: 0 },
			]),
		).toBe("2 files · +5 / -1");
		expect(getFileChangePathParts("src/providers/x.ts")).toEqual({
			filename: "x.ts",
			directory: "src/providers",
		});
		const node = {
			type: "fileChange",
			filePath: "src/a.ts",
			additions: 3,
			deletions: 1,
			status: "M",
		} as FileChangeNode;
		expect(formatFileChangeDescription(node)).toBe("src · M +3 -1");
	});
});
