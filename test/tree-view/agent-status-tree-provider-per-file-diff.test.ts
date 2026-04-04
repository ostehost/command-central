import { beforeEach, describe, expect, mock, test } from "bun:test";

let execOutput = "";
let execError: Error | null = null;
let lastExecArgs: string[] = [];

const mockExecFileSync = mock((_cmd: string, args: string[]) => {
	lastExecArgs = args;
	if (execError) throw execError;
	return execOutput;
});

mock.module("node:child_process", () => ({
	execFileSync: mockExecFileSync,
}));

const mockDetectListeningPorts = mock(
	() => [] as Array<{ port: number; pid: number; process: string }>,
);
mock.module("../../src/utils/port-detector.js", () => ({
	detectListeningPortsAsync: mockDetectListeningPorts,
}));

import {
	AgentStatusTreeProvider,
	type AgentTask,
} from "../../src/providers/agent-status-tree-provider.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("AgentStatusTreeProvider.getPerFileDiffs", () => {
	beforeEach(() => {
		setupVSCodeMock();
		execOutput = "";
		execError = null;
		lastExecArgs = [];
		mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
			lastExecArgs = args;
			if (execError) throw execError;
			return execOutput;
		});
	});

	test("parses running-agent numstat output from working tree", () => {
		execOutput = "10\t2\tsrc/a.ts\n5\t0\tREADME.md\n";
		const provider = new AgentStatusTreeProvider();

		const result = provider.getPerFileDiffs("/tmp/project");

		expect(lastExecArgs).toEqual(["-C", "/tmp/project", "diff", "--numstat"]);
		expect(result).toEqual([
			{ filePath: "src/a.ts", additions: 10, deletions: 2 },
			{ filePath: "README.md", additions: 5, deletions: 0 },
		]);
		provider.dispose();
	});

	test("uses startCommit..HEAD for completed-agent diffs", () => {
		execOutput = "1\t1\tsrc/b.ts\n";
		const provider = new AgentStatusTreeProvider();
		lastExecArgs = [];

		const result = provider.getPerFileDiffs("/tmp/project", "abc123", "HEAD");

		expect(lastExecArgs).toEqual([
			"-C",
			"/tmp/project",
			"diff",
			"--numstat",
			"abc123..HEAD",
		]);
		expect(result).toEqual([
			{ filePath: "src/b.ts", additions: 1, deletions: 1 },
		]);
		provider.dispose();
	});

	test("marks binary files with sentinel counts", () => {
		execOutput = "-\t-\tassets/logo.png\n";
		const provider = new AgentStatusTreeProvider();
		lastExecArgs = [];

		const result = provider.getPerFileDiffs("/tmp/project", "HEAD~1", "HEAD");

		expect(result).toEqual([
			{ filePath: "assets/logo.png", additions: -1, deletions: -1 },
		]);
		provider.dispose();
	});

	test("returns empty array when git fails", () => {
		execError = new Error("not a git repo");
		const provider = new AgentStatusTreeProvider();

		const result = provider.getPerFileDiffs("/tmp/not-a-repo");

		expect(result).toEqual([]);
		provider.dispose();
	});

	test("falls back to HEAD~1..HEAD when startCommit ref is stale", () => {
		const provider = new AgentStatusTreeProvider();
		mockExecFileSync.mockReset();
		let calls = 0;
		mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
			lastExecArgs = args;
			calls += 1;
			if (calls === 1) {
				throw new Error("bad revision");
			}
			return "3\t1\tsrc/fallback.ts\n";
		});
		const result = provider.getPerFileDiffs(
			"/tmp/project",
			"stale-commit",
			"HEAD",
		);

		expect(calls).toBe(2);
		expect(lastExecArgs).toEqual([
			"-C",
			"/tmp/project",
			"diff",
			"--numstat",
			"HEAD~1..HEAD",
		]);
		expect(result).toEqual([
			{ filePath: "src/fallback.ts", additions: 3, deletions: 1 },
		]);
		provider.dispose();
	});

	test("getDiffSummary uses start_sha so header matches per-file diff range", () => {
		execOutput = "10\t2\tsrc/a.ts\n5\t0\tREADME.md\n";
		const provider = new AgentStatusTreeProvider();
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
		provider.dispose();
	});
});
