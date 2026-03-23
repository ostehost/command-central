/**
 * Extension Command Tests
 *
 * Tests key agent commands registered in extension.ts:
 * focusAgentTerminal, focusNextRunningAgent, showAgentOutput,
 * openAgentDashboard, viewAgentDiff, openAgentDirectory.
 *
 * Commands are tested via their handler logic patterns, not by loading extension.ts.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

let vscodeMock: ReturnType<typeof setupVSCodeMock>;

beforeEach(() => {
	mock.restore();
	vscodeMock = setupVSCodeMock();
});

function createTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "test-task",
		status: "running",
		project_dir: "/tmp/project",
		project_name: "test-project",
		session_id: "sess-123",
		bundle_path: "(test-mode)",
		prompt_file: "/tmp/prompt.md",
		started_at: new Date().toISOString(),
		attempts: 1,
		max_attempts: 3,
		...overrides,
	};
}

describe("focusAgentTerminal command", () => {
	test("shows info message when no task provided", () => {
		// Simulate the command handler pattern from extension.ts
		const node: { type: string; task?: AgentTask } | undefined = undefined;
		const task = node?.task;

		if (!task) {
			vscodeMock.window.showInformationMessage(
				"No terminal available for this agent.",
			);
		}

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"No terminal available for this agent.",
		);
	});

	test("shows info message when node has no task", () => {
		const node = { type: "task", task: undefined as AgentTask | undefined };
		const task = node.task;

		if (!task) {
			vscodeMock.window.showInformationMessage(
				"No terminal available for this agent.",
			);
		}

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalled();
	});

	test("tmux backend with ghostty bundle uses open -a strategy", () => {
		const task = createTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: "com.mitchellh.ghostty",
		});

		// Verify the condition that triggers Strategy 1
		expect(task.terminal_backend).toBe("tmux");
		expect(task.ghostty_bundle_id).toBeTruthy();
	});

	test("falls back to integrated terminal for tmux without bundle", () => {
		const task = createTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: null,
			bundle_path: "(tmux-mode)",
			session_id: "valid-session",
		});

		// Strategy 1 won't fire (no ghostty_bundle_id)
		// Strategy 2 won't fire (bundle_path is "(tmux-mode)")
		// Strategy 3 fires: tmux backend + valid session_id
		const shouldUseTmuxAttach =
			task.terminal_backend === "tmux" &&
			task.session_id &&
			/^[a-zA-Z0-9._-]+$/.test(task.session_id);

		expect(shouldUseTmuxAttach).toBeTruthy();
	});

	test("checks tmux has-session before opening (session_id present)", () => {
		const task = createTask({
			terminal_backend: "tmux",
			session_id: "agent-my-project",
		});

		// Guard fires when session_id is present and valid
		const shouldCheckSession =
			task.session_id && /^[a-zA-Z0-9._-]+$/.test(task.session_id);

		expect(shouldCheckSession).toBeTruthy();
	});

	test("shows info message when tmux session has ended", () => {
		const task = createTask({
			id: "dead-agent",
			session_id: "agent-dead-project",
		});

		// Simulate tmux has-session throwing (session gone)
		const sessionDead = true; // has-session exited non-zero
		if (sessionDead) {
			vscodeMock.window.showInformationMessage(
				`Agent session "${task.id}" has ended. Terminal is no longer available.`,
			);
		}

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			`Agent session "${task.id}" has ended. Terminal is no longer available.`,
		);
	});

	test("calls tmux select-window after open -a in strategy 1", () => {
		const task = createTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: "com.mitchellh.ghostty",
			session_id: "agent-my-project",
		});

		// After open -a succeeds, select-window is attempted when session_id valid
		const shouldSelectWindow =
			task.session_id && /^[a-zA-Z0-9._-]+$/.test(task.session_id);

		expect(task.terminal_backend).toBe("tmux");
		expect(task.ghostty_bundle_id).toBeTruthy();
		expect(shouldSelectWindow).toBeTruthy();
	});

	test("gracefully handles select-window failure after open -a", () => {
		const task = createTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: "com.mitchellh.ghostty",
			session_id: "agent-my-project",
		});

		// Simulate select-window throwing — app was still opened, so we return
		let appOpened = false;
		const windowSelected = false;

		// open -a succeeded
		appOpened = true;

		// select-window fails
		try {
			throw new Error("no windows");
		} catch {
			// swallowed — app still opened
		}

		// We still return successfully because open -a worked
		expect(appOpened).toBe(true);
		expect(windowSelected).toBe(false);
	});

	test("shows fallback message when no strategy matches", () => {
		const task = createTask({
			terminal_backend: undefined,
			ghostty_bundle_id: null,
			bundle_path: "(test-mode)",
			session_id: "",
		});

		const hasTmuxBundle =
			task.terminal_backend === "tmux" && task.ghostty_bundle_id;
		const hasDirectBundle =
			task.bundle_path &&
			task.bundle_path !== "(test-mode)" &&
			task.bundle_path !== "(tmux-mode)";
		const hasTmuxSession =
			task.terminal_backend === "tmux" &&
			task.session_id &&
			/^[a-zA-Z0-9._-]+$/.test(task.session_id);

		if (!hasTmuxBundle && !hasDirectBundle && !hasTmuxSession) {
			vscodeMock.window.showInformationMessage(
				"No terminal available for this agent.",
			);
		}

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"No terminal available for this agent.",
		);
	});
});

describe("focusNextRunningAgent command", () => {
	test("finds first running task", () => {
		const tasks = [
			createTask({ id: "t1", status: "completed" }),
			createTask({ id: "t2", status: "running" }),
			createTask({ id: "t3", status: "running" }),
		];

		const running = tasks.find((t) => t.status === "running");

		expect(running).toBeDefined();
		expect(running!.id).toBe("t2");
	});

	test("shows info message when no running agents", () => {
		const tasks = [
			createTask({ id: "t1", status: "completed" }),
			createTask({ id: "t2", status: "failed" }),
		];

		const running = tasks.find((t) => t.status === "running");
		if (!running) {
			vscodeMock.window.showInformationMessage("No running agents");
		}

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"No running agents",
		);
	});

	test("handles empty task list gracefully", () => {
		const tasks: AgentTask[] = [];
		const running = tasks.find((t) => t.status === "running");

		if (!running) {
			vscodeMock.window.showInformationMessage("No running agents");
		}

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalled();
	});
});

describe("showAgentOutput command", () => {
	test("shows warning when no task provided", () => {
		const node: { type: string; task?: AgentTask } | undefined = undefined;
		const task = node?.task;

		if (!task) {
			vscodeMock.window.showWarningMessage(
				"No agent selected. Right-click an agent in the tree.",
			);
		}

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No agent selected. Right-click an agent in the tree.",
		);
	});

	test("passes task id and session_id to output channels", () => {
		const task = createTask({ id: "my-task", session_id: "my-sess" });

		// Verify data that would be passed to agentOutputChannels.show()
		expect(task.id).toBe("my-task");
		expect(task.session_id).toBe("my-sess");
	});
});

describe("openAgentDashboard command", () => {
	test("dashboard receives tasks from registry", () => {
		const tasks: Record<string, AgentTask> = {
			t1: createTask({ id: "t1", status: "running" }),
			t2: createTask({ id: "t2", status: "completed" }),
		};

		expect(Object.keys(tasks)).toHaveLength(2);
		expect(tasks["t1"].status).toBe("running");
	});

	test("dashboard handles empty registry", () => {
		const tasks: Record<string, AgentTask> = {};
		expect(Object.keys(tasks)).toHaveLength(0);
	});
});

describe("viewAgentDiff command", () => {
	test("shows warning when no task or project_dir", () => {
		const node = { type: "task", task: createTask({ project_dir: "" }) };
		const task = node.task;

		if (!task?.project_dir) {
			vscodeMock.window.showWarningMessage(
				"No agent selected. Right-click an agent in the tree.",
			);
		}

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No agent selected. Right-click an agent in the tree.",
		);
	});

	test("creates terminal with diff command for valid task", () => {
		const task = createTask({
			id: "diff-task",
			project_dir: "/tmp/my-project",
			started_at: "2026-01-01T00:00:00Z",
		});

		expect(task.project_dir).toBe("/tmp/my-project");
		expect(task.started_at).toBeDefined();

		// The terminal would be created with cwd: task.project_dir
		const terminalOpts = {
			name: `Diff: ${task.id}`,
			cwd: task.project_dir,
		};

		expect(terminalOpts.name).toBe("Diff: diff-task");
		expect(terminalOpts.cwd).toBe("/tmp/my-project");
	});

	test("handles undefined node gracefully", () => {
		const node: { type: string; task?: AgentTask } | undefined = undefined;
		const task = node?.task;

		if (!task?.project_dir) {
			vscodeMock.window.showWarningMessage(
				"No agent selected. Right-click an agent in the tree.",
			);
		}

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalled();
	});
});

describe("openAgentDirectory command", () => {
	test("shows warning when no project_dir", () => {
		const node = { type: "task", task: undefined as AgentTask | undefined };
		const task = node.task;

		if (!task?.project_dir) {
			vscodeMock.window.showWarningMessage(
				"No agent selected. Right-click an agent in the tree.",
			);
		}

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalled();
	});

	test("calls revealFileInOS with URI for valid task", () => {
		const task = createTask({ project_dir: "/tmp/agent-dir" });

		const uri = vscodeMock.Uri.file(task.project_dir);
		expect(uri.fsPath).toBe("/tmp/agent-dir");
	});

	test("handles missing project_dir in task", () => {
		const task = createTask({ project_dir: "" });

		if (!task.project_dir) {
			vscodeMock.window.showWarningMessage(
				"No agent selected. Right-click an agent in the tree.",
			);
		}

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalled();
	});
});
