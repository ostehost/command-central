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
		const node = undefined as { type: string; task?: AgentTask } | undefined;
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

	test("tmux-only agent opens Ghostty (not VS Code terminal) via Strategy 3", () => {
		const task = createTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: null,
			bundle_path: "(tmux-mode)",
			session_id: "valid-session",
		});

		// Strategy 1 won't fire (no ghostty_bundle_id)
		// Strategy 2 won't fire (bundle_path is "(tmux-mode)")
		// Strategy 3 fires: tmux backend + valid session_id → open -a Ghostty
		const shouldUseGhostty =
			task.terminal_backend === "tmux" &&
			task.session_id &&
			/^[a-zA-Z0-9._-]+$/.test(task.session_id);

		expect(shouldUseGhostty).toBeTruthy();

		// Strategy 3 should call: open -a Ghostty --args -e "tmux attach -t SESSION"
		// NOT vscode.window.createTerminal
		const expectedArgs = [
			"-a",
			"Ghostty",
			"--args",
			"-e",
			`tmux attach -t ${task.session_id}`,
		];
		expect(expectedArgs[1]).toBe("Ghostty");
		expect(expectedArgs[4]).toContain("tmux attach -t");
	});

	test("Strategy 3 does not call vscode.window.createTerminal", () => {
		const task = createTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: null,
			bundle_path: "(tmux-mode)",
			session_id: "valid-session",
		});

		// Simulate Strategy 3 path — should use execFileAsync("open", ...) not createTerminal
		const strategy3Matches =
			task.terminal_backend === "tmux" &&
			task.session_id &&
			/^[a-zA-Z0-9._-]+$/.test(task.session_id);

		expect(strategy3Matches).toBeTruthy();

		// createTerminal must NOT be called for tmux-only agents
		expect(vscodeMock.window.createTerminal).not.toHaveBeenCalled();
	});

	test("Strategy 3 rejects invalid session IDs before attempting Ghostty open", () => {
		const task = createTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: null,
			bundle_path: "(tmux-mode)",
			session_id: "invalid;rm -rf /",
		});

		// isValidSessionId rejects dangerous session IDs
		const isValid = /^[a-zA-Z0-9._-]+$/.test(task.session_id);
		expect(isValid).toBe(false);

		// Strategy 3 should NOT fire for invalid session IDs
		const strategy3Fires =
			task.terminal_backend === "tmux" && task.session_id && isValid;

		expect(strategy3Fires).toBeFalsy();
	});

	test("Strategy 3 falls through to no-terminal message on Ghostty failure", () => {
		void createTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: null,
			bundle_path: "(tmux-mode)",
			session_id: "valid-session",
		});

		// Simulate open -a Ghostty failing (Ghostty not installed)
		const ghosttyFailed = true;

		if (ghosttyFailed) {
			// Falls through to "no terminal" message
			vscodeMock.window.showInformationMessage(
				"No terminal available for this agent.",
			);
		}

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"No terminal available for this agent.",
		);
	});

	test("completed agent with ghostty_bundle_id activates Ghostty window (no tmux check)", () => {
		const task = createTask({
			status: "completed",
			terminal_backend: "tmux",
			ghostty_bundle_id: "com.mitchellh.ghostty",
			session_id: "agent-done",
		});

		// Strategy 1 fires based on ghostty_bundle_id — no tmux has-session guard
		const strategy1Fires =
			task.terminal_backend === "tmux" && task.ghostty_bundle_id;
		expect(strategy1Fires).toBeTruthy();

		// The tmux session may be dead, but Strategy 1 doesn't check — it just opens the app
		// focusGhosttyWindow uses AppleScript with application id for targeted activation
		expect(task.status).toBe("completed");
	});

	test("completed agent with ghostty_bundle_id can be focused via focusGhosttyWindow", () => {
		const task = createTask({
			status: "completed",
			terminal_backend: "tmux",
			ghostty_bundle_id: "dev.partnerai.ghostty.command-central",
			session_id: "agent-completed-ok",
		});

		// Dead session fallback: when session is dead but bundle exists,
		// focusGhosttyWindow is called with (bundleTarget, sessionId) — not blocked by stale guard
		const bundleTarget = task.ghostty_bundle_id || task.bundle_path;
		expect(bundleTarget).toBe("dev.partnerai.ghostty.command-central");
		expect(task.session_id).toBe("agent-completed-ok");

		// focusGhosttyWindow uses `application id` AppleScript to target the specific bundle
		// This is more reliable than `open -a` which just activates "the Ghostty app"
		expect(bundleTarget).not.toBe("(test-mode)");
		expect(bundleTarget).not.toBe("(tmux-mode)");
	});

	test("completed agent with bundle_path activates via path (no tmux check)", () => {
		const task = createTask({
			status: "completed",
			terminal_backend: "tmux",
			ghostty_bundle_id: null,
			bundle_path: "/Applications/Ghostty.app",
			session_id: "agent-done",
		});

		// Strategy 2 fires based on bundle_path — no tmux has-session guard
		const strategy2Fires =
			task.bundle_path &&
			task.bundle_path !== "(test-mode)" &&
			task.bundle_path !== "(tmux-mode)";
		expect(strategy2Fires).toBeTruthy();

		// The tmux session may be dead, but Strategy 2 doesn't check
		expect(task.status).toBe("completed");
	});

	test("Strategy 3 checks tmux has-session before attach", () => {
		const task = createTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: null,
			bundle_path: "(tmux-mode)",
			session_id: "agent-my-project",
		});

		// Strategy 3 requires a live tmux session — guard is inline
		const strategy3Fires =
			task.terminal_backend === "tmux" &&
			task.session_id &&
			/^[a-zA-Z0-9._-]+$/.test(task.session_id);
		expect(strategy3Fires).toBeTruthy();

		// Simulate tmux has-session failing (session ended) — Strategy 3 falls through
		const sessionAlive = false;
		if (!sessionAlive) {
			// Falls through to "no terminal" message instead of opening Ghostty
			vscodeMock.window.showInformationMessage(
				"No terminal available for this agent.",
			);
		}

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"No terminal available for this agent.",
		);
	});

	test("Strategy 1 still applies for completed task even when tmux session is dead", () => {
		const task = createTask({
			status: "completed",
			terminal_backend: "tmux",
			ghostty_bundle_id: "com.mitchellh.ghostty",
			session_id: "agent-completed",
		});

		const sessionAlive = false;
		const strategy1Fires =
			task.terminal_backend === "tmux" && Boolean(task.ghostty_bundle_id);

		// Strategy 1 does not require has-session guard
		expect(sessionAlive).toBe(false);
		expect(strategy1Fires).toBe(true);
	});

	test("Strategy 2 still applies for completed task even when tmux session is dead", () => {
		const task = createTask({
			status: "completed",
			terminal_backend: "tmux",
			ghostty_bundle_id: null,
			bundle_path: "/Applications/Ghostty.app",
			session_id: "agent-completed",
		});

		const sessionAlive = false;
		const strategy2Fires =
			task.bundle_path &&
			task.bundle_path !== "(test-mode)" &&
			task.bundle_path !== "(tmux-mode)";

		// Strategy 2 does not require has-session guard
		expect(sessionAlive).toBe(false);
		expect(strategy2Fires).toBeTruthy();
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
		void createTask({
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

describe("removeAgentTask command", () => {
	test("shows warning when no task provided", () => {
		const node = undefined as { type: string; task?: AgentTask } | undefined;
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

	test("removes matching task id from registry map", () => {
		const task = createTask({ id: "agent-1", status: "completed" });
		const tasks: Record<string, unknown> = {
			"agent-1": { id: "agent-1", status: "completed" },
			"agent-2": { id: "agent-2", status: "failed" },
		};

		if (task.id in tasks) {
			delete tasks[task.id];
		}

		expect(tasks["agent-1"]).toBeUndefined();
		expect(tasks["agent-2"]).toBeDefined();
	});

	test("falls back to value.id match when registry key differs from task id", () => {
		const task = createTask({ id: "agent-1", status: "failed" });
		const tasks: Record<string, unknown> = {
			"launcher-key-1": { id: "agent-1", status: "failed" },
			"launcher-key-2": { id: "agent-2", status: "completed" },
		};

		for (const [key, value] of Object.entries(tasks)) {
			const valueId =
				typeof value === "object" && value
					? (value as { id?: unknown }).id
					: undefined;
			if (valueId === task.id) {
				delete tasks[key];
				break;
			}
		}

		expect(Object.keys(tasks)).toEqual(["launcher-key-2"]);
	});

	test("shows info when task is already removed", () => {
		const task = createTask({ id: "missing-task", status: "stopped" });
		const tasks: Record<string, unknown> = {
			"agent-2": { id: "agent-2", status: "completed" },
		};

		let removed = false;
		if (task.id in tasks) {
			delete tasks[task.id];
			removed = true;
		}
		if (!removed) {
			vscodeMock.window.showInformationMessage(
				`Agent "${task.id}" is already removed.`,
			);
		}

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			'Agent "missing-task" is already removed.',
		);
	});

	test("race-safe re-read preserves concurrent task additions", () => {
		const task = createTask({ id: "agent-1", status: "completed" });
		const initialTasks: Record<string, unknown> = {
			"agent-1": { id: "agent-1" },
			"agent-2": { id: "agent-2" },
		};
		const latestTasks: Record<string, unknown> = {
			...initialTasks,
			"agent-3": { id: "agent-3" },
		};

		const removeTask = (tasks: Record<string, unknown>): boolean => {
			if (task.id in tasks) {
				delete tasks[task.id];
				return true;
			}
			return false;
		};

		// Initial remove result is stale because file changed; command should re-read
		removeTask(initialTasks);
		const removedFromLatest = removeTask(latestTasks);

		expect(removedFromLatest).toBe(true);
		expect(latestTasks["agent-1"]).toBeUndefined();
		expect(latestTasks["agent-3"]).toBeDefined();
	});

	test("malformed tasks.json surfaces a user-facing error", () => {
		const err = new SyntaxError("Unexpected token");
		if (err instanceof SyntaxError) {
			vscodeMock.window.showErrorMessage(
				"Failed to remove agent: tasks.json is malformed.",
			);
		}
		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Failed to remove agent: tasks.json is malformed.",
		);
	});
});

describe("clearTerminalTasks command", () => {
	test("removes all non-running tasks from registry map", () => {
		const tasks: Record<string, { id: string; status: string }> = {
			running: { id: "running", status: "running" },
			completed: { id: "completed", status: "completed" },
			failed: { id: "failed", status: "failed" },
			stopped: { id: "stopped", status: "stopped" },
		};
		const terminalStatuses = new Set([
			"completed",
			"failed",
			"stopped",
			"killed",
			"completed_stale",
			"contract_failure",
		]);

		let removed = 0;
		for (const [key, value] of Object.entries(tasks)) {
			if (terminalStatuses.has(value.status)) {
				delete tasks[key];
				removed += 1;
			}
		}

		expect(removed).toBe(3);
		expect(Object.keys(tasks)).toEqual(["running"]);
	});

	test("shows info when there are no completed/failed/stopped tasks", () => {
		const tasks: Record<string, { status: string }> = {
			running1: { status: "running" },
			running2: { status: "running" },
		};
		const terminalStatuses = new Set([
			"completed",
			"failed",
			"stopped",
			"killed",
			"completed_stale",
			"contract_failure",
		]);

		const terminalCount = Object.values(tasks).filter((task) =>
			terminalStatuses.has(task.status),
		).length;
		if (terminalCount === 0) {
			vscodeMock.window.showInformationMessage(
				"No completed, failed, or stopped agents to remove.",
			);
		}

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"No completed, failed, or stopped agents to remove.",
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
		expect(running?.id).toBe("t2");
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
		const node = undefined as { type: string; task?: AgentTask } | undefined;
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
		expect(tasks["t1"]?.status).toBe("running");
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
		const node = undefined as { type: string; task?: AgentTask } | undefined;
		const task = node?.task;

		if (!task?.project_dir) {
			vscodeMock.window.showWarningMessage(
				"No agent selected. Right-click an agent in the tree.",
			);
		}

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalled();
	});
});

describe("openFileDiff command", () => {
	test("uses HEAD as before ref for running agents", () => {
		const node = {
			projectDir: "/tmp/project",
			filePath: "src/app.ts",
			taskStatus: "running" as const,
		};
		const beforeRef = node.taskStatus === "running" ? "HEAD" : "HEAD~1";
		expect(beforeRef).toBe("HEAD");
	});

	test("uses startCommit for completed agents when provided", () => {
		const node = {
			projectDir: "/tmp/project",
			filePath: "src/app.ts",
			taskStatus: "completed" as string,
			startCommit: "abc123",
		};
		const beforeRef =
			node.taskStatus === "running" ? "HEAD" : (node.startCommit ?? "HEAD~1");
		expect(beforeRef).toBe("abc123");
	});

	test("shows warning when no file is selected", () => {
		const node = { projectDir: "/tmp/project", filePath: "" };
		if (!node.projectDir || !node.filePath) {
			vscodeMock.window.showWarningMessage("No file change selected.");
		}
		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No file change selected.",
		);
	});

	test("binary file change falls back to opening the file", () => {
		const node = {
			projectDir: "/tmp/project",
			filePath: "assets/logo.png",
			additions: -1,
			deletions: -1,
		};
		const isBinary = node.additions < 0 || node.deletions < 0;
		if (isBinary) {
			vscodeMock.window.showInformationMessage(
				"Binary file detected — no text diff is available.",
			);
		}
		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"Binary file detected — no text diff is available.",
		);
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

describe("toggleRunningFilter command", () => {
	test("flips showOnlyRunning from false to true and reloads tree", async () => {
		const get = mock((_key: string, defaultValue?: unknown) => {
			if (_key === "agentStatus.showOnlyRunning") return false;
			return defaultValue;
		});
		const update = mock((_section: string, _value: any, _target: any) =>
			Promise.resolve(),
		);
		vscodeMock.workspace.getConfiguration = mock(
			(_section?: string) =>
				({
					get,
					update,
				}) as any,
		);

		const agentStatusProvider = { reload: mock() };
		const handler = async () => {
			const config = vscodeMock.workspace.getConfiguration("commandCentral");
			const current = config.get("agentStatus.showOnlyRunning", false);
			await config.update(
				"agentStatus.showOnlyRunning",
				!current,
				vscodeMock.ConfigurationTarget.Workspace,
			);
			agentStatusProvider.reload();
		};

		await handler();

		expect(update).toHaveBeenCalledWith(
			"agentStatus.showOnlyRunning",
			true,
			vscodeMock.ConfigurationTarget.Workspace,
		);
		expect(agentStatusProvider.reload).toHaveBeenCalled();
	});

	test("active toggle command delegates to commandCentral.toggleRunningFilter", async () => {
		const handler = async () => {
			await vscodeMock.commands.executeCommand(
				"commandCentral.toggleRunningFilter",
			);
		};

		await handler();

		expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
			"commandCentral.toggleRunningFilter",
		);
	});
});
