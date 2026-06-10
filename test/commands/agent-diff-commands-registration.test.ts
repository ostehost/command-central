/**
 * Registration-shape test for the agent diff activation module.
 *
 * Encodes the extraction contract for
 * src/activation/register-agent-diff-commands.ts: the exact command-ID set
 * (each contributed in package.json), one disposable per command, and
 * real-handler behavior against real temp git repositories — viewAgentDiff's
 * numstat → openFileDiff routing, smartOpenFile's deleted-file fallback, and
 * openFileDiff's two-ref virtual diff (binary detection, added/deleted hints,
 * bounded-diff guard) all run the actual git plumbing rather than
 * re-simulating it. The exported pure helpers (classifyFileContent,
 * readWorkingTreeFile, readFileAtRef) are covered directly. Supersedes the
 * former viewAgentDiff / openFileDiff simulation blocks in
 * extension-commands.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../../package.json";
import { createVSCodeMock } from "../helpers/vscode-mock.js";

const vscodeMock = createVSCodeMock();
mock.module("vscode", () => vscodeMock);

// Earlier suites in a mixed run install process-global
// mock.module("node:child_process") / ("node:fs") overrides that survive
// mock.restore(). These tests run real git plumbing against real temp repos,
// so re-pin the preload-stashed real modules before every test (see
// test/setup/global-test-cleanup.ts).
const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");
const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof import("node:fs");

beforeEach(() => {
	mock.module("node:child_process", () => realChildProcess);
	mock.module("node:fs", () => realFs);
});

const {
	classifyFileContent,
	readFileAtRef,
	readWorkingTreeFile,
	registerAgentDiffCommands,
} = await import("../../src/activation/register-agent-diff-commands.js");

const EXPECTED_COMMAND_IDS = [
	"commandCentral.viewAgentDiff",
	"commandCentral.smartOpenFile",
	"commandCentral.openFileDiff",
];

const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
};

describe("registerAgentDiffCommands", () => {
	let registered: Map<string, (...args: unknown[]) => unknown>;
	let tmpDirs: string[];

	beforeEach(() => {
		registered = new Map();
		vscodeMock.commands.registerCommand = mock(
			(id: string, handler: (...args: unknown[]) => unknown) => {
				registered.set(id, handler);
				return { dispose: mock() };
			},
		);
		vscodeMock.commands.executeCommand = mock((..._args: unknown[]) =>
			Promise.resolve(),
		);
		vscodeMock.window.showErrorMessage = mock();
		vscodeMock.window.showWarningMessage = mock(() =>
			Promise.resolve(undefined),
		);
		vscodeMock.window.showInformationMessage = mock(() =>
			Promise.resolve(undefined),
		);
		vscodeMock.window.showQuickPick = mock(() => Promise.resolve(undefined));
		tmpDirs = [];
	});

	afterEach(() => {
		for (const dir of tmpDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function handler(id: string): (...args: unknown[]) => unknown {
		const h = registered.get(id);
		if (!h) throw new Error(`Command not registered: ${id}`);
		return h;
	}

	function makeTmpDir(): string {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "agent-diff-commands-test-"),
		);
		tmpDirs.push(dir);
		return dir;
	}

	function makeGitRepo(): string {
		const dir = makeTmpDir();
		execFileSync("git", ["init", "-q", "-b", "main"], {
			cwd: dir,
			env: GIT_ENV,
		});
		return dir;
	}

	function commitAll(dir: string, message: string, date?: string): string {
		const env = date
			? { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
			: GIT_ENV;
		execFileSync("git", ["-C", dir, "add", "-A"], { env });
		execFileSync(
			"git",
			[
				"-C",
				dir,
				"-c",
				"user.email=test@test.invalid",
				"-c",
				"user.name=test",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				message,
			],
			{ env },
		);
		return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
			encoding: "utf-8",
			env,
		}).trim();
	}

	test("registers exactly the agent diff command IDs, in order, one disposable each", () => {
		const disposables = registerAgentDiffCommands();

		expect([...registered.keys()]).toEqual(EXPECTED_COMMAND_IDS);
		expect(disposables).toHaveLength(EXPECTED_COMMAND_IDS.length);
		for (const disposable of disposables) {
			expect(typeof disposable.dispose).toBe("function");
		}
	});

	test("every registered command is contributed in package.json", () => {
		registerAgentDiffCommands();

		const contributed = packageJson.contributes.commands.map(
			(c: { command: string }) => c.command,
		);
		for (const id of registered.keys()) {
			expect(contributed).toContain(id);
		}
	});

	describe("pure file-read helpers", () => {
		test("classifyFileContent decodes text and flags NUL bytes as binary", () => {
			expect(classifyFileContent("hello")).toEqual({
				kind: "text",
				content: "hello",
			});
			expect(classifyFileContent(Buffer.from("hello"))).toEqual({
				kind: "text",
				content: "hello",
			});
			expect(classifyFileContent(Buffer.from([0x68, 0x00, 0x69]))).toEqual({
				kind: "binary",
			});
		});

		test("readWorkingTreeFile reads text, flags binary, and reports missing files", async () => {
			const dir = makeTmpDir();
			const textPath = path.join(dir, "text.txt");
			fs.writeFileSync(textPath, "working tree content");
			const binaryPath = path.join(dir, "blob.bin");
			fs.writeFileSync(binaryPath, Buffer.from([0x00, 0x01]));

			expect(await readWorkingTreeFile(textPath)).toEqual({
				kind: "text",
				content: "working tree content",
			});
			expect(await readWorkingTreeFile(binaryPath)).toEqual({
				kind: "binary",
			});
			expect(await readWorkingTreeFile(path.join(dir, "missing.txt"))).toEqual({
				kind: "missing",
			});
		});

		test("readFileAtRef reads committed content and reports missing refs/paths", async () => {
			const repo = makeGitRepo();
			fs.writeFileSync(path.join(repo, "f.txt"), "committed content");
			const sha = commitAll(repo, "add f.txt");

			expect(await readFileAtRef(repo, sha, "f.txt")).toEqual({
				kind: "text",
				content: "committed content",
			});
			expect(await readFileAtRef(repo, sha, "missing.txt")).toEqual({
				kind: "missing",
			});
			expect(await readFileAtRef(repo, "not-a-ref", "f.txt")).toEqual({
				kind: "missing",
			});
		});
	});

	describe("viewAgentDiff", () => {
		test("warns when no node is provided", async () => {
			registerAgentDiffCommands();

			await handler("commandCentral.viewAgentDiff")();

			expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
				"No agent selected. Right-click an agent in the tree.",
			);
		});

		test("warns when the task has no project directory", async () => {
			registerAgentDiffCommands();

			await handler("commandCentral.viewAgentDiff")({
				type: "task",
				task: { id: "t1", project_dir: "" },
			});

			expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
				"No agent selected. Right-click an agent in the tree.",
			);
		});

		test("reports no changes for a clean discovered-agent working tree", async () => {
			registerAgentDiffCommands();
			const repo = makeGitRepo();
			fs.writeFileSync(path.join(repo, "f.txt"), "content\n");
			commitAll(repo, "init");

			await handler("commandCentral.viewAgentDiff")({
				type: "discovered",
				agent: { pid: 1234, projectDir: repo },
			});

			expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
				"No changes found for this agent.",
			);
			expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
		});

		test("routes a single changed file straight to openFileDiff with real numstat counts", async () => {
			registerAgentDiffCommands();
			const repo = makeGitRepo();
			fs.writeFileSync(path.join(repo, "f.txt"), "one\ntwo\n");
			commitAll(repo, "init");
			fs.writeFileSync(path.join(repo, "f.txt"), "one\nchanged\nadded\n");

			await handler("commandCentral.viewAgentDiff")({
				type: "discovered",
				agent: { pid: 1234, projectDir: repo },
			});

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"commandCentral.openFileDiff",
				{
					projectDir: repo,
					filePath: "f.txt",
					startCommit: "HEAD",
					endCommit: undefined,
					taskStatus: "completed",
					additions: 2,
					deletions: 1,
				},
			);
		});

		test("offers a quick pick when a launcher task changed multiple files", async () => {
			registerAgentDiffCommands();
			const repo = makeGitRepo();
			fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
			fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
			// Pin commit dates so the handler's `git log --before=started_at`
			// resolves sinceRef to the start commit, exercising the real
			// started_at → commit lookup instead of the HEAD~5 fallback.
			const startSha = commitAll(repo, "init", "2020-01-01T00:00:00Z");
			fs.writeFileSync(path.join(repo, "a.txt"), "a changed\n");
			fs.writeFileSync(path.join(repo, "b.txt"), "b changed\n");
			const endSha = commitAll(repo, "change both", "2022-01-01T00:00:00Z");
			let capturedItems: Array<{ filePath: string }> | undefined;
			vscodeMock.window.showQuickPick = mock((items: unknown) => {
				capturedItems = items as typeof capturedItems;
				return Promise.resolve(undefined);
			}) as typeof vscodeMock.window.showQuickPick;

			await handler("commandCentral.viewAgentDiff")({
				type: "task",
				task: {
					id: "task-1",
					project_dir: repo,
					status: "completed",
					started_at: "2021-01-01T00:00:00Z",
					start_sha: startSha,
					end_commit: endSha,
				},
			});

			expect(capturedItems?.map((i) => i.filePath)).toEqual(["a.txt", "b.txt"]);
			// Picker dismissed → no diff opened.
			expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
		});
	});

	describe("smartOpenFile", () => {
		test("warns when no file change is selected", async () => {
			registerAgentDiffCommands();

			await handler("commandCentral.smartOpenFile")();

			expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
				"No file change selected.",
			);
		});

		test("opens an existing file on disk", async () => {
			registerAgentDiffCommands();
			const dir = makeTmpDir();
			fs.writeFileSync(path.join(dir, "exists.txt"), "content");

			await handler("commandCentral.smartOpenFile")({
				projectDir: dir,
				filePath: "exists.txt",
			});

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"vscode.open",
				expect.objectContaining({ fsPath: path.join(dir, "exists.txt") }),
			);
		});

		test("falls back to openFileDiff for deleted files", async () => {
			registerAgentDiffCommands();
			const dir = makeTmpDir();
			const node = { projectDir: dir, filePath: "deleted.txt" };

			await handler("commandCentral.smartOpenFile")(node);

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"commandCentral.openFileDiff",
				node,
			);
		});
	});

	describe("openFileDiff", () => {
		test("warns when no file change is selected", async () => {
			registerAgentDiffCommands();

			await handler("commandCentral.openFileDiff")({ projectDir: "/tmp" });

			expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
				"No file change selected.",
			);
		});

		test("does not fall back to HEAD for terminal tasks without an end commit", async () => {
			registerAgentDiffCommands();

			await handler("commandCentral.openFileDiff")({
				projectDir: "/tmp/project",
				filePath: "src/app.ts",
				taskStatus: "completed",
				startCommit: "abc123",
			});

			expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
				"No bounded diff is available for this task.",
			);
			expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
		});

		test("binary numstat falls back to a message when the file is gone", async () => {
			registerAgentDiffCommands();
			const dir = makeTmpDir();

			await handler("commandCentral.openFileDiff")({
				projectDir: dir,
				filePath: "logo.png",
				taskStatus: "completed",
				startCommit: "abc123",
				endCommit: "def456",
				additions: -1,
				deletions: -1,
			});

			expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
				"Binary file detected — no text diff is available.",
			);
		});

		test("binary numstat opens the on-disk file directly when present", async () => {
			registerAgentDiffCommands();
			const dir = makeTmpDir();
			fs.writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x00, 0x01]));

			await handler("commandCentral.openFileDiff")({
				projectDir: dir,
				filePath: "logo.png",
				taskStatus: "completed",
				startCommit: "abc123",
				endCommit: "def456",
				additions: -1,
				deletions: -1,
			});

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"vscode.open",
				expect.objectContaining({ fsPath: path.join(dir, "logo.png") }),
			);
			expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
				"Binary file detected — opened file directly.",
			);
		});

		test("opens a two-ref virtual diff for a real committed change", async () => {
			registerAgentDiffCommands();
			const repo = makeGitRepo();
			fs.writeFileSync(path.join(repo, "f.txt"), "before\n");
			const startSha = commitAll(repo, "before");
			fs.writeFileSync(path.join(repo, "f.txt"), "after\n");
			const endSha = commitAll(repo, "after");

			await handler("commandCentral.openFileDiff")({
				projectDir: repo,
				projectName: "my-project",
				filePath: "f.txt",
				taskId: "task-1",
				taskStatus: "completed",
				startCommit: startSha,
				endCommit: endSha,
			});

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"vscode.diff",
				expect.anything(),
				expect.anything(),
				`f.txt (${startSha} ↔ ${endSha}) — my-project`,
			);
			expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
		});

		test("labels a file added between the two refs", async () => {
			registerAgentDiffCommands();
			const repo = makeGitRepo();
			const startSha = commitAll(repo, "empty start");
			fs.writeFileSync(path.join(repo, "new.txt"), "fresh\n");
			const endSha = commitAll(repo, "add new.txt");

			await handler("commandCentral.openFileDiff")({
				projectDir: repo,
				projectName: "my-project",
				filePath: "new.txt",
				taskId: "task-1",
				taskStatus: "completed",
				startCommit: startSha,
				endCommit: endSha,
			});

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"vscode.diff",
				expect.anything(),
				expect.anything(),
				`new.txt (${startSha} ↔ ${endSha} · added) — my-project`,
			);
		});

		test("reports when the file exists in neither revision", async () => {
			registerAgentDiffCommands();
			const repo = makeGitRepo();
			const sha = commitAll(repo, "empty");

			await handler("commandCentral.openFileDiff")({
				projectDir: repo,
				filePath: "ghost.txt",
				taskStatus: "completed",
				startCommit: sha,
				endCommit: sha,
			});

			expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
				"File does not exist in the selected revisions.",
			);
			expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
		});

		test("diffs the working tree against HEAD for running tasks", async () => {
			registerAgentDiffCommands();
			const repo = makeGitRepo();
			fs.writeFileSync(path.join(repo, "f.txt"), "committed\n");
			commitAll(repo, "init");
			fs.writeFileSync(path.join(repo, "f.txt"), "working tree edit\n");

			await handler("commandCentral.openFileDiff")({
				projectDir: repo,
				projectName: "my-project",
				filePath: "f.txt",
				taskId: "task-1",
				taskStatus: "running",
			});

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"vscode.diff",
				expect.anything(),
				expect.anything(),
				"f.txt (HEAD ↔ Working Tree) — my-project",
			);
		});
	});
});
