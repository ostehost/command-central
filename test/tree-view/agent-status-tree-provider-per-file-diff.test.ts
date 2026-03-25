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

import { AgentStatusTreeProvider } from "../../src/providers/agent-status-tree-provider.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("AgentStatusTreeProvider.getPerFileDiffs", () => {
	beforeEach(() => {
		setupVSCodeMock();
		execOutput = "";
		execError = null;
		lastExecArgs = [];
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

		const result = provider.getPerFileDiffs("/tmp/project", "abc123");

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

		const result = provider.getPerFileDiffs("/tmp/project", "HEAD~1");

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
});
