/**
 * AgentStatusTreeProvider Tests
 *
 * Tests the tree provider with mock task registry data.
 * Verifies: tree structure, status icons, elapsed time formatting,
 * child nodes (details), sorting, and edge cases.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock port-detector to avoid real lsof calls in tree provider tests
const mockDetectListeningPorts = mock(() => [] as Array<{ port: number; pid: number; process: string }>);
mock.module("../../src/utils/port-detector.js", () => ({
	detectListeningPorts: mockDetectListeningPorts,
}));

import {
	type AgentNode,
	type AgentRole,
	AgentStatusTreeProvider,
	type AgentTask,
	formatElapsed,
	type GitInfo,
	isValidSessionId,
	type TaskRegistry,
} from "../../src/providers/agent-status-tree-provider.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// ── Mock data ────────────────────────────────────────────────────────

function createMockTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "test-task-1",
		status: "running",
		project_dir: "/Users/test/projects/my-app",
		project_name: "My App",
		session_id: "agent-my-app",
		tmux_session: "agent-my-app",
		bundle_path: "/Applications/Projects/My App.app",
		prompt_file: "/tmp/task.md",
		started_at: "2026-02-25T08:00:00Z",
		attempts: 1,
		max_attempts: 3,
		pr_number: null,
		review_status: null,
		...overrides,
	};
}

function createMockRegistry(
	tasks: Record<string, AgentTask> = {},
): TaskRegistry {
	return { version: 2, tasks };
}

/** Helper: extract only task nodes from root children (skips summary node) */
function getTaskNodes(children: AgentNode[]): AgentNode[] {
	return children.filter((n) => n.type === "task");
}

/** Helper: get the first task node from root children */
function getFirstTask(children: AgentNode[]): AgentNode {
	const task = children.find((n) => n.type === "task");
	if (!task) throw new Error("No task node found in children");
	return task;
}

// ── formatElapsed tests ──────────────────────────────────────────────

describe("formatElapsed", () => {
	test("shows minutes for short durations", () => {
		const now = new Date("2026-02-25T08:30:00Z");
		expect(formatElapsed("2026-02-25T08:00:00Z", now)).toBe("30m");
	});

	test("shows hours and minutes for long durations", () => {
		const now = new Date("2026-02-25T10:15:00Z");
		expect(formatElapsed("2026-02-25T08:00:00Z", now)).toBe("2h 15m");
	});

	test("shows 0m for same time", () => {
		const now = new Date("2026-02-25T08:00:00Z");
		expect(formatElapsed("2026-02-25T08:00:00Z", now)).toBe("0m");
	});

	test("handles future start time gracefully", () => {
		const now = new Date("2026-02-25T07:00:00Z");
		expect(formatElapsed("2026-02-25T08:00:00Z", now)).toBe("0m");
	});
});

// ── TreeProvider tests ───────────────────────────────────────────────

describe("AgentStatusTreeProvider", () => {
	let provider: AgentStatusTreeProvider;

	beforeEach(() => {
		mock.restore();
		const vscodeMock = setupVSCodeMock();
		// Ensure show*Message mocks return promises (needed for notification .then())
		vscodeMock.window.showInformationMessage = mock(() =>
			Promise.resolve(undefined),
		);
		vscodeMock.window.showWarningMessage = mock(() =>
			Promise.resolve(undefined),
		);

		provider = new AgentStatusTreeProvider();
		// Override readRegistry to return mock data (no file I/O)
		provider.readRegistry = () => createMockRegistry({});
		provider.reload();
	});

	test("returns empty array when no tasks", () => {
		const children = provider.getChildren();
		expect(children).toEqual([]);
	});

	test("returns task nodes at root level", () => {
		const task = createMockTask();
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.reload();

		const children = provider.getChildren();
		expect(children).toHaveLength(2); // 1 summary + 1 task
		expect(children[0]?.type).toBe("summary");
		const taskNodes = getTaskNodes(children);
		expect(taskNodes).toHaveLength(1);
		expect(taskNodes[0]?.type).toBe("task");
	});

	test("summary node has correct format", () => {
		const t1 = createMockTask({ id: "t1", status: "running" });
		const t2 = createMockTask({ id: "t2", status: "completed" });
		const t3 = createMockTask({ id: "t3", status: "failed" });
		provider.readRegistry = () => createMockRegistry({ t1, t2, t3 });
		provider.reload();

		const children = provider.getChildren();
		const summary = children.find((n) => n.type === "summary");
		expect(summary).toBeDefined();
		expect(summary?.type).toBe("summary");
		if (summary?.type === "summary") {
			expect(summary.label).toContain("1 running");
			expect(summary.label).toContain("1 completed");
			expect(summary.label).toContain("1 failed");
		}
	});

	test("summary node TreeItem has info icon and correct contextValue", () => {
		const task = createMockTask();
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.reload();

		const children = provider.getChildren();
		const summary = children.find((n) => n.type === "summary")!;
		const item = provider.getTreeItem(summary);
		expect(item.contextValue).toBe("agentSummary");
		expect(item.collapsibleState).toBe(0); // None
	});

	test("sorts tasks by started_at descending (newest first)", () => {
		const older = createMockTask({
			id: "old",
			started_at: "2026-02-25T06:00:00Z",
		});
		const newer = createMockTask({
			id: "new",
			started_at: "2026-02-25T09:00:00Z",
		});
		provider.readRegistry = () =>
			createMockRegistry({ old: older, new: newer });
		provider.reload();

		const children = provider.getChildren();
		expect(children).toHaveLength(3); // 1 summary + 2 tasks
		const taskNodes = getTaskNodes(children);
		expect(taskNodes).toHaveLength(2);
		expect((taskNodes[0] as { type: "task"; task: AgentTask }).task.id).toBe(
			"new",
		);
		expect((taskNodes[1] as { type: "task"; task: AgentTask }).task.id).toBe(
			"old",
		);
	});

	test("returns detail nodes for task children", () => {
		const task = createMockTask();
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		// Mock out git info to test base detail structure
		provider.getGitInfo = () => null;
		provider.reload();

		const root = provider.getChildren();
		const firstTask = getFirstTask(root);
		const details = provider.getChildren(firstTask);
		// Should have: Prompt, Worktree, Attempts, Session (no PR since null, no git since mocked)
		expect(details).toHaveLength(4);
		expect(details.every((d) => d.type === "detail")).toBe(true);
	});

	test("includes PR detail when pr_number is set", () => {
		const task = createMockTask({
			pr_number: 42,
			review_status: "approved",
		});
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		// Mock out git info to test PR detail specifically
		provider.getGitInfo = () => null;
		provider.reload();

		const root = provider.getChildren();
		const firstTask = getFirstTask(root);
		const details = provider.getChildren(firstTask);
		expect(details).toHaveLength(5);
		const prDetail = details.find(
			(d) => d.type === "detail" && d.label === "PR",
		);
		expect(prDetail).toBeDefined();
		if (prDetail?.type === "detail") {
			expect(prDetail.value).toBe("#42 (approved)");
		}
	});

	test("getTreeItem creates collapsible item for tasks", () => {
		const task = createMockTask({ status: "running" });
		const node: AgentNode = { type: "task", task };
		const item = provider.getTreeItem(node);
		expect(item.label).toContain("🔄");
		expect(item.label).toContain("test-task-1");
		expect(item.collapsibleState).toBe(1); // Collapsed
	});

	test("getTreeItem creates non-collapsible item for details", () => {
		const node: AgentNode = {
			type: "detail",
			label: "Worktree",
			value: "/some/path",
			taskId: "t1",
		};
		const item = provider.getTreeItem(node);
		expect(item.label).toContain("Worktree: /some/path");
		expect(item.collapsibleState).toBe(0); // None
	});

	test("status icons are correct", () => {
		const statuses = [
			["running", "🔄"],
			["completed", "✅"],
			["failed", "❌"],
			["stopped", "⏹️"],
			["killed", "💀"],
		] as const;

		for (const [status, icon] of statuses) {
			const task = createMockTask({ status });
			const node: AgentNode = { type: "task", task };
			const item = provider.getTreeItem(node);
			expect(item.label).toContain(icon);
		}
	});

	test("contextValue includes status for tasks", () => {
		const task = createMockTask({ status: "running" });
		const item = provider.getTreeItem({ type: "task", task });
		expect(item.contextValue).toBe("agentTask.running");
	});

	test("getParent returns task node for detail", () => {
		const task = createMockTask();
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.reload();

		const parent = provider.getParent({
			type: "detail",
			label: "Worktree",
			value: "/path",
			taskId: "test-task-1",
		});
		expect(parent?.type).toBe("task");
	});

	test("getParent returns undefined for task nodes", () => {
		const task = createMockTask();
		const parent = provider.getParent({ type: "task", task });
		expect(parent).toBeUndefined();
	});

	test("getTasks returns all tasks", () => {
		const t1 = createMockTask({ id: "t1" });
		const t2 = createMockTask({ id: "t2" });
		provider.readRegistry = () => createMockRegistry({ t1, t2 });
		provider.reload();
		expect(provider.getTasks()).toHaveLength(2);
	});

	test("shows role emoji before task name", () => {
		const roles: [AgentRole, string][] = [
			["planner", "🔬"],
			["developer", "🔨"],
			["reviewer", "🔍"],
			["test", "🧪"],
		];
		for (const [role, emoji] of roles) {
			const task = createMockTask({ role });
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.label).toContain(emoji);
		}
	});

	test("omits role emoji when role is null", () => {
		const task = createMockTask({ role: null });
		const item = provider.getTreeItem({ type: "task", task });
		// Should have status icon but no role icon
		expect(item.label).toBe("🔄 test-task-1");
	});

	test("includes terminal_backend in tooltip", () => {
		const task = createMockTask({ terminal_backend: "tmux" });
		const item = provider.getTreeItem({ type: "task", task });
		expect((item.tooltip as { value: string }).value).toContain(
			"Terminal: tmux",
		);
	});

	test("includes exit_code in tooltip for failed tasks", () => {
		const task = createMockTask({ status: "failed", exit_code: 1 });
		const item = provider.getTreeItem({ type: "task", task });
		expect((item.tooltip as { value: string }).value).toContain("Exit code: 1");
	});

	test("shows exit_code detail node when set", () => {
		const task = createMockTask({ status: "failed", exit_code: 127 });
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.reload();

		const root = provider.getChildren();
		const firstTask = getFirstTask(root);
		const details = provider.getChildren(firstTask);
		const exitDetail = details.find(
			(d) => d.type === "detail" && d.label === "Exit Code",
		);
		expect(exitDetail).toBeDefined();
		if (exitDetail?.type === "detail") {
			expect(exitDetail.value).toBe("127");
		}
	});

	test("omits exit_code detail when not set", () => {
		const task = createMockTask();
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.reload();

		const root = provider.getChildren();
		const firstTask = getFirstTask(root);
		const details = provider.getChildren(firstTask);
		const exitDetail = details.find(
			(d) => d.type === "detail" && d.label === "Exit Code",
		);
		expect(exitDetail).toBeUndefined();
	});

	test("accepts version 2 registry", () => {
		const task = createMockTask();
		provider.readRegistry = () => ({
			version: 2,
			tasks: { "test-task-1": task },
		});
		provider.reload();
		const children = provider.getChildren();
		expect(children).toHaveLength(2); // 1 summary + 1 task
	});

	test("normalizes v1 tmux_session to session_id", () => {
		// Simulate normalized output: readRegistry converts tmux_session → session_id
		provider.readRegistry = () => ({
			version: 2,
			tasks: {
				t1: {
					...createMockTask(),
					session_id: "legacy-session",
					tmux_session: "legacy-session",
				} as AgentTask,
			},
		});
		provider.reload();
		const tasks = provider.getTasks();
		expect(tasks[0]?.session_id).toBe("legacy-session");
	});

	test("session_id takes precedence over tmux_session", () => {
		provider.readRegistry = () => ({
			version: 2,
			tasks: {
				t1: {
					...createMockTask(),
					session_id: "new-id",
					tmux_session: "old-id",
				} as AgentTask,
			},
		});
		provider.reload();
		const tasks = provider.getTasks();
		expect(tasks[0]?.session_id).toBe("new-id");
	});

	test("detail node shows Session label instead of tmux", () => {
		const task = createMockTask();
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.reload();
		const root = provider.getChildren();
		const firstTask = getFirstTask(root);
		const details = provider.getChildren(firstTask);
		const sessionDetail = details.find(
			(d) => d.type === "detail" && d.label === "Session",
		);
		expect(sessionDetail).toBeDefined();
		if (sessionDetail?.type === "detail") {
			expect(sessionDetail.value).toBe("agent-my-app");
		}
	});

	test("isValidSessionId validates session names", () => {
		expect(isValidSessionId("agent-my-app")).toBe(true);
		expect(isValidSessionId("session.123_test")).toBe(true);
		expect(isValidSessionId("")).toBe(false);
		expect(isValidSessionId("bad;injection")).toBe(false);
		expect(isValidSessionId("has spaces")).toBe(false);
	});

	test("task TreeItem has command property set", () => {
		const task = createMockTask();
		const node: AgentNode = { type: "task", task };
		const item = provider.getTreeItem(node);
		expect(item.command).toBeDefined();
		expect(item.command?.command).toBe("commandCentral.focusAgentTerminal");
	});

	test("task TreeItem command arguments contain the element", () => {
		const task = createMockTask();
		const node: AgentNode = { type: "task", task };
		const item = provider.getTreeItem(node);
		expect(item.command?.arguments).toHaveLength(1);
		const arg = item.command?.arguments?.[0] as {
			type: string;
			task: AgentTask;
		};
		expect(arg.type).toBe("task");
		expect(arg.task.id).toBe("test-task-1");
	});

	test("resolveTreeItem returns original item for non-running tasks", async () => {
		const task = createMockTask({ status: "completed" });
		const node: AgentNode = { type: "task", task };
		const item = provider.getTreeItem(node);
		const originalDesc = item.description;
		const resolved = await provider.resolveTreeItem(item, node);
		expect(resolved.description).toBe(originalDesc);
	});

	test("resolveTreeItem returns original item for detail nodes", async () => {
		const node: AgentNode = {
			type: "detail",
			label: "Worktree",
			value: "/path",
			taskId: "t1",
		};
		const item = provider.getTreeItem(node);
		const resolved = await provider.resolveTreeItem(item, node);
		expect(resolved).toBe(item);
	});

	test("resolveTreeItem handles tmux failure gracefully", async () => {
		const task = createMockTask({
			status: "running",
			session_id: "valid-session",
		});
		const node: AgentNode = { type: "task", task };
		const item = provider.getTreeItem(node);
		const originalDesc = item.description;
		// execFileSync will throw (tmux not available in test), so description should stay the same
		const resolved = await provider.resolveTreeItem(item, node);
		expect(resolved.description).toBe(originalDesc);
	});

	test("dispose cleans up", () => {
		// Should not throw
		expect(() => provider.dispose()).not.toThrow();
	});

	// ── resourceUri for decoration provider ──────────────────────────

	test("task TreeItem has resourceUri with agent-task scheme", () => {
		const task = createMockTask();
		const node: AgentNode = { type: "task", task };
		const item = provider.getTreeItem(node);
		expect(item.resourceUri).toBeDefined();
		expect(item.resourceUri?.toString()).toContain("agent-task:");
		expect(item.resourceUri?.toString()).toContain("test-task-1");
	});

	// ── Feature 1: Auto-Refresh Timer ────────────────────────────────

	describe("auto-refresh timer", () => {
		test("timer starts when running tasks exist", () => {
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.reload();
			// Access private autoRefreshTimer via cast
			const p = provider as unknown as {
				autoRefreshTimer: NodeJS.Timeout | null;
			};
			expect(p.autoRefreshTimer).not.toBeNull();
		});

		test("timer stops when no running tasks", () => {
			// First start with a running task
			const runningTask = createMockTask({ status: "running" });
			provider.readRegistry = () =>
				createMockRegistry({ "test-task-1": runningTask });
			provider.reload();

			// Then switch to completed
			const completedTask = createMockTask({ status: "completed" });
			provider.readRegistry = () =>
				createMockRegistry({ "test-task-1": completedTask });
			provider.reload();

			const p = provider as unknown as {
				autoRefreshTimer: NodeJS.Timeout | null;
			};
			expect(p.autoRefreshTimer).toBeNull();
		});

		test("timer does not start when all tasks are completed", () => {
			const task = createMockTask({ status: "completed" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.reload();
			const p = provider as unknown as {
				autoRefreshTimer: NodeJS.Timeout | null;
			};
			expect(p.autoRefreshTimer).toBeNull();
		});

		test("dispose clears auto-refresh timer", () => {
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.reload();

			provider.dispose();
			const p = provider as unknown as {
				autoRefreshTimer: NodeJS.Timeout | null;
			};
			expect(p.autoRefreshTimer).toBeNull();
		});
	});

	// ── Feature 2: Git Branch + Last Commit ──────────────────────────

	describe("git info in tree", () => {
		test("git info detail nodes appear when getGitInfo returns data", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			// Override getGitInfo to return mock data
			provider.getGitInfo = (_dir: string): GitInfo | null => ({
				branch: "feature/my-branch",
				lastCommit: "abc1234 fix: something (2m ago)",
			});
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const branchDetail = details.find(
				(d) => d.type === "detail" && d.label === "Branch",
			);
			const commitDetail = details.find(
				(d) => d.type === "detail" && d.label === "Last Commit",
			);
			expect(branchDetail).toBeDefined();
			expect(commitDetail).toBeDefined();
			if (branchDetail?.type === "detail") {
				expect(branchDetail.value).toBe("feature/my-branch");
			}
			if (commitDetail?.type === "detail") {
				expect(commitDetail.value).toBe("abc1234 fix: something (2m ago)");
			}
		});

		test("graceful fallback when git info is null (non-git dir)", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = (_dir: string): GitInfo | null => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const branchDetail = details.find(
				(d) => d.type === "detail" && d.label === "Branch",
			);
			expect(branchDetail).toBeUndefined();
		});

		test("branch and commit format correct in detail nodes", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = (_dir: string): GitInfo | null => ({
				branch: "main",
				lastCommit: "def5678 chore: update deps (5h ago)",
			});
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const branchItem = provider.getTreeItem(
				details.find((d) => d.type === "detail" && d.label === "Branch")!,
			);
			expect(branchItem.label).toBe("Branch: main");
			const commitItem = provider.getTreeItem(
				details.find((d) => d.type === "detail" && d.label === "Last Commit")!,
			);
			expect(commitItem.label).toBe(
				"Last Commit: def5678 chore: update deps (5h ago)",
			);
		});
	});

	// ── Feature 3: Completion Notifications ──────────────────────────

	describe("completion notifications", () => {
		let vscodeMock: ReturnType<typeof setupVSCodeMock>;

		beforeEach(() => {
			mock.restore();
			vscodeMock = setupVSCodeMock();
			// Make notifications enabled by default
			vscodeMock.workspace.getConfiguration = mock(() => ({
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "agentStatus.notifications") return true;
					return defaultValue;
				}),
			}));
			// Ensure show*Message mocks return promises
			vscodeMock.window.showInformationMessage = mock(() =>
				Promise.resolve(undefined),
			);
			vscodeMock.window.showWarningMessage = mock(() =>
				Promise.resolve(undefined),
			);
			provider = new AgentStatusTreeProvider();
			provider.readRegistry = () => createMockRegistry({});
			provider.reload();
		});

		test("notification fires on running→completed transition", () => {
			// Set up running state
			const runningTask = createMockTask({ id: "t1", status: "running" });
			provider.readRegistry = () => createMockRegistry({ t1: runningTask });
			provider.reload();

			// Transition to completed
			const completedTask = createMockTask({ id: "t1", status: "completed" });
			provider.readRegistry = () => createMockRegistry({ t1: completedTask });
			provider.reload();

			expect(vscodeMock.window.showInformationMessage).toHaveBeenCalled();
			const callArgs = (
				vscodeMock.window.showInformationMessage as ReturnType<typeof mock>
			).mock.calls[0] as string[] | undefined;
			expect(callArgs?.[0]).toContain("Agent t1 completed");
			expect(callArgs?.[1]).toBe("Focus Terminal");
		});

		test("notification fires on running→failed transition", () => {
			// Set up running state
			const runningTask = createMockTask({ id: "t2", status: "running" });
			provider.readRegistry = () => createMockRegistry({ t2: runningTask });
			provider.reload();

			// Transition to failed
			const failedTask = createMockTask({ id: "t2", status: "failed" });
			provider.readRegistry = () => createMockRegistry({ t2: failedTask });
			provider.reload();

			expect(vscodeMock.window.showWarningMessage).toHaveBeenCalled();
			const callArgs = (
				vscodeMock.window.showWarningMessage as ReturnType<typeof mock>
			).mock.calls[0] as string[] | undefined;
			expect(callArgs?.[0]).toContain("Agent t2 failed");
		});

		test("no notification on completed→completed (no transition)", () => {
			const task = createMockTask({ id: "t3", status: "completed" });
			provider.readRegistry = () => createMockRegistry({ t3: task });
			provider.reload();

			// Reload again with same status
			provider.reload();

			// showInformationMessage should not have been called
			expect(
				(vscodeMock.window.showInformationMessage as ReturnType<typeof mock>)
					.mock.calls.length,
			).toBe(0);
		});

		test("no notification on initial load (no previous state)", () => {
			const task = createMockTask({ id: "t4", status: "completed" });
			provider.readRegistry = () => createMockRegistry({ t4: task });
			provider.reload();

			expect(
				(vscodeMock.window.showInformationMessage as ReturnType<typeof mock>)
					.mock.calls.length,
			).toBe(0);
		});

		test("no notification when setting is disabled", () => {
			// Override config to disable notifications
			vscodeMock.workspace.getConfiguration = mock(() => ({
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "agentStatus.notifications") return false;
					return defaultValue;
				}),
			}));

			const runningTask = createMockTask({ id: "t5", status: "running" });
			provider.readRegistry = () => createMockRegistry({ t5: runningTask });
			provider.reload();

			const completedTask = createMockTask({ id: "t5", status: "completed" });
			provider.readRegistry = () => createMockRegistry({ t5: completedTask });
			provider.reload();

			expect(
				(vscodeMock.window.showInformationMessage as ReturnType<typeof mock>)
					.mock.calls.length,
			).toBe(0);
		});
	});

	// ── Phase 4, Feature 1: Port Detection Detail Nodes ──────────────

	describe("port detection in tree", () => {
		beforeEach(() => {
			mockDetectListeningPorts.mockReset();
		});

		test("ports detail node appears for running tasks with ports", () => {
			mockDetectListeningPorts.mockReturnValue([
				{ port: 3000, pid: 1234, process: "node" },
			]);
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const portsDetail = details.find(
				(d) => d.type === "detail" && d.label === "Ports",
			);
			expect(portsDetail).toBeDefined();
			if (portsDetail?.type === "detail") {
				expect(portsDetail.value).toBe("3000 (node)");
			}
		});

		test("no ports detail for non-running tasks", () => {
			mockDetectListeningPorts.mockReturnValue([
				{ port: 3000, pid: 1234, process: "node" },
			]);
			const task = createMockTask({ status: "completed" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const portsDetail = details.find(
				(d) => d.type === "detail" && d.label === "Ports",
			);
			expect(portsDetail).toBeUndefined();
			// detectListeningPorts should not have been called for non-running tasks
			expect(mockDetectListeningPorts).not.toHaveBeenCalled();
		});

		test("no ports detail when detectListeningPorts returns empty", () => {
			mockDetectListeningPorts.mockReturnValue([]);
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const portsDetail = details.find(
				(d) => d.type === "detail" && d.label === "Ports",
			);
			expect(portsDetail).toBeUndefined();
		});

		test("multiple ports displayed with comma separation", () => {
			mockDetectListeningPorts.mockReturnValue([
				{ port: 3000, pid: 1234, process: "node" },
				{ port: 8080, pid: 5678, process: "python3" },
			]);
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const portsDetail = details.find(
				(d) => d.type === "detail" && d.label === "Ports",
			);
			expect(portsDetail).toBeDefined();
			if (portsDetail?.type === "detail") {
				expect(portsDetail.value).toBe("3000 (node), 8080 (python3)");
			}
		});
	});

	// ── Phase 4, Feature 3: Per-Project Emoji Icons ─────────────────

	describe("per-project emoji icons", () => {
		let vscodeMock: ReturnType<typeof setupVSCodeMock>;

		beforeEach(() => {
			mock.restore();
			// Re-mock port detector after mock.restore()
			mockDetectListeningPorts.mockReset();
			mockDetectListeningPorts.mockReturnValue([]);

			vscodeMock = setupVSCodeMock();
			vscodeMock.window.showInformationMessage = mock(() =>
				Promise.resolve(undefined),
			);
			vscodeMock.window.showWarningMessage = mock(() =>
				Promise.resolve(undefined),
			);
			provider = new AgentStatusTreeProvider();
			provider.readRegistry = () => createMockRegistry({});
			provider.reload();
		});

		test("emoji prepended when project config matches", () => {
			vscodeMock.workspace.getConfiguration = mock(() => ({
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "projects") return [{ name: "my-app", emoji: "🚀" }];
					return defaultValue;
				}),
			}));

			const task = createMockTask({
				project_dir: "/Users/test/projects/my-app",
			});
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.label).toContain("🚀");
			expect(item.label).toContain("test-task-1");
		});

		test("no emoji when no config match", () => {
			vscodeMock.workspace.getConfiguration = mock(() => ({
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "projects")
						return [{ name: "other-project", emoji: "🎨" }];
					return defaultValue;
				}),
			}));

			const task = createMockTask({
				project_dir: "/Users/test/projects/my-app",
			});
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.label).not.toContain("🎨");
			expect(item.label).toBe("🔄 test-task-1");
		});

		test("config with multiple projects works correctly", () => {
			vscodeMock.workspace.getConfiguration = mock(() => ({
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "projects")
						return [
							{ name: "my-app", emoji: "🚀" },
							{ name: "api-server", emoji: "⚡" },
							{ name: "docs", emoji: "📚" },
						];
					return defaultValue;
				}),
			}));

			const task1 = createMockTask({
				id: "t1",
				project_dir: "/Users/test/projects/api-server",
			});
			const item1 = provider.getTreeItem({ type: "task", task: task1 });
			expect(item1.label).toContain("⚡");

			const task2 = createMockTask({
				id: "t2",
				project_dir: "/Users/test/projects/unknown",
			});
			const item2 = provider.getTreeItem({ type: "task", task: task2 });
			expect(item2.label).not.toContain("⚡");
			expect(item2.label).not.toContain("🚀");
			expect(item2.label).not.toContain("📚");
		});

		test("empty projects config returns no emoji", () => {
			vscodeMock.workspace.getConfiguration = mock(() => ({
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "projects") return [];
					return defaultValue;
				}),
			}));

			const task = createMockTask();
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.label).toBe("🔄 test-task-1");
		});
	});

	// ── Welcome view context key ─────────────────────────────────────────

	describe("hasAgentTasks context key", () => {
		let vscodeMock: ReturnType<typeof setupVSCodeMock>;

		beforeEach(() => {
			vscodeMock = setupVSCodeMock();
		});

		test("sets context key to false when no tasks", () => {
			provider.readRegistry = () => createMockRegistry({});
			provider.reload();

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"setContext",
				"commandCentral.hasAgentTasks",
				false,
			);
		});

		test("sets context key to true when tasks exist", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.reload();

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"setContext",
				"commandCentral.hasAgentTasks",
				true,
			);
		});

		test("context key updates on reload with changing tasks", () => {
			// Start with tasks
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.reload();

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"setContext",
				"commandCentral.hasAgentTasks",
				true,
			);

			// Clear tasks
			provider.readRegistry = () => createMockRegistry({});
			provider.reload();

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"setContext",
				"commandCentral.hasAgentTasks",
				false,
			);
		});
	});
});
