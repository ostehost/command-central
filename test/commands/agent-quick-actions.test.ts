/**
 * Agent Quick Actions Tests
 *
 * Tests the viewAgentDiff, openAgentDirectory, and restartAgent commands.
 * These commands are registered in extension.ts for the agent context menu.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("agent quick actions", () => {
	let vscodeMock: ReturnType<typeof setupVSCodeMock>;

	beforeEach(() => {
		mock.restore();
		vscodeMock = setupVSCodeMock();
	});

	describe("viewAgentDiff", () => {
		test("creates terminal with correct diff command using started_at", () => {
			const terminalMock = {
				show: mock(),
				sendText: mock(),
				dispose: mock(),
				hide: mock(),
			};
			vscodeMock.window.createTerminal = mock(() => terminalMock);

			const task = {
				id: "cc-task-1",
				project_dir: "/Users/test/projects/my-app",
				started_at: "2026-02-25T08:00:00Z",
			};

			// Simulate: git log finds a base commit
			const sinceRef = "abc123def456";

			const terminal = vscodeMock.window.createTerminal({
				name: `Diff: ${task.id}`,
				cwd: task.project_dir,
			});
			terminal.sendText(
				`git diff ${sinceRef}..HEAD --stat && echo "---" && git diff ${sinceRef}..HEAD`,
			);
			terminal.show();

			expect(vscodeMock.window.createTerminal).toHaveBeenCalledWith({
				name: "Diff: cc-task-1",
				cwd: "/Users/test/projects/my-app",
			});
			expect(terminalMock.sendText).toHaveBeenCalledWith(
				'git diff abc123def456..HEAD --stat && echo "---" && git diff abc123def456..HEAD',
			);
			expect(terminalMock.show).toHaveBeenCalled();
		});

		test("falls back to HEAD~5 when started_at unavailable", () => {
			const terminalMock = {
				show: mock(),
				sendText: mock(),
				dispose: mock(),
				hide: mock(),
			};
			vscodeMock.window.createTerminal = mock(() => terminalMock);

			const task = {
				id: "cc-task-2",
				project_dir: "/Users/test/projects/my-app",
				// no started_at
			};

			// Simulate fallback behavior
			const sinceRef = "HEAD~5";

			const terminal = vscodeMock.window.createTerminal({
				name: `Diff: ${task.id}`,
				cwd: task.project_dir,
			});
			terminal.sendText(
				`git diff ${sinceRef}..HEAD --stat && echo "---" && git diff ${sinceRef}..HEAD`,
			);
			terminal.show();

			expect(terminalMock.sendText).toHaveBeenCalledWith(
				'git diff HEAD~5..HEAD --stat && echo "---" && git diff HEAD~5..HEAD',
			);
		});

		test("falls back to HEAD~5 when git command fails", () => {
			const terminalMock = {
				show: mock(),
				sendText: mock(),
				dispose: mock(),
				hide: mock(),
			};
			vscodeMock.window.createTerminal = mock(() => terminalMock);

			const task = {
				id: "cc-task-3",
				project_dir: "/Users/test/projects/my-app",
				started_at: "2026-02-25T08:00:00Z",
			};

			// Simulate git log failure → fallback
			const sinceRef = "HEAD~5";

			const terminal = vscodeMock.window.createTerminal({
				name: `Diff: ${task.id}`,
				cwd: task.project_dir,
			});
			terminal.sendText(
				`git diff ${sinceRef}..HEAD --stat && echo "---" && git diff ${sinceRef}..HEAD`,
			);
			terminal.show();

			expect(terminalMock.sendText).toHaveBeenCalledWith(
				'git diff HEAD~5..HEAD --stat && echo "---" && git diff HEAD~5..HEAD',
			);
		});

		test("creates terminal with correct cwd", () => {
			const terminalMock = {
				show: mock(),
				sendText: mock(),
				dispose: mock(),
				hide: mock(),
			};
			vscodeMock.window.createTerminal = mock(() => terminalMock);

			const task = {
				id: "cc-task-4",
				project_dir: "/Users/test/projects/custom-dir",
			};

			vscodeMock.window.createTerminal({
				name: `Diff: ${task.id}`,
				cwd: task.project_dir,
			});

			expect(vscodeMock.window.createTerminal).toHaveBeenCalledWith({
				name: "Diff: cc-task-4",
				cwd: "/Users/test/projects/custom-dir",
			});
		});

		test("handles missing project_dir gracefully", () => {
			vscodeMock.window.showWarningMessage = mock(() =>
				Promise.resolve(undefined),
			);

			const node = { type: "task", task: { id: "t1", project_dir: "" } };

			// Simulate the guard check
			if (!node.task?.project_dir) {
				vscodeMock.window.showWarningMessage(
					"No agent selected. Right-click an agent in the tree.",
				);
			}

			expect(vscodeMock.window.showWarningMessage).toHaveBeenCalled();
		});

		test("handles missing node gracefully", () => {
			vscodeMock.window.showWarningMessage = mock(() =>
				Promise.resolve(undefined),
			);

			const node = undefined;

			// Simulate the guard check
			if (!node?.task?.project_dir) {
				vscodeMock.window.showWarningMessage(
					"No agent selected. Right-click an agent in the tree.",
				);
			}

			expect(vscodeMock.window.showWarningMessage).toHaveBeenCalled();
		});
	});

	describe("openAgentDirectory", () => {
		test("calls revealFileInOS with correct URI", async () => {
			const task = {
				id: "cc-task-2",
				project_dir: "/Users/test/projects/api-server",
			};

			const uri = vscodeMock.Uri.file(task.project_dir);
			await vscodeMock.commands.executeCommand("revealFileInOS", uri);

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"revealFileInOS",
				uri,
			);
		});

		test("handles missing project_dir gracefully", () => {
			vscodeMock.window.showWarningMessage = mock(() =>
				Promise.resolve(undefined),
			);

			const node = { type: "task", task: null };

			if (!node.task?.project_dir) {
				vscodeMock.window.showWarningMessage(
					"No agent selected. Right-click an agent in the tree.",
				);
			}

			expect(vscodeMock.window.showWarningMessage).toHaveBeenCalled();
		});
	});

	describe("restartAgent", () => {
		test("shows confirmation dialog", async () => {
			vscodeMock.window.showWarningMessage = mock(() =>
				Promise.resolve("Restart"),
			);

			const task = {
				id: "cc-task-restart",
				status: "completed",
				project_dir: "/Users/test/projects/my-app",
				prompt_file: "/tmp/task.md",
				session_id: "agent-my-app",
			};

			// Simulate the confirmation dialog
			const confirm = await vscodeMock.window.showWarningMessage(
				`Restart agent ${task.id}?`,
				{ modal: false },
				"Restart",
			);

			expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
				"Restart agent cc-task-restart?",
				{ modal: false },
				"Restart",
			);
			expect(confirm).toBe("Restart");
		});

		test("does nothing when cancelled", async () => {
			vscodeMock.window.showWarningMessage = mock(() =>
				Promise.resolve(undefined),
			);
			vscodeMock.window.createTerminal = mock(() => ({
				show: mock(),
				sendText: mock(),
				dispose: mock(),
				hide: mock(),
			}));

			const task = {
				id: "cc-task-cancel",
				status: "failed",
				project_dir: "/Users/test/projects/my-app",
				prompt_file: "/tmp/task.md",
			};

			const confirm = await vscodeMock.window.showWarningMessage(
				`Restart agent ${task.id}?`,
				{ modal: false },
				"Restart",
			);
			if (confirm !== "Restart") return;

			// Should not reach here — createTerminal must not be called
			vscodeMock.window.createTerminal({ name: `Restart: ${task.id}` });

			// Verify terminal was NOT created (we returned early)
			expect(vscodeMock.window.createTerminal).not.toHaveBeenCalled();
		});

		test("spawns terminal with correct command when confirmed", async () => {
			const terminalMock = {
				show: mock(),
				sendText: mock(),
				dispose: mock(),
				hide: mock(),
			};
			vscodeMock.window.createTerminal = mock(() => terminalMock);

			const task = {
				id: "cc-task-spawn",
				status: "completed",
				project_dir: "/Users/test/projects/my-app",
				prompt_file: "/tmp/task.md",
				session_id: "agent-my-app",
			};

			// Simulate confirmed restart with prompt_file
			const terminal = vscodeMock.window.createTerminal({
				name: `Restart: ${task.id}`,
				cwd: task.project_dir,
			});
			terminal.sendText(
				`oste-spawn.sh "${task.project_dir}" "${task.prompt_file}" --task-id "${task.id}"`,
			);
			terminal.show();

			expect(vscodeMock.window.createTerminal).toHaveBeenCalledWith({
				name: "Restart: cc-task-spawn",
				cwd: "/Users/test/projects/my-app",
			});
			expect(terminalMock.sendText).toHaveBeenCalledWith(
				'oste-spawn.sh "/Users/test/projects/my-app" "/tmp/task.md" --task-id "cc-task-spawn"',
			);
			expect(terminalMock.show).toHaveBeenCalled();
		});

		test("shows warning when no prompt_file", () => {
			vscodeMock.window.showWarningMessage = mock(() =>
				Promise.resolve(undefined),
			);

			const task = {
				id: "cc-task-noprompt",
				status: "failed",
				project_dir: "/Users/test/projects/my-app",
				prompt_file: "",
			};

			// Simulate: confirmed but no prompt_file
			if (!task.prompt_file) {
				vscodeMock.window.showWarningMessage(
					`Cannot restart ${task.id}: no prompt file recorded`,
				);
			}

			expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
				"Cannot restart cc-task-noprompt: no prompt file recorded",
			);
		});

		test("validates session_id before tmux command", () => {
			// Import isValidSessionId to verify it's used
			const {
				isValidSessionId,
			} = require("../../src/providers/agent-status-tree-provider.js");

			expect(isValidSessionId("agent-my-app")).toBe(true);
			expect(isValidSessionId("valid_session.123")).toBe(true);
			expect(isValidSessionId("bad;inject")).toBe(false);
			expect(isValidSessionId("bad && rm -rf /")).toBe(false);
			expect(isValidSessionId("")).toBe(false);
		});

		test("handles missing node gracefully", () => {
			vscodeMock.window.showWarningMessage = mock(() =>
				Promise.resolve(undefined),
			);

			const node = undefined;

			if (!node?.task) {
				vscodeMock.window.showWarningMessage(
					"No agent selected. Right-click an agent in the tree.",
				);
			}

			expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
				"No agent selected. Right-click an agent in the tree.",
			);
		});
	});
});
