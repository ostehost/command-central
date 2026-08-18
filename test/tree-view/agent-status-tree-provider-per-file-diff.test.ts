import { afterEach, beforeEach, describe, expect, test } from "bun:test";

function getExecArgs(fnArgs: unknown[]): string[] {
	return (fnArgs[1] as string[] | undefined) ?? [];
}

import {
	type AgentStatusTreeProvider,
	type AgentTask,
	createProviderHarness,
	disposeHarness,
	type ProviderHarness,
} from "./_helpers/agent-status-tree-provider-test-base.js";

describe("AgentStatusTreeProvider.getPerFileDiffs", () => {
	let h: ProviderHarness;
	let provider: AgentStatusTreeProvider;
	let execFileSyncMock: ProviderHarness["execFileSyncMock"];
	let lastExecArgs: string[];
	let execCalls: string[][];
	let execOutput: string;
	let execError: Error | null;

	beforeEach(() => {
		h = createProviderHarness();
		provider = h.provider;
		execFileSyncMock = h.execFileSyncMock;
		lastExecArgs = [];
		execCalls = [];
		execOutput = "";
		execError = null;
		execFileSyncMock.mockReset();
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const args = getExecArgs(fnArgs);
			lastExecArgs = args;
			execCalls.push(args);
			if (execError) throw execError;
			return execOutput;
		});
	});

	afterEach(() => {
		disposeHarness(h);
	});

	test("parses running-agent diff output from working tree and includes file statuses", () => {
		execFileSyncMock.mockReset();
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const args = getExecArgs(fnArgs);
			lastExecArgs = args;
			execCalls.push(args);
			if (args.includes("--name-status")) {
				return "M\tsrc/a.ts\nA\tREADME.md\n";
			}
			return "10\t2\tsrc/a.ts\n5\t0\tREADME.md\n";
		});

		const result = provider.getPerFileDiffs("/tmp/project");
		const gitDiffCalls = execCalls.filter((args) => args[0] === "-C");

		expect(gitDiffCalls).toEqual([
			["-C", "/tmp/project", "diff", "--numstat"],
			["-C", "/tmp/project", "diff", "--name-status"],
		]);
		expect(result).toEqual([
			{ filePath: "src/a.ts", additions: 10, deletions: 2, status: "M" },
			{ filePath: "README.md", additions: 5, deletions: 0, status: "A" },
		]);
	});

	test("uses startCommit..HEAD for completed-agent diffs", () => {
		execFileSyncMock.mockReset();
		execCalls = [];
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const args = getExecArgs(fnArgs);
			lastExecArgs = args;
			execCalls.push(args);
			if (args.includes("--name-status")) {
				return "M\tsrc/b.ts\n";
			}
			return "1\t1\tsrc/b.ts\n";
		});

		const result = provider.getPerFileDiffs("/tmp/project", "abc123", "HEAD");

		expect(execCalls).toEqual([
			["-C", "/tmp/project", "diff", "--numstat", "abc123..HEAD"],
			["-C", "/tmp/project", "diff", "--name-status", "abc123..HEAD"],
		]);
		expect(result).toEqual([
			{ filePath: "src/b.ts", additions: 1, deletions: 1, status: "M" },
		]);
	});

	test("marks binary files with sentinel counts", () => {
		execFileSyncMock.mockReset();
		execCalls = [];
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const args = getExecArgs(fnArgs);
			lastExecArgs = args;
			execCalls.push(args);
			if (args.includes("--name-status")) {
				return "A\tassets/logo.png\n";
			}
			return "-\t-\tassets/logo.png\n";
		});

		const result = provider.getPerFileDiffs("/tmp/project", "HEAD~1", "HEAD");

		expect(result).toEqual([
			{
				filePath: "assets/logo.png",
				additions: -1,
				deletions: -1,
				status: "A",
			},
		]);
	});

	test("returns empty array when git fails", () => {
		execError = new Error("not a git repo");

		const result = provider.getPerFileDiffs("/tmp/not-a-repo");

		expect(result).toEqual([]);
	});

	test("does not substitute HEAD~1..HEAD when startCommit ref is stale", () => {
		execFileSyncMock.mockReset();
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const args = getExecArgs(fnArgs);
			execCalls.push(args);
			throw new Error("bad revision");
		});

		const result = provider.getPerFileDiffs(
			"/tmp/project",
			"stale-commit",
			"HEAD",
		);
		const gitDiffCalls = execCalls.filter((args) => args[0] === "-C");

		expect(gitDiffCalls).toEqual([
			["-C", "/tmp/project", "diff", "--numstat", "stale-commit..HEAD"],
		]);
		expect(gitDiffCalls.some((args) => args.includes("HEAD~1..HEAD"))).toBe(
			false,
		);
		expect(result).toEqual([]);
	});

	test("does not substitute HEAD~1..HEAD when start..end is empty", () => {
		execFileSyncMock.mockReset();
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const args = getExecArgs(fnArgs);
			execCalls.push(args);
			return "";
		});

		const result = provider.getPerFileDiffs(
			"/tmp/project",
			"2f26ae54293cdfe359b7c288a97134642b3a7db2",
			"2f26ae54293cdfe359b7c288a97134642b3a7db2",
		);
		const gitDiffCalls = execCalls.filter((args) => args[0] === "-C");

		expect(gitDiffCalls).toEqual([
			[
				"-C",
				"/tmp/project",
				"diff",
				"--numstat",
				"2f26ae54293cdfe359b7c288a97134642b3a7db2..2f26ae54293cdfe359b7c288a97134642b3a7db2",
			],
		]);
		expect(gitDiffCalls.some((args) => args.includes("HEAD~1..HEAD"))).toBe(
			false,
		);
		expect(result).toEqual([]);
	});

	test("maps explicit A/M/D statuses from name-status output", () => {
		execFileSyncMock.mockReset();
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const args = getExecArgs(fnArgs);
			lastExecArgs = args;
			execCalls.push(args);
			if (args.includes("--name-status")) {
				return "A\tsrc/new.ts\nM\tsrc/changed.ts\nD\tsrc/deleted.ts\n";
			}
			return "4\t0\tsrc/new.ts\n2\t2\tsrc/changed.ts\n0\t6\tsrc/deleted.ts\n";
		});

		const result = provider.getPerFileDiffs("/tmp/project", "abc123", "def456");

		expect(result).toEqual([
			{ filePath: "src/new.ts", additions: 4, deletions: 0, status: "A" },
			{
				filePath: "src/changed.ts",
				additions: 2,
				deletions: 2,
				status: "M",
			},
			{ filePath: "src/deleted.ts", additions: 0, deletions: 6, status: "D" },
		]);
	});

	test("getDiffSummary uses start_sha so header matches per-file diff range", () => {
		execOutput = "10\t2\tsrc/a.ts\n5\t0\tREADME.md\n";
		const task = {
			status: "completed",
			project_dir: "/tmp/project",
			start_sha: "abc123",
			end_commit: "HEAD",
		} as AgentTask;
		lastExecArgs = [];

		const result = provider.getDiffSummary("/tmp/project", task);

		expect(lastExecArgs).toEqual([
			"-C",
			"/tmp/project",
			"diff",
			"--numstat",
			"abc123..HEAD",
		]);
		expect(result).toBe("2 files · +15 / -2");
	});
});
