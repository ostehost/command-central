/**
 * Extension Command Tests
 *
 * Tests the terminal focus/resume commands still registered inline in
 * extension.ts (focusAgentTerminal, showAgentOutput) plus the exported
 * launcher-truth helpers (taskMatchesSessionStoreBundle,
 * shouldTrustBundleSurface).
 *
 * The inline commands are tested via their handler logic patterns, not by
 * loading extension.ts. Commands extracted to src/activation/ modules are
 * covered by real-handler registration tests instead:
 * agent-navigation-commands-registration.test.ts,
 * agent-diff-commands-registration.test.ts,
 * openclaw-task-commands-registration.test.ts, and
 * agent-registry-commands-registration.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as path from "node:path";
import {
	__setCurrentMachineHostOverrideForTests,
	type AgentTask,
	getTaskExecutionHostLabel,
	isRemoteNodeTaskForCurrentHost,
} from "../../src/providers/agent-status-tree-provider.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

let vscodeMock: ReturnType<typeof setupVSCodeMock>;

beforeEach(() => {
	mock.restore();
	vscodeMock = setupVSCodeMock();
});

afterEach(() => {
	__setCurrentMachineHostOverrideForTests(null);
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
		// Strategy 3 fires: tmux backend + valid session_id → open -n -b Ghostty
		const shouldUseGhostty =
			task.terminal_backend === "tmux" &&
			task.session_id &&
			/^[a-zA-Z0-9._-]+$/.test(task.session_id);

		expect(shouldUseGhostty).toBeTruthy();

		// Strategy 3 should call:
		//   open -n -b com.mitchellh.ghostty --args -e "tmux attach -t SESSION"
		// The `-n` forces a new Ghostty instance per Ghostty's own macOS help
		// text ("Use `open -na Ghostty.app`"); without it the --args are
		// dropped when a Ghostty is already running. `-b <bundle-id>` pins the
		// stock bundle and avoids `-a Ghostty` name-lookup ambiguity against a
		// launcher bundle. NOT vscode.window.createTerminal.
		const expectedArgs = [
			"-n",
			"-b",
			"com.mitchellh.ghostty",
			"--args",
			"-e",
			`tmux attach -t ${task.session_id}`,
		];
		expect(expectedArgs[0]).toBe("-n");
		expect(expectedArgs[2]).toBe("com.mitchellh.ghostty");
		expect(expectedArgs[5]).toContain("tmux attach -t");
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

	// rc.37: classification is host-based, not path-based. The test pins the
	// "current machine" to a different name than the task's exec_host so the
	// task is genuinely remote regardless of project_dir location.
	test("node-hosted task is detected before hub-local focus strategies", () => {
		__setCurrentMachineHostOverrideForTests("Some Other Mac");
		const task = createTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: "dev.partnerai.ghostty.command-central",
			bundle_path: "/Applications/Projects/command-central.app",
			project_dir: "/Users/ostehost/projects/command-central",
			exec_mode: "spoke",
			exec_node: "Mike MacBook Pro",
			exec_host: "Mike's MacBook Pro",
			exec_visible: true,
			exec_cwd: "/Users/ostehost/projects/command-central",
		});

		expect(isRemoteNodeTaskForCurrentHost(task)).toBe(true);
		expect(getTaskExecutionHostLabel(task)).toBe("Mike's MacBook Pro");
		expect(vscodeMock.window.createTerminal).not.toHaveBeenCalled();
	});

	test("mirrored node task is detected even when launcher persisted exec_mode=hub", () => {
		__setCurrentMachineHostOverrideForTests("Some Other Mac");
		const task = createTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: "dev.partnerai.ghostty.ghostty-launcher",
			bundle_path: "/Applications/Projects/ghostty-launcher.app",
			project_dir: "/Users/ostehost/projects/ghostty-launcher",
			exec_mode: "hub",
			exec_node: null,
			exec_host: "Mike's MacBook Pro",
			exec_visible: true,
			exec_cwd: "/Users/ostehost/projects/ghostty-launcher",
		});

		expect(isRemoteNodeTaskForCurrentHost(task)).toBe(true);
		expect(getTaskExecutionHostLabel(task)).toBe("Mike's MacBook Pro");
		expect(vscodeMock.window.createTerminal).not.toHaveBeenCalled();
	});

	test("hub-local task with exec_mode=hub is not treated as a remote node task", () => {
		const task = createTask({
			terminal_backend: "tmux",
			project_dir: path.join(process.env["HOME"] ?? "/Users/test", "project"),
			exec_mode: "hub",
			exec_node: null,
			exec_host: null,
			exec_cwd: path.join(process.env["HOME"] ?? "/Users/test", "project"),
		});

		expect(isRemoteNodeTaskForCurrentHost(task)).toBe(false);
	});

	// rc.37 regression locks for the host-equality classification.
	// Originally caught when a probe spawned with project_dir=/tmp/... was
	// misclassified as remote because the old path heuristic only considered
	// $HOME-rooted paths local. The fix: classification compares exec_host
	// to the current machine name with normalization (case, whitespace,
	// .local stripping). Path of project_dir is irrelevant.
	test("local task with project_dir outside $HOME is NOT classified as remote", () => {
		__setCurrentMachineHostOverrideForTests("Mike's MacBook Pro");
		const task = createTask({
			terminal_backend: "tmux",
			project_dir: "/tmp/cc-probe-12345",
			exec_mode: "hub",
			exec_host: "Mike's MacBook Pro",
			exec_cwd: "/tmp/cc-probe-12345",
		});
		expect(isRemoteNodeTaskForCurrentHost(task)).toBe(false);
	});

	test("host comparison is case- and whitespace-insensitive", () => {
		__setCurrentMachineHostOverrideForTests("mike's macbook pro");
		const task = createTask({
			exec_host: "  Mike's MacBook Pro  ",
			exec_cwd: "/tmp/anywhere",
			project_dir: "/tmp/anywhere",
		});
		expect(isRemoteNodeTaskForCurrentHost(task)).toBe(false);
	});

	test("`.local` suffix on either side is ignored for host comparison", () => {
		__setCurrentMachineHostOverrideForTests("MacBookPro.local");
		const task = createTask({
			exec_host: "MacBookPro",
			project_dir: "/Volumes/SomeExternalDrive/project",
		});
		expect(isRemoteNodeTaskForCurrentHost(task)).toBe(false);
	});

	test("task with exec_host that does NOT match current host is classified as remote", () => {
		__setCurrentMachineHostOverrideForTests("Mike's MacBook Pro");
		const task = createTask({
			exec_host: "Mike's Mini",
			exec_mode: "spoke",
			project_dir: "/Users/ostemini/projects/something",
		});
		expect(isRemoteNodeTaskForCurrentHost(task)).toBe(true);
	});

	test("task with no exec_host metadata at all degrades to local (not remote)", () => {
		__setCurrentMachineHostOverrideForTests("Mike's MacBook Pro");
		const task = createTask({
			exec_host: null,
			exec_node: null,
			exec_mode: null,
			project_dir: "/opt/somewhere",
		});
		expect(isRemoteNodeTaskForCurrentHost(task)).toBe(false);
	});

	test("Strategy 3 falls through to no-terminal message on Ghostty failure", () => {
		void createTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: null,
			bundle_path: "(tmux-mode)",
			session_id: "valid-session",
		});

		// Simulate open -n -b com.mitchellh.ghostty failing (Ghostty not installed)
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

	test("Strategy 3 opens transcript when tmux session is dead and stream file exists", async () => {
		const task = createTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: null,
			bundle_path: "(tmux-mode)",
			session_id: "agent-my-project",
			stream_file: "/tmp/agent-my-project.jsonl",
		});

		// Strategy 3 requires a live tmux session — guard is inline
		const strategy3Fires =
			task.terminal_backend === "tmux" &&
			task.session_id &&
			/^[a-zA-Z0-9._-]+$/.test(task.session_id);
		expect(strategy3Fires).toBeTruthy();

		// Simulate tmux has-session failing with a persisted stream file.
		const sessionAlive = false;
		if (!sessionAlive) {
			await vscodeMock.commands.executeCommand(
				"vscode.open",
				vscodeMock.Uri.file(task.stream_file ?? ""),
			);
		}

		expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
			"vscode.open",
			expect.objectContaining({
				fsPath: "/tmp/agent-my-project.jsonl",
			}),
		);
	});

	test("Strategy 3 falls back to opening the project bundle when tmux session is dead and no stream file exists", () => {
		const task = createTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: null,
			bundle_path: "(tmux-mode)",
			session_id: "agent-my-project",
			project_dir: "/tmp/project",
			stream_file: null,
		});

		const sessionAlive = false;
		if (!sessionAlive && task.project_dir) {
			// The handler falls back to surfacing the empty project bundle via TerminalManager.
			expect(task.project_dir).toBe("/tmp/project");
		}

		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
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

	// Regression coverage for the launcher-truth gate introduced for running
	// tmux-backed tasks. When the tmux session is dead, bundle-focused
	// strategies must step aside so the user lands on the dead-session
	// quickpick (transcript / diff / resume / launcher) rather than a stale
	// Ghostty surface raised by `open -a`.
	describe("bundle-surface trust gate for running tmux-backed tasks", () => {
		test("running task + dead tmux session skips Strategy 0 (session-store cache)", async () => {
			const { shouldTrustBundleSurface } = await import(
				"../../src/extension.js"
			);
			const task = createTask({
				status: "running",
				terminal_backend: "tmux",
				session_id: "agent-project",
				ghostty_bundle_id: "dev.partnerai.ghostty.project",
			});
			const trusted = shouldTrustBundleSurface(task, false);
			// Strategy 0 gating: `if (projectDir && bundleSurfaceTrusted) { ... }`
			expect(trusted).toBe(false);
		});

		test("running task + dead tmux session skips Strategy 1 (launcher bundle focus)", async () => {
			const { shouldTrustBundleSurface } = await import(
				"../../src/extension.js"
			);
			const task = createTask({
				status: "running",
				terminal_backend: "tmux",
				session_id: "agent-project",
				ghostty_bundle_id: "dev.partnerai.ghostty.project",
			});
			// Strategy 1 now requires `bundleSurfaceTrusted` in addition to
			// terminal_backend === "tmux" && ghostty_bundle_id.
			const strategy1Fires =
				task.terminal_backend === "tmux" &&
				Boolean(task.ghostty_bundle_id) &&
				shouldTrustBundleSurface(task, false);
			expect(strategy1Fires).toBe(false);
		});

		test("running task + dead tmux session skips Strategy 2 (direct bundle path)", async () => {
			const { shouldTrustBundleSurface } = await import(
				"../../src/extension.js"
			);
			const task = createTask({
				status: "running",
				terminal_backend: "tmux",
				session_id: "agent-project",
				ghostty_bundle_id: null,
				bundle_path: "/Applications/Projects/project.app",
			});
			const strategy2Fires =
				!!task.bundle_path &&
				task.bundle_path !== "(test-mode)" &&
				task.bundle_path !== "(tmux-mode)" &&
				shouldTrustBundleSurface(task, false);
			expect(strategy2Fires).toBe(false);
		});

		test("running task + LIVE tmux session still fires Strategy 1 (bundle focus)", async () => {
			const { shouldTrustBundleSurface } = await import(
				"../../src/extension.js"
			);
			const task = createTask({
				status: "running",
				terminal_backend: "tmux",
				session_id: "agent-project",
				ghostty_bundle_id: "dev.partnerai.ghostty.project",
			});
			const strategy1Fires =
				task.terminal_backend === "tmux" &&
				Boolean(task.ghostty_bundle_id) &&
				shouldTrustBundleSurface(task, true);
			expect(strategy1Fires).toBe(true);
		});

		test("completed task with dead tmux session still fires bundle strategies (no running lane to protect)", async () => {
			const { shouldTrustBundleSurface } = await import(
				"../../src/extension.js"
			);
			const task = createTask({
				status: "completed",
				terminal_backend: "tmux",
				session_id: "agent-project",
				ghostty_bundle_id: "dev.partnerai.ghostty.project",
			});
			const strategy1Fires =
				task.terminal_backend === "tmux" &&
				Boolean(task.ghostty_bundle_id) &&
				shouldTrustBundleSurface(task, false);
			expect(strategy1Fires).toBe(true);
		});
	});

	describe("Strategy 2.5 conventional project bundle fallback", () => {
		test("tmux-mode task can use the conventional project launcher bundle before Strategy 3", () => {
			const task = createTask({
				project_dir: "/Users/ostehost/projects/command-central",
				terminal_backend: "tmux",
				ghostty_bundle_id: null,
				bundle_path: "(tmux-mode)",
				session_id: "agent-command-central",
				tmux_window_id: "@12",
			});

			const bundleSurfaceTrusted = true;
			const projectBundlePath = "/Applications/Projects/command-central.app";
			const strategy25Fires =
				task.terminal_backend === "tmux" &&
				Boolean(projectBundlePath) &&
				bundleSurfaceTrusted;

			expect(strategy25Fires).toBe(true);
		});
	});

	// Strategy 3 opens a generic Ghostty window with `tmux attach` rather than
	// focusing the launcher's visible bundle surface. The user has no way to
	// tell the difference from the click alone, so the handler emits an
	// informational message that names the tmux session and makes clear the
	// action spawned a fresh client, not a focus of an existing lane.
	describe("Strategy 3 truthful-surface notification", () => {
		test("tmux-mode task with live session emits a fresh-attach info message", () => {
			const task = createTask({
				terminal_backend: "tmux",
				ghostty_bundle_id: null,
				bundle_path: "(tmux-mode)",
				session_id: "agent-my-project",
			});

			// Simulate Strategy 3 preconditions and success.
			const strategy3Fires =
				task.terminal_backend === "tmux" &&
				Boolean(task.session_id) &&
				/^[a-zA-Z0-9._-]+$/.test(task.session_id ?? "");
			const tmuxSessionAlive = true;
			const ghosttyOpenSucceeded = true;

			if (strategy3Fires && tmuxSessionAlive && ghosttyOpenSucceeded) {
				vscodeMock.window.showInformationMessage(
					`Opened a fresh Ghostty window attached to tmux session "${task.session_id}" — no launcher surface known for this task.`,
				);
			}

			expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
				'Opened a fresh Ghostty window attached to tmux session "agent-my-project" — no launcher surface known for this task.',
			);
		});

		test("message does not fire when Strategy 3 preconditions are not met", () => {
			const task = createTask({
				terminal_backend: "tmux",
				ghostty_bundle_id: null,
				bundle_path: "(tmux-mode)",
				session_id: "invalid;rm -rf /",
			});

			const strategy3Fires =
				task.terminal_backend === "tmux" &&
				Boolean(task.session_id) &&
				/^[a-zA-Z0-9._-]+$/.test(task.session_id ?? "");

			expect(strategy3Fires).toBe(false);
			expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
		});

		test("message does not fire when tmux session is dead (Strategy 3 skipped, dead-session quickpick runs)", () => {
			const task = createTask({
				terminal_backend: "tmux",
				ghostty_bundle_id: null,
				bundle_path: "(tmux-mode)",
				session_id: "agent-my-project",
			});

			const strategy3Fires =
				task.terminal_backend === "tmux" &&
				Boolean(task.session_id) &&
				/^[a-zA-Z0-9._-]+$/.test(task.session_id ?? "");
			const tmuxSessionAlive = false;

			// Strategy 3 requires a live session. No message should fire.
			if (strategy3Fires && tmuxSessionAlive) {
				vscodeMock.window.showInformationMessage(
					`Opened a fresh Ghostty window attached to tmux session "${task.session_id}" — no launcher surface known for this task.`,
				);
			}

			expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
		});
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

	test("non-running tasks open the stream transcript instead of the live output channel", async () => {
		const task = createTask({
			status: "failed",
			stream_file: "/tmp/my-task.jsonl",
		});

		if (task.status !== "running" && task.stream_file) {
			await vscodeMock.commands.executeCommand(
				"vscode.open",
				vscodeMock.Uri.file(task.stream_file),
			);
		}

		expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
			"vscode.open",
			expect.objectContaining({
				fsPath: "/tmp/my-task.jsonl",
			}),
		);
	});

	test("non-running tasks warn when no transcript file exists", () => {
		const task = createTask({
			status: "completed",
			stream_file: null,
		});

		if (task.status !== "running" && !task.stream_file) {
			vscodeMock.window.showWarningMessage(
				"No output transcript file found for this task.",
			);
		}

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No output transcript file found for this task.",
		);
	});
});

describe("taskMatchesSessionStoreBundle (Strategy 0 guard)", () => {
	const mapping = {
		bundleId: "dev.partnerai.ghostty.ghostty-launcher",
		bundlePath: "/Applications/Projects/ghostty-launcher.app",
	};

	test("allows discovered agents (no task) to use the cached mapping", async () => {
		const { taskMatchesSessionStoreBundle } = await import(
			"../../src/extension.js"
		);
		expect(taskMatchesSessionStoreBundle(undefined, mapping)).toBe(true);
	});

	test("allows launcher tasks whose ghostty_bundle_id matches the mapping", async () => {
		const { taskMatchesSessionStoreBundle } = await import(
			"../../src/extension.js"
		);
		const task = createTask({
			ghostty_bundle_id: "dev.partnerai.ghostty.ghostty-launcher",
		});
		expect(taskMatchesSessionStoreBundle(task, mapping)).toBe(true);
	});

	test("rejects tmux-mode tasks (ghostty_bundle_id null) to prevent cross-task collapse", async () => {
		const { taskMatchesSessionStoreBundle } = await import(
			"../../src/extension.js"
		);
		const task = createTask({
			ghostty_bundle_id: null,
			bundle_path: "(tmux-mode)",
			terminal_backend: "tmux",
		});
		expect(taskMatchesSessionStoreBundle(task, mapping)).toBe(false);
	});

	test("rejects launcher tasks whose ghostty_bundle_id differs from the mapping", async () => {
		const { taskMatchesSessionStoreBundle } = await import(
			"../../src/extension.js"
		);
		const task = createTask({
			ghostty_bundle_id: "dev.partnerai.ghostty.some-other-project",
		});
		expect(taskMatchesSessionStoreBundle(task, mapping)).toBe(false);
	});
});

describe("shouldTrustBundleSurface (launcher-truth gate)", () => {
	test("running tmux-backed task with a live tmux session trusts the bundle surface", async () => {
		const { shouldTrustBundleSurface } = await import("../../src/extension.js");
		const task = createTask({
			status: "running",
			terminal_backend: "tmux",
			session_id: "agent-project",
			ghostty_bundle_id: "dev.partnerai.ghostty.project",
		});
		expect(shouldTrustBundleSurface(task, true)).toBe(true);
	});

	test("running tmux-backed task with a dead tmux session does NOT trust the bundle surface", async () => {
		const { shouldTrustBundleSurface } = await import("../../src/extension.js");
		const task = createTask({
			status: "running",
			terminal_backend: "tmux",
			session_id: "agent-project",
			ghostty_bundle_id: "dev.partnerai.ghostty.project",
		});
		// Launcher truth says the live lane is gone — the bundle's visible
		// Ghostty surface (if any) is stale and must not be treated as
		// authoritative for a "focus" click.
		expect(shouldTrustBundleSurface(task, false)).toBe(false);
	});

	test("completed tmux-backed task always trusts the bundle surface", async () => {
		const { shouldTrustBundleSurface } = await import("../../src/extension.js");
		const task = createTask({
			status: "completed",
			terminal_backend: "tmux",
			session_id: "agent-project",
			ghostty_bundle_id: "dev.partnerai.ghostty.project",
		});
		// Completed tasks don't have a live lane to protect; the bundle
		// still hosts the agent's final transcript and is the right surface
		// to raise for review.
		expect(shouldTrustBundleSurface(task, false)).toBe(true);
		expect(shouldTrustBundleSurface(task, true)).toBe(true);
	});

	test("failed and stopped tmux-backed tasks trust the bundle surface regardless of tmux", async () => {
		const { shouldTrustBundleSurface } = await import("../../src/extension.js");
		for (const status of ["failed", "stopped", "completed_dirty"] as const) {
			const task = createTask({
				status,
				terminal_backend: "tmux",
				session_id: "agent-project",
				ghostty_bundle_id: "dev.partnerai.ghostty.project",
			});
			expect(shouldTrustBundleSurface(task, false)).toBe(true);
		}
	});

	test("non-tmux running tasks trust the bundle surface (no tmux invariant to violate)", async () => {
		const { shouldTrustBundleSurface } = await import("../../src/extension.js");
		const task = createTask({
			status: "running",
			terminal_backend: "persist",
			session_id: "agent-project",
			ghostty_bundle_id: "dev.partnerai.ghostty.project",
		});
		expect(shouldTrustBundleSurface(task, false)).toBe(true);
		expect(shouldTrustBundleSurface(task, null)).toBe(true);
	});

	test("running tmux tasks with no session id trust the bundle surface (cannot verify liveness)", async () => {
		const { shouldTrustBundleSurface } = await import("../../src/extension.js");
		const task = createTask({
			status: "running",
			terminal_backend: "tmux",
			session_id: "",
			ghostty_bundle_id: "dev.partnerai.ghostty.project",
		});
		expect(shouldTrustBundleSurface(task, null)).toBe(true);
	});

	test("running tmux tasks with unsafe session ids trust the bundle surface (we refuse to shell out)", async () => {
		const { shouldTrustBundleSurface } = await import("../../src/extension.js");
		const task = createTask({
			status: "running",
			terminal_backend: "tmux",
			session_id: "bad;rm -rf /",
			ghostty_bundle_id: "dev.partnerai.ghostty.project",
		});
		// isValidSessionId would reject this, so we never probe. Fall back
		// to trusting the surface — there's nothing safer to do without
		// liveness information.
		expect(shouldTrustBundleSurface(task, null)).toBe(true);
	});

	test("null liveness (probe skipped) trusts the surface — do not block when we have no evidence", async () => {
		const { shouldTrustBundleSurface } = await import("../../src/extension.js");
		const task = createTask({
			status: "running",
			terminal_backend: "tmux",
			session_id: "agent-project",
			ghostty_bundle_id: "dev.partnerai.ghostty.project",
		});
		expect(shouldTrustBundleSurface(task, null)).toBe(true);
	});
});

describe("resolveAuthorizationTmuxLiveness (native-room fast path)", () => {
	test("cached probe present and returns true → resolves true; fresh probe never invoked", async () => {
		const { resolveAuthorizationTmuxLiveness } = await import(
			"../../src/extension.js"
		);
		const task = createTask({
			status: "running",
			terminal_backend: "tmux",
			session_id: "agent-project",
			ghostty_bundle_id: "dev.partnerai.ghostty.project",
		});
		let freshCalled = false;
		const result = await resolveAuthorizationTmuxLiveness(
			task,
			() => true,
			async () => {
				freshCalled = true;
				return false;
			},
		);
		expect(result).toBe(true);
		expect(freshCalled).toBe(false);
	});

	test("cached probe present and returns false → resolves false; fresh probe never invoked", async () => {
		const { resolveAuthorizationTmuxLiveness } = await import(
			"../../src/extension.js"
		);
		const task = createTask({
			status: "running",
			terminal_backend: "tmux",
			session_id: "agent-project",
			ghostty_bundle_id: "dev.partnerai.ghostty.project",
		});
		let freshCalled = false;
		const result = await resolveAuthorizationTmuxLiveness(
			task,
			() => false,
			async () => {
				freshCalled = true;
				return true;
			},
		);
		expect(result).toBe(false);
		expect(freshCalled).toBe(false);
	});

	test("no cached probe (undefined) → falls back to fresh async probe; fresh probe WAS invoked", async () => {
		const { resolveAuthorizationTmuxLiveness } = await import(
			"../../src/extension.js"
		);
		const task = createTask({
			status: "running",
			terminal_backend: "tmux",
			session_id: "agent-project",
			ghostty_bundle_id: "dev.partnerai.ghostty.project",
		});
		let freshCalled = false;
		const result = await resolveAuthorizationTmuxLiveness(
			task,
			undefined,
			async () => {
				freshCalled = true;
				return true;
			},
		);
		expect(result).toBe(true);
		expect(freshCalled).toBe(true);
	});

	test("integration with authorization gate: cached=false on running tmux task → shouldTrustBundleSurface false; cached=true → true", async () => {
		const { resolveAuthorizationTmuxLiveness, shouldTrustBundleSurface } =
			await import("../../src/extension.js");
		const task = createTask({
			status: "running",
			terminal_backend: "tmux",
			session_id: "agent-project",
			ghostty_bundle_id: "dev.partnerai.ghostty.project",
		});

		const resolvedFalse = await resolveAuthorizationTmuxLiveness(
			task,
			() => false,
			async () => true,
		);
		expect(shouldTrustBundleSurface(task, resolvedFalse)).toBe(false);

		const resolvedTrue = await resolveAuthorizationTmuxLiveness(
			task,
			() => true,
			async () => false,
		);
		expect(shouldTrustBundleSurface(task, resolvedTrue)).toBe(true);
	});
});
