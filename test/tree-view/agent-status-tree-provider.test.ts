/**
 * AgentStatusTreeProvider Tests
 *
 * Tests the tree provider with mock task registry data.
 * Verifies: tree structure, status icons, elapsed time formatting,
 * child nodes (details), sorting, and edge cases.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";

// Mock port-detector to avoid real lsof calls in tree provider tests
const mockDetectListeningPorts = mock(
	() => [] as Array<{ port: number; pid: number; process: string }>,
);
mock.module("../../src/utils/port-detector.js", () => ({
	detectListeningPorts: mockDetectListeningPorts,
}));

import {
	type AgentNode,
	type AgentRole,
	AgentStatusTreeProvider,
	type AgentTask,
	detectAgentType,
	formatElapsed,
	type GitInfo,
	getAgentTypeIcon,
	getStatusThemeIcon,
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
		started_at: new Date(Date.now() - 60_000).toISOString(),
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

describe("agent type detection + icons", () => {
	test("detects backend/CLI hints first", () => {
		expect(detectAgentType({ agent_backend: "claude" })).toBe("claude");
		expect(detectAgentType({ cli_name: "codex" })).toBe("codex");
		expect(detectAgentType({ process_name: "gemini" })).toBe("gemini");
	});

	test("falls back to command/model hints", () => {
		expect(
			detectAgentType({
				command: "/usr/local/bin/codex --model gpt-5 --print hello",
			}),
		).toBe("codex");
		expect(detectAgentType({ model: "claude-3.7-sonnet" })).toBe("claude");
		expect(detectAgentType({ model: "gemini-2.5-pro" })).toBe("gemini");
		expect(detectAgentType({ id: "unknown-task" })).toBe("unknown");
	});

	test("returns hubot icon with expected color mapping", () => {
		const claudeIcon = getAgentTypeIcon({ cli_name: "claude" }) as {
			id: string;
			color?: { id: string };
		};
		const codexIcon = getAgentTypeIcon({
			command: "/opt/homebrew/bin/codex run",
		}) as {
			id: string;
			color?: { id: string };
		};
		const geminiIcon = getAgentTypeIcon({ model: "gemini-2.5-pro" }) as {
			id: string;
			color?: { id: string };
		};
		const unknownIcon = getAgentTypeIcon({}) as {
			id: string;
			color?: { id: string };
		};

		expect(claudeIcon.id).toBe("hubot");
		expect(claudeIcon.color?.id).toBe("charts.purple");
		expect(codexIcon.id).toBe("hubot");
		expect(codexIcon.color?.id).toBe("charts.green");
		expect(geminiIcon.id).toBe("hubot");
		expect(geminiIcon.color?.id).toBe("charts.blue");
		expect(unknownIcon.id).toBe("hubot");
		expect(unknownIcon.color).toBeUndefined();
	});
});

describe("status icon mapping", () => {
	test("returns expected ThemeIcon + color for each status", () => {
		const cases = [
			["running", "sync~spin", "charts.yellow"],
			["completed", "check", "charts.green"],
			["completed_stale", "check-all", "charts.green"],
			["failed", "error", "charts.red"],
			["contract_failure", "warning", "charts.orange"],
			["stopped", "debug-stop", "charts.purple"],
			["killed", "close", "charts.red"],
		] as const;

		for (const [status, expectedIcon, expectedColor] of cases) {
			const icon = getStatusThemeIcon(status) as {
				id: string;
				color?: { id: string };
			};
			expect(icon.id).toBe(expectedIcon);
			expect(icon.color?.id).toBe(expectedColor);
		}
	});
});

// ── TreeProvider tests ───────────────────────────────────────────────

describe("AgentStatusTreeProvider", () => {
	let provider: AgentStatusTreeProvider;
	let vscodeMock: ReturnType<typeof setupVSCodeMock>;

	beforeEach(() => {
		mock.restore();
		vscodeMock = setupVSCodeMock();
		vscodeMock.workspace.getConfiguration = mock(() => ({
			update: mock(),
			get: mock((_key: string, defaultValue?: unknown) => {
				if (_key === "agentStatus.groupByProject") return false;
				return defaultValue;
			}),
		}));
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

	test("groups root tasks by project name alphabetically when enabled", () => {
		vscodeMock.workspace.getConfiguration = mock(() => ({
			update: mock(),
			get: mock((_key: string, defaultValue?: unknown) => {
				if (_key === "agentStatus.groupByProject") return true;
				return defaultValue;
			}),
		}));

		const zetaTask = createMockTask({
			id: "zeta-1",
			project_name: "Zeta",
			started_at: "2026-02-25T06:00:00Z",
		});
		const alphaTask = createMockTask({
			id: "alpha-1",
			project_name: "Alpha",
			started_at: "2026-02-25T07:00:00Z",
		});
		provider.readRegistry = () =>
			createMockRegistry({ "zeta-1": zetaTask, "alpha-1": alphaTask });
		provider.reload();

		const children = provider.getChildren();
		const projectGroups = children.filter((n) => n.type === "projectGroup");
		expect(projectGroups).toHaveLength(2);
		expect(
			(projectGroups[0] as { type: "projectGroup"; projectName: string })
				.projectName,
		).toBe("Alpha");
		expect(
			(projectGroups[1] as { type: "projectGroup"; projectName: string })
				.projectName,
		).toBe("Zeta");
	});

	test("returns grouped project children as task nodes sorted chronologically", () => {
		vscodeMock.workspace.getConfiguration = mock(() => ({
			update: mock(),
			get: mock((_key: string, defaultValue?: unknown) => {
				if (_key === "agentStatus.groupByProject") return true;
				return defaultValue;
			}),
		}));

		const older = createMockTask({
			id: "alpha-old",
			project_name: "Alpha",
			started_at: "2026-02-25T06:00:00Z",
		});
		const newer = createMockTask({
			id: "alpha-new",
			project_name: "Alpha",
			started_at: "2026-02-25T09:00:00Z",
		});
		provider.readRegistry = () =>
			createMockRegistry({ "alpha-old": older, "alpha-new": newer });
		provider.reload();

		const rootChildren = provider.getChildren();
		const groupNode = rootChildren.find(
			(node) => node.type === "projectGroup",
		) as { type: "projectGroup"; projectName: string; tasks: AgentTask[] };
		expect(groupNode.projectName).toBe("Alpha");

		const groupChildren = provider.getChildren(groupNode);
		expect(groupChildren).toHaveLength(2);
		expect(
			(groupChildren[0] as { type: "task"; task: AgentTask }).task.id,
		).toBe("alpha-new");
		expect(
			(groupChildren[1] as { type: "task"; task: AgentTask }).task.id,
		).toBe("alpha-old");
	});

	test("filters root tasks to running only when config is enabled", () => {
		const running = createMockTask({ id: "running-1", status: "running" });
		const completed = createMockTask({ id: "done-1", status: "completed" });
		provider.readRegistry = () =>
			createMockRegistry({ "running-1": running, "done-1": completed });
		provider.reload();

		vscodeMock.workspace.getConfiguration = mock(() => ({
			update: mock(),
			get: mock((_key: string, defaultValue?: unknown) => {
				if (_key === "agentStatus.showOnlyRunning") return true;
				if (_key === "agentStatus.groupByProject") return false;
				return defaultValue;
			}),
		}));

		const children = provider.getChildren();
		const taskNodes = getTaskNodes(children);
		expect(taskNodes).toHaveLength(1);
		expect((taskNodes[0] as { type: "task"; task: AgentTask }).task.id).toBe(
			"running-1",
		);
	});

	test("shows 'No running agents' state when running filter is enabled", () => {
		const completed = createMockTask({ id: "done-1", status: "completed" });
		provider.readRegistry = () => createMockRegistry({ "done-1": completed });
		provider.reload();

		vscodeMock.workspace.getConfiguration = mock(() => ({
			update: mock(),
			get: mock((_key: string, defaultValue?: unknown) => {
				if (_key === "agentStatus.showOnlyRunning") return true;
				if (_key === "agentStatus.groupByProject") return false;
				return defaultValue;
			}),
		}));

		const children = provider.getChildren();
		expect(children).toHaveLength(1);
		expect(children[0]?.type).toBe("state");
		if (children[0]?.type === "state") {
			expect(children[0].label).toContain("No running agents");
		}
	});

	test("returns detail nodes for task children", () => {
		// Use completed status to avoid async port detection adding "detecting..." node
		const task = createMockTask({ status: "completed", exit_code: 0 });
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		// Mock out git info, diff, and prompt to test base detail structure
		provider.getGitInfo = () => null;
		provider.getDiffSummary = () => null;
		provider.readPromptSummary = () => "mock summary";
		provider.reload();

		const root = provider.getChildren();
		const firstTask = getFirstTask(root);
		const details = provider.getChildren(firstTask);
		// Should have: Prompt + Result (completed with exit_code, no git, no diff, no PR)
		expect(details).toHaveLength(2);
		expect(details.every((d) => d.type === "detail")).toBe(true);
	});

	test("includes PR detail when pr_number is set", () => {
		// Use completed status to avoid async port detection
		const task = createMockTask({
			status: "completed",
			exit_code: 0,
			pr_number: 42,
			review_status: "approved",
		});
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		// Mock out git info, diff, and prompt to test PR detail specifically
		provider.getGitInfo = () => null;
		provider.getDiffSummary = () => null;
		provider.readPromptSummary = () => "mock summary";
		provider.reload();

		const root = provider.getChildren();
		const firstTask = getFirstTask(root);
		const details = provider.getChildren(firstTask);
		expect(details).toHaveLength(3); // Prompt + Result + PR
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
		// Status emoji removed from label (ThemeIcon iconPath shows status instead)
		expect(item.label).toContain("test-task-1");
		expect(item.collapsibleState).toBe(1); // Collapsed
	});

	test("getTreeItem creates non-collapsible item for details", () => {
		const node: AgentNode = {
			type: "detail",
			label: "Prompt",
			value: "Some prompt summary",
			taskId: "t1",
		};
		const item = provider.getTreeItem(node);
		expect(item.label).toContain("Prompt: Some prompt summary");
		expect(item.collapsibleState).toBe(0); // None
	});

	test("getTreeItem creates expanded folder item for project groups", () => {
		const node: AgentNode = {
			type: "projectGroup",
			projectName: "Alpha",
			tasks: [createMockTask({ id: "alpha-1", project_name: "Alpha" })],
		};
		const item = provider.getTreeItem(node);
		expect(item.label).toBe("Alpha");
		expect(item.description).toBe("1 agents");
		expect(item.collapsibleState).toBe(2); // Expanded
		expect((item.iconPath as { id: string }).id).toBe("folder");
		expect(item.contextValue).toBe("projectGroup");
	});

	test("launcher task icons are mapped by status", () => {
		const cases = [
			["running", "sync~spin", "charts.yellow"],
			["completed", "check", "charts.green"],
			["completed_stale", "check-all", "charts.green"],
			["failed", "error", "charts.red"],
			["contract_failure", "warning", "charts.orange"],
			["stopped", "debug-stop", "charts.purple"],
			["killed", "close", "charts.red"],
		] as const;

		for (const [status, expectedIcon, expectedColor] of cases) {
			const task = createMockTask({
				status,
			});
			const node: AgentNode = { type: "task", task };
			const item = provider.getTreeItem(node);
			const icon = item.iconPath as { id: string; color?: { id: string } };
			expect(icon.id).toBe(expectedIcon);
			expect(icon.color?.id).toBe(expectedColor);
		}
	});

	test("discovered agent icons use running status mapping", () => {
		const agent = {
			pid: 77777,
			projectDir: "/Users/test/projects/my-app",
			startTime: new Date("2026-02-25T08:00:00Z"),
			source: "process" as const,
			command: "claude",
		};
		const item = provider.getTreeItem({ type: "discovered", agent });
		const icon = item.iconPath as { id: string; color?: { id: string } };
		expect(icon.id).toBe("sync~spin");
		expect(icon.color?.id).toBe("charts.yellow");
	});

	test("summary icon is red when any failed/killed task exists", () => {
		const running = createMockTask({ id: "t1", status: "running" });
		const failed = createMockTask({ id: "t2", status: "failed" });
		provider.readRegistry = () =>
			createMockRegistry({ t1: running, t2: failed });
		provider.reload();

		const summary = provider.getChildren().find((n) => n.type === "summary")!;
		const item = provider.getTreeItem(summary);
		const icon = item.iconPath as { id: string; color?: { id: string } };
		expect(icon.id).toBe("error");
		expect(icon.color?.id).toBe("charts.red");
	});

	test("summary icon is yellow when running and no failures", () => {
		const running = createMockTask({ id: "t1", status: "running" });
		const completed = createMockTask({ id: "t2", status: "completed" });
		provider.readRegistry = () =>
			createMockRegistry({ t1: running, t2: completed });
		provider.reload();

		const summary = provider.getChildren().find((n) => n.type === "summary")!;
		const item = provider.getTreeItem(summary);
		const icon = item.iconPath as { id: string; color?: { id: string } };
		expect(icon.id).toBe("sync~spin");
		expect(icon.color?.id).toBe("charts.yellow");
	});

	test("summary icon is green when all tasks are completed/completed_stale", () => {
		const completed = createMockTask({ id: "t1", status: "completed" });
		const stale = createMockTask({ id: "t2", status: "completed_stale" });
		provider.readRegistry = () =>
			createMockRegistry({ t1: completed, t2: stale });
		provider.reload();

		const summary = provider.getChildren().find((n) => n.type === "summary")!;
		const item = provider.getTreeItem(summary);
		const icon = item.iconPath as { id: string; color?: { id: string } };
		expect(icon.id).toBe("check-all");
		expect(icon.color?.id).toBe("charts.green");
	});

	test("summary icon is orange for contract failure when no running/failed", () => {
		const contractFailure = createMockTask({
			id: "t1",
			status: "contract_failure",
		});
		provider.readRegistry = () => createMockRegistry({ t1: contractFailure });
		provider.reload();

		const summary = provider.getChildren().find((n) => n.type === "summary")!;
		const item = provider.getTreeItem(summary);
		const icon = item.iconPath as { id: string; color?: { id: string } };
		expect(icon.id).toBe("warning");
		expect(icon.color?.id).toBe("charts.orange");
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
			label: "Prompt",
			value: "some summary",
			taskId: "test-task-1",
		});
		expect(parent?.type).toBe("task");
	});

	test("appends file-change children after existing detail children", () => {
		const task = createMockTask({ status: "completed", exit_code: 0 });
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.getGitInfo = () => null;
		provider.getDiffSummary = () => null;
		provider.readPromptSummary = () => "mock summary";
		provider.getPerFileDiffs = () => [
			{ filePath: "src/feature/a.ts", additions: 12, deletions: 3 },
			{ filePath: "test/feature/a.test.ts", additions: 7, deletions: 1 },
		];
		provider.reload();

		const root = provider.getChildren();
		const firstTask = getFirstTask(root);
		const children = provider.getChildren(firstTask);
		expect(children.map((c) => c.type)).toEqual([
			"detail",
			"detail",
			"fileChange",
			"fileChange",
		]);
	});

	test("file-change tree item shows basename, +/- stats, tooltip, and command", () => {
		const task = createMockTask({ status: "completed", exit_code: 0 });
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.getGitInfo = () => null;
		provider.getDiffSummary = () => null;
		provider.readPromptSummary = () => "mock summary";
		provider.getPerFileDiffs = () => [
			{
				filePath: "src/providers/agent-status-tree-provider.ts",
				additions: 5,
				deletions: 2,
			},
		];
		provider.reload();

		const root = provider.getChildren();
		const firstTask = getFirstTask(root);
		const children = provider.getChildren(firstTask);
		const fileNode = children.find((c) => c.type === "fileChange");
		expect(fileNode).toBeDefined();
		const item = provider.getTreeItem(fileNode!);

		expect(item.label).toBe("agent-status-tree-provider.ts");
		expect(item.description).toBe("+5 -2");
		expect(item.tooltip).toBe(
			"/Users/test/projects/my-app/src/providers/agent-status-tree-provider.ts",
		);
		expect(item.contextValue).toBe("agentFileChange");
		expect(item.command?.command).toBe("commandCentral.openFileDiff");
	});

	test("binary file-change tree item uses binary description", () => {
		const task = createMockTask({ status: "completed", exit_code: 0 });
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.getGitInfo = () => null;
		provider.getDiffSummary = () => null;
		provider.readPromptSummary = () => "mock summary";
		provider.getPerFileDiffs = () => [
			{ filePath: "assets/logo.png", additions: -1, deletions: -1 },
		];
		provider.reload();

		const root = provider.getChildren();
		const firstTask = getFirstTask(root);
		const children = provider.getChildren(firstTask);
		const fileNode = children.find((c) => c.type === "fileChange");
		expect(fileNode).toBeDefined();
		const item = provider.getTreeItem(fileNode!);
		expect(item.description).toBe("binary");
	});

	test("getParent returns task node for file-change child", () => {
		const task = createMockTask({ status: "completed", exit_code: 0 });
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.reload();

		const parent = provider.getParent({
			type: "fileChange",
			taskId: "test-task-1",
			projectDir: task.project_dir,
			filePath: "src/file.ts",
			additions: 1,
			deletions: 0,
			taskStatus: "completed",
			startCommit: "HEAD~1",
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
		// No status emoji in label, no role icon — just the task ID
		expect(item.label).toBe("test-task-1");
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

	test("shows Error detail node first for failed tasks with exit code", () => {
		const task = createMockTask({
			status: "failed",
			exit_code: 127,
			attempts: 2,
			max_attempts: 3,
			error_message: "build failed: missing env var",
		});
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.getDiffSummary = () => null;
		provider.getGitInfo = () => null;
		provider.readPromptSummary = () => "mock summary";
		provider.reload();

		const root = provider.getChildren();
		const firstTask = getFirstTask(root);
		const details = provider.getChildren(firstTask);
		const errorDetail = details[0];
		expect(errorDetail?.type).toBe("detail");
		if (errorDetail?.type === "detail") {
			expect(errorDetail.label).toBe("Error: Exit 127 · 2/3 attempts");
			expect(errorDetail.description).toBe("build failed: missing env var");
			const treeItem = provider.getTreeItem(errorDetail);
			expect((treeItem.iconPath as { id: string }).id).toBe("error");
			expect((treeItem.iconPath as { color: { id: string } }).color.id).toBe(
				"charts.red",
			);
			expect(treeItem.description).toBe("build failed: missing env var");
		}
	});

	test("omits attempts suffix in Error detail when attempts is 1", () => {
		const task = createMockTask({
			status: "failed",
			exit_code: 2,
			attempts: 1,
			max_attempts: 3,
		});
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.getDiffSummary = () => null;
		provider.getGitInfo = () => null;
		provider.readPromptSummary = () => "mock summary";
		provider.reload();

		const root = provider.getChildren();
		const firstTask = getFirstTask(root);
		const details = provider.getChildren(firstTask);
		const errorDetail = details[0];
		expect(errorDetail?.type).toBe("detail");
		if (errorDetail?.type === "detail") {
			expect(errorDetail.label).toBe("Error: Exit 2");
		}
	});

	test("omits Result detail for running tasks", () => {
		const task = createMockTask({ status: "running" });
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.getDiffSummary = () => null;
		provider.getGitInfo = () => null;
		provider.reload();

		const root = provider.getChildren();
		const firstTask = getFirstTask(root);
		const details = provider.getChildren(firstTask);
		const resultDetail = details.find(
			(d) => d.type === "detail" && d.label === "Result",
		);
		expect(resultDetail).toBeUndefined();
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

	test("detail children no longer include Session node", () => {
		const task = createMockTask();
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.getDiffSummary = () => null;
		provider.getGitInfo = () => null;
		provider.reload();
		const root = provider.getChildren();
		const firstTask = getFirstTask(root);
		const details = provider.getChildren(firstTask);
		const sessionDetail = details.find(
			(d) => d.type === "detail" && d.label === "Session",
		);
		expect(sessionDetail).toBeUndefined();
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

	describe("stuck agent detection", () => {
		test("isAgentStuck returns false for non-running agents", () => {
			const task = createMockTask({
				id: "stuck-not-running",
				status: "completed",
				started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
			});
			expect(provider.isAgentStuck(task)).toBe(false);
		});

		test("isAgentStuck returns false for recent running agents", () => {
			const task = createMockTask({
				id: "stuck-recent-running",
				status: "running",
				started_at: new Date(Date.now() - 2 * 60_000).toISOString(),
			});
			expect(provider.isAgentStuck(task)).toBe(false);
		});

		test("isAgentStuck returns true for old running agents with no stream file", () => {
			const task = createMockTask({
				id: "stuck-old-no-stream",
				status: "running",
				started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
			});
			expect(provider.isAgentStuck(task)).toBe(true);
		});

		test("isAgentStuck returns false when stream file has recent activity", () => {
			const task = createMockTask({
				id: "stuck-stream-recent",
				status: "running",
				agent_backend: "codex",
				started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
			});
			const streamFile = `/tmp/codex-stream-${task.id}.jsonl`;
			try {
				fs.writeFileSync(streamFile, '{"type":"turn"}\n', "utf-8");
				const recent = new Date(Date.now() - 2 * 60_000);
				fs.utimesSync(streamFile, recent, recent);
				expect(provider.isAgentStuck(task)).toBe(false);
			} finally {
				if (fs.existsSync(streamFile)) fs.unlinkSync(streamFile);
			}
		});

		test("isAgentStuck returns true when stream file is old", () => {
			const task = createMockTask({
				id: "stuck-stream-old",
				status: "running",
				agent_backend: "codex",
				started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
			});
			const streamFile = `/tmp/codex-stream-${task.id}.jsonl`;
			try {
				fs.writeFileSync(streamFile, '{"type":"turn"}\n', "utf-8");
				const old = new Date(Date.now() - 30 * 60_000);
				fs.utimesSync(streamFile, old, old);
				expect(provider.isAgentStuck(task)).toBe(true);
			} finally {
				if (fs.existsSync(streamFile)) fs.unlinkSync(streamFile);
			}
		});

		test("stuck running agents use warning icon and warning detail", () => {
			const task = createMockTask({
				id: "stuck-visual",
				status: "running",
				started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.getDiffSummary = () => null;
			provider.getGitInfo = () => null;
			provider.reload();

			const item = provider.getTreeItem({ type: "task", task });
			const icon = item.iconPath as { id: string; color?: { id: string } };
			expect(icon.id).toBe("warning");
			expect(icon.color?.id).toBe("charts.yellow");
			expect(item.description).toContain("(possibly stuck)");

			const root = provider.getChildren();
			const taskNode = getFirstTask(root);
			const children = provider.getChildren(taskNode);
			const warningDetail = children.find(
				(child) =>
					child.type === "detail" &&
					child.label.includes("No activity for 15 minutes"),
			);
			expect(warningDetail).toBeDefined();
		});
	});

	test("non-running task TreeItem routes to resumeAgentSession", () => {
		const task = createMockTask({ status: "completed" });
		const node: AgentNode = { type: "task", task };
		const item = provider.getTreeItem(node);
		expect(item.command?.command).toBe("commandCentral.resumeAgentSession");
		expect(item.command?.title).toBe("Resume Session");
	});

	test("stopped task TreeItem routes to resumeAgentSession", () => {
		const task = createMockTask({ status: "stopped" });
		const node: AgentNode = { type: "task", task };
		const item = provider.getTreeItem(node);
		expect(item.command?.command).toBe("commandCentral.resumeAgentSession");
	});

	test("failed task TreeItem routes to resumeAgentSession", () => {
		const task = createMockTask({ status: "failed" });
		const node: AgentNode = { type: "task", task };
		const item = provider.getTreeItem(node);
		expect(item.command?.command).toBe("commandCentral.resumeAgentSession");
	});

	test("running task TreeItem routes to focusAgentTerminal", () => {
		const task = createMockTask({ status: "running" });
		const node: AgentNode = { type: "task", task };
		const item = provider.getTreeItem(node);
		expect(item.command?.command).toBe("commandCentral.focusAgentTerminal");
		expect(item.command?.title).toBe("Focus Terminal");
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
		test("merged Git detail node appears when getGitInfo returns data", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => null;
			provider.getGitInfo = (_dir: string): GitInfo | null => ({
				branch: "feature/my-branch",
				lastCommit: "abc1234 fix: something (2m ago)",
			});
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const gitDetail = details.find(
				(d) => d.type === "detail" && d.label === "Git",
			);
			expect(gitDetail).toBeDefined();
			if (gitDetail?.type === "detail") {
				expect(gitDetail.value).toBe("feature/my-branch → abc1234");
			}
		});

		test("graceful fallback when git info is null (non-git dir)", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => null;
			provider.getGitInfo = (_dir: string): GitInfo | null => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const gitDetail = details.find(
				(d) => d.type === "detail" && d.label === "Git",
			);
			expect(gitDetail).toBeUndefined();
		});

		test("Git detail shows branch → hash format", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => null;
			provider.getGitInfo = (_dir: string): GitInfo | null => ({
				branch: "main",
				lastCommit: "def5678 chore: update deps (5h ago)",
			});
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const gitItem = provider.getTreeItem(
				details.find((d) => d.type === "detail" && d.label === "Git")!,
			);
			expect(gitItem.label).toBe("Git: main → def5678");
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
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "agentStatus.notifications") return true;
					if (_key === "onCompletion") return true;
					if (_key === "onFailure") return true;
					if (_key === "sound") return false;
					if (_key === "agentStatus.groupByProject") return false;
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

		test("completed notification includes diff summary text and new action buttons", () => {
			provider.getDiffSummary = () => "3 files · +45 / -12";
			const reveal = mock(() => Promise.resolve());
			provider.setTreeView({ reveal } as any);

			// Set up running state
			const runningTask = createMockTask({
				id: "t1",
				status: "running",
				agent_backend: "codex",
			});
			provider.readRegistry = () => createMockRegistry({ t1: runningTask });
			provider.reload();

			// Transition to completed
			const completedTask = createMockTask({
				id: "t1",
				status: "completed",
				agent_backend: "codex",
				exit_code: 0,
			});
			provider.readRegistry = () => createMockRegistry({ t1: completedTask });
			provider.reload();

			expect(vscodeMock.window.showInformationMessage).toHaveBeenCalled();
			const infoCallArgs = (
				vscodeMock.window.showInformationMessage as ReturnType<typeof mock>
			).mock.calls[0] as string[] | undefined;
			expect(infoCallArgs?.[0]).toContain("✅ t1 completed");
			expect(infoCallArgs?.[0]).toContain("3 files · +45 -12");
			expect(infoCallArgs?.[0]).toContain("[codex]");
			expect(infoCallArgs?.[0]).toContain("exit 0");
			expect(infoCallArgs?.[1]).toBe("Review Diff");
			expect(infoCallArgs?.[2]).toBe("Show Output");
			expect(infoCallArgs?.[3]).toBe("Focus Terminal");

			expect(reveal).toHaveBeenCalled();
			const revealCall = reveal.mock.calls[0] as
				| [unknown, { select?: boolean; focus?: boolean }]
				| undefined;
			expect(revealCall?.[1]).toEqual({ select: true, focus: false });
		});

		test("failed notification includes exit code and new action buttons", () => {
			// Set up running state
			const runningTask = createMockTask({
				id: "t2",
				status: "running",
				agent_backend: "gemini",
			});
			provider.readRegistry = () => createMockRegistry({ t2: runningTask });
			provider.reload();

			// Transition to failed
			const failedTask = createMockTask({
				id: "t2",
				status: "failed",
				agent_backend: "gemini",
				exit_code: 42,
				error_message: "lint failed: missing semicolon",
			});
			provider.readRegistry = () => createMockRegistry({ t2: failedTask });
			provider.reload();

			expect(vscodeMock.window.showWarningMessage).toHaveBeenCalled();
			const callArgs = (
				vscodeMock.window.showWarningMessage as ReturnType<typeof mock>
			).mock.calls[0] as string[] | undefined;
			expect(callArgs?.[0]).toContain("❌ t2 failed");
			expect(callArgs?.[0]).toContain("exit 42");
			expect(callArgs?.[0]).toContain("[gemini]");
			expect(callArgs?.[1]).toBe("Show Output");
			expect(callArgs?.[2]).toBe("Review Diff");
			expect(callArgs?.[3]).toBe("Restart");
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

		test("notification respects master toggle when disabled", () => {
			// Override config to disable notifications
			vscodeMock.workspace.getConfiguration = mock(() => ({
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "agentStatus.notifications") return false;
					if (_key === "onCompletion") return true;
					if (_key === "onFailure") return true;
					if (_key === "agentStatus.groupByProject") return false;
					return defaultValue;
				}),
			}));

			const runningTask = createMockTask({ id: "t5", status: "running" });
			provider.readRegistry = () => createMockRegistry({ t5: runningTask });
			provider.reload();

			const transitionedTask = createMockTask({ id: "t5", status: "failed" });
			provider.readRegistry = () =>
				createMockRegistry({ t5: transitionedTask });
			provider.reload();

			expect(
				(vscodeMock.window.showInformationMessage as ReturnType<typeof mock>)
					.mock.calls.length,
			).toBe(0);
			expect(
				(vscodeMock.window.showWarningMessage as ReturnType<typeof mock>).mock
					.calls.length,
			).toBe(0);
		});

		test("all running terminal transitions fire notifications", () => {
			provider.getDiffSummary = () => "2 files · +10 / -3";
			const running = {
				c: createMockTask({
					id: "c",
					status: "running",
					agent_backend: "codex",
				}),
				f: createMockTask({
					id: "f",
					status: "running",
					agent_backend: "gemini",
				}),
				s: createMockTask({
					id: "s",
					status: "running",
					agent_backend: "claude",
				}),
				k: createMockTask({
					id: "k",
					status: "running",
					agent_backend: "codex",
				}),
			};
			provider.readRegistry = () =>
				createMockRegistry({
					c: running.c,
					f: running.f,
					s: running.s,
					k: running.k,
				});
			provider.reload();

			provider.readRegistry = () =>
				createMockRegistry({
					c: createMockTask({
						id: "c",
						status: "completed",
						agent_backend: "codex",
						exit_code: 0,
					}),
					f: createMockTask({
						id: "f",
						status: "failed",
						agent_backend: "gemini",
						exit_code: 1,
					}),
					s: createMockTask({
						id: "s",
						status: "stopped",
						agent_backend: "claude",
					}),
					k: createMockTask({
						id: "k",
						status: "killed",
						agent_backend: "codex",
					}),
				});
			provider.reload();

			const infoCalls = (
				vscodeMock.window.showInformationMessage as ReturnType<typeof mock>
			).mock.calls as unknown[][];
			const warningCalls = (
				vscodeMock.window.showWarningMessage as ReturnType<typeof mock>
			).mock.calls as unknown[][];

			expect(infoCalls).toHaveLength(2);
			expect(warningCalls).toHaveLength(2);

			const infoMessages = infoCalls.map((c) => String(c[0]));
			const warningMessages = warningCalls.map((c) => String(c[0]));
			expect(infoMessages.some((m) => m.includes("✅ c completed"))).toBe(true);
			expect(infoMessages.some((m) => m.includes("⏹️ s stopped"))).toBe(true);
			expect(warningMessages.some((m) => m.includes("❌ f failed"))).toBe(true);
			expect(warningMessages.some((m) => m.includes("💀 k killed"))).toBe(true);
		});
	});

	// ── Phase 4, Feature 1: Port Detection Detail Nodes ──────────────

	describe("port detection in tree", () => {
		beforeEach(() => {
			mockDetectListeningPorts.mockReset();
		});

		test("ports detail node appears for running tasks with ports", () => {
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			// Pre-populate port cache to simulate completed async detection
			const portCache = (
				provider as unknown as {
					_portCache: Map<
						string,
						Array<{ port: number; pid: number; process: string }>
					>;
				}
			)._portCache;
			portCache.set("test-task-1", [
				{ port: 3000, pid: 1234, process: "node" },
			]);
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
			provider.getDiffSummary = () => null;
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

		test("no ports detail when port cache is empty array", () => {
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			// Pre-populate port cache with empty result (async detection completed, found nothing)
			const portCache = (
				provider as unknown as {
					_portCache: Map<
						string,
						Array<{ port: number; pid: number; process: string }>
					>;
				}
			)._portCache;
			portCache.set("test-task-1", []);
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
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			// Pre-populate port cache with multiple ports
			const portCache = (
				provider as unknown as {
					_portCache: Map<
						string,
						Array<{ port: number; pid: number; process: string }>
					>;
				}
			)._portCache;
			portCache.set("test-task-1", [
				{ port: 3000, pid: 1234, process: "node" },
				{ port: 8080, pid: 5678, process: "python3" },
			]);
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
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "projects") return [{ name: "my-app", emoji: "🚀" }];
					if (_key === "agentStatus.groupByProject") return false;
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
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "projects")
						return [{ name: "other-project", emoji: "🎨" }];
					if (_key === "agentStatus.groupByProject") return false;
					return defaultValue;
				}),
			}));

			const task = createMockTask({
				project_dir: "/Users/test/projects/my-app",
			});
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.label).not.toContain("🎨");
			expect(item.label).toBe("test-task-1");
		});

		test("config with multiple projects works correctly", () => {
			vscodeMock.workspace.getConfiguration = mock(() => ({
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "projects")
						return [
							{ name: "my-app", emoji: "🚀" },
							{ name: "api-server", emoji: "⚡" },
							{ name: "docs", emoji: "📚" },
						];
					if (_key === "agentStatus.groupByProject") return false;
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
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "projects") return [];
					if (_key === "agentStatus.groupByProject") return false;
					return defaultValue;
				}),
			}));

			const task = createMockTask();
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.label).toBe("test-task-1");
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

	// ── M2.5 Phase 1: Sidebar Redesign ──────────────────────────────

	describe("readPromptSummary", () => {
		test("returns cached value when prompt cache is populated", () => {
			const p = provider as unknown as { _promptCache: Map<string, string> };
			p._promptCache.clear();
			p._promptCache.set("/tmp/test.md", "Cached summary text");
			expect(provider.readPromptSummary("/tmp/test.md")).toBe(
				"Cached summary text",
			);
		});

		test("returns filename for nonexistent file", () => {
			const p = provider as unknown as { _promptCache: Map<string, string> };
			p._promptCache.clear();
			expect(provider.readPromptSummary("/nonexistent/path/spec.md")).toBe(
				"spec.md",
			);
		});

		test("caches results (second call returns same value)", () => {
			const p = provider as unknown as { _promptCache: Map<string, string> };
			p._promptCache.clear();
			// First call for nonexistent file caches the filename
			const first = provider.readPromptSummary("/no/such/file/task.md");
			const second = provider.readPromptSummary("/no/such/file/task.md");
			expect(first).toBe(second);
			expect(second).toBe("task.md");
		});

		test("getDetailChildren shows prompt summary not raw file path", () => {
			// Use readPromptSummary override to avoid fs mock pollution in full suite
			provider.readPromptSummary = () => "Implement the widget factory";
			const task = createMockTask({
				status: "completed",
				exit_code: 0,
				prompt_file: "/tmp/some-spec.md",
			});
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const promptDetail = details.find(
				(d) => d.type === "detail" && d.label === "Prompt",
			);
			expect(promptDetail).toBeDefined();
			if (promptDetail?.type === "detail") {
				expect(promptDetail.value).toBe("Implement the widget factory");
				expect(promptDetail.value).not.toContain("/tmp/");
			}
		});
	});

	describe("getDiffSummary", () => {
		test("parses git diff --stat summary line correctly", () => {
			const { execFileSync: _execFileSync } = require("node:child_process");
			// Mock execFileSync via provider method override
			const task = createMockTask({ status: "completed" });
			provider.getDiffSummary = (_dir: string, _t: AgentTask) => {
				// Simulate parsing
				const output =
					" file1.ts | 10 ++++---\n file2.ts | 5 ++--\n 2 files changed, 8 insertions(+), 5 deletions(-)";
				const summaryLine = output.split("\n").pop() ?? "";
				const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/);
				const insertMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/);
				const deleteMatch = summaryLine.match(/(\d+)\s+deletions?\(-\)/);
				if (!filesMatch) return null;
				const files = filesMatch[1];
				const insertions = insertMatch?.[1] ?? "0";
				const deletions = deleteMatch?.[1] ?? "0";
				return `${files} files · +${insertions} / -${deletions}`;
			};
			expect(provider.getDiffSummary("/test", task)).toBe("2 files · +8 / -5");
		});

		test("formats as 'N files · +X / -Y'", () => {
			const task = createMockTask({ status: "running" });
			provider.getDiffSummary = () => "4 files · +340 / -87";
			expect(provider.getDiffSummary("/test", task)).toBe(
				"4 files · +340 / -87",
			);
		});

		test("returns null on git failure", () => {
			// The real getDiffSummary catches errors and returns null
			// Test with non-existent directory
			const task = createMockTask({ status: "completed" });
			const result = provider.getDiffSummary(
				"/nonexistent/dir/that/does/not/exist",
				task,
			);
			expect(result).toBeNull();
		});

		test("detail children include Changes node when diff exists", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => "3 files · +100 / -20";
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const changesDetail = details.find(
				(d) => d.type === "detail" && d.label === "Changes",
			);
			expect(changesDetail).toBeDefined();
			if (changesDetail?.type === "detail") {
				expect(changesDetail.value).toBe("3 files · +100 / -20");
			}
		});

		test("detail children omit Changes node when no diff", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const changesDetail = details.find(
				(d) => d.type === "detail" && d.label === "Changes",
			);
			expect(changesDetail).toBeUndefined();
		});
	});

	describe("consolidated detail view", () => {
		test("detail children no longer include Worktree node", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const worktreeDetail = details.find(
				(d) => d.type === "detail" && d.label === "Worktree",
			);
			expect(worktreeDetail).toBeUndefined();
		});

		test("detail children include merged Git node with branch → hash", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => null;
			provider.getGitInfo = () => ({
				branch: "feature/sidebar",
				lastCommit: "a1b2c3d refactor: tree view (3m ago)",
			});
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const gitDetail = details.find(
				(d) => d.type === "detail" && d.label === "Git",
			);
			expect(gitDetail).toBeDefined();
			if (gitDetail?.type === "detail") {
				expect(gitDetail.value).toBe("feature/sidebar → a1b2c3d");
			}
		});

		test("Result node for completed tasks with exit code + attempts", () => {
			const task = createMockTask({
				status: "completed",
				exit_code: 0,
				attempts: 1,
				max_attempts: 3,
			});
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const resultDetail = details.find(
				(d) => d.type === "detail" && d.label === "Result",
			);
			expect(resultDetail).toBeDefined();
			if (resultDetail?.type === "detail") {
				expect(resultDetail.value).toBe("Exit 0 · Attempt 1/3");
			}
		});

		test("running tasks show Prompt, Changes, Git, Ports (no Result)", () => {
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => "2 files · +50 / -10";
			provider.getGitInfo = () => ({
				branch: "main",
				lastCommit: "abc1234 feat: stuff (1m ago)",
			});
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const labels = details.map((d) => (d.type === "detail" ? d.label : ""));
			expect(labels).toContain("Prompt");
			expect(labels).toContain("Changes");
			expect(labels).toContain("Git");
			expect(labels).not.toContain("Result");
			expect(labels).not.toContain("Worktree");
			expect(labels).not.toContain("Session");
		});

		test("discovered children no longer include Session node", () => {
			const agent = {
				pid: 12345,
				projectDir: "/Users/test/projects/my-app",
				startTime: new Date("2026-02-25T08:00:00Z"),
				source: "process" as const,
				sessionId: "some-session",
				model: "opus",
			};
			provider.getDiffSummary = () => null;
			const p = provider as unknown as {
				getDiscoveredChildren: (
					a: Record<string, unknown>,
				) => Array<{ type: string; label: string; value: string }>;
			};
			const details = p.getDiscoveredChildren(agent);
			const sessionDetail = details.find((d) => d.label === "Session");
			expect(sessionDetail).toBeUndefined();
		});
	});

	// ── M2.5-1: Discovered agent prompt display ──────────────────────

	describe("readDiscoveredPrompt", () => {
		test("returns null for agent with no sessionId and no cached file", () => {
			const agent = {
				pid: 99999,
				projectDir: "/tmp/nonexistent-project",
				startTime: new Date(),
				source: "process" as const,
				command: "claude --test",
			};
			const p = provider as unknown as {
				readDiscoveredPrompt: (a: typeof agent) => string | null;
			};
			expect(p.readDiscoveredPrompt(agent)).toBeNull();
		});

		test("returns cached value on second call", () => {
			const agent = {
				pid: 11111,
				projectDir: "/tmp/agent-project",
				startTime: new Date(),
				source: "process" as const,
				sessionId: "cached-session-id",
				command: "claude",
			};
			const p = provider as unknown as {
				readDiscoveredPrompt: (a: typeof agent) => string | null;
				_discoveredPromptCache: Map<string, string>;
			};
			// Pre-populate cache
			p._discoveredPromptCache.set("cached-session-id", "Cached prompt text");
			const result = p.readDiscoveredPrompt(agent);
			expect(result).toBe("Cached prompt text");
		});

		test("truncates long prompt to 60 chars with ellipsis", () => {
			const longPrompt = "A".repeat(80);
			const agent = {
				pid: 22222,
				projectDir: "/tmp/agent-project",
				startTime: new Date(),
				source: "process" as const,
				sessionId: "truncate-session",
				command: "claude",
			};
			const p = provider as unknown as {
				readDiscoveredPrompt: (a: typeof agent) => string | null;
				_discoveredPromptCache: Map<string, string>;
			};
			// Pre-populate cache with long string already truncated
			const truncated = `${longPrompt.substring(0, 60)}…`;
			p._discoveredPromptCache.set("truncate-session", truncated);
			const result = p.readDiscoveredPrompt(agent);
			expect(result).toBe(truncated);
			expect(result?.length).toBe(61); // 60 chars + ellipsis
		});

		test("discovered children show prompt detail when readDiscoveredPrompt returns text", () => {
			const agent = {
				pid: 33333,
				projectDir: "/Users/test/projects/my-app",
				startTime: new Date("2026-02-25T08:00:00Z"),
				source: "process" as const,
				sessionId: "test-session",
				model: "opus",
				command: "claude",
			};
			provider.getDiffSummary = () => null;
			const p = provider as unknown as {
				getDiscoveredChildren: (
					a: typeof agent,
				) => Array<{ type: string; label: string; value: string }>;
				readDiscoveredPrompt: (a: typeof agent) => string | null;
				_discoveredPromptCache: Map<string, string>;
			};
			// Inject a cached prompt so readDiscoveredPrompt returns it
			p._discoveredPromptCache.set("test-session", "Fix the auth bug");
			const details = p.getDiscoveredChildren(agent);
			const promptDetail = details.find((d) => d.label === "Prompt");
			expect(promptDetail).toBeDefined();
			expect(promptDetail?.value).toBe("Fix the auth bug");
		});

		test("discovered children omit prompt detail when readDiscoveredPrompt returns null", () => {
			const agent = {
				pid: 44444,
				projectDir: "/Users/test/projects/my-app",
				startTime: new Date("2026-02-25T08:00:00Z"),
				source: "process" as const,
				command: "claude",
			};
			provider.getDiffSummary = () => null;
			const p = provider as unknown as {
				getDiscoveredChildren: (
					a: typeof agent,
				) => Array<{ type: string; label: string; value: string }>;
				_discoveredPromptCache: Map<string, string>;
			};
			// Cache empty string so it returns null
			p._discoveredPromptCache.set("pid:44444", "");
			const details = p.getDiscoveredChildren(agent);
			const promptDetail = details.find((d) => d.label === "Prompt");
			expect(promptDetail).toBeUndefined();
		});
	});

	// ── M2.5-2: Inline diff summary on tree item description ─────────

	describe("inline diff summary on task item description", () => {
		test("task item description includes diff summary when available", () => {
			const task = createMockTask({ status: "running" });
			provider.getDiffSummary = () => "3 files · +120 / -45";
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).toContain("3 files · +120 / -45");
		});

		test("task item description excludes diff when getDiffSummary returns null", () => {
			const task = createMockTask({ status: "running" });
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).not.toContain("files");
			// Should still have project name and elapsed
			expect(item.description).toContain("My App");
		});

		test("task item description format: project · elapsed · diff", () => {
			const task = createMockTask({
				status: "running",
				project_name: "my-project",
				started_at: new Date().toISOString(),
			});
			provider.getDiffSummary = () => "1 files · +10 / -5";
			const item = provider.getTreeItem({ type: "task", task });
			const desc = item.description as string;
			expect(desc).toContain("my-project");
			expect(desc).toContain("1 files · +10 / -5");
		});

		test("discovered item description includes diff summary when available", () => {
			const agent = {
				pid: 55555,
				projectDir: "/Users/test/projects/my-app",
				startTime: new Date("2026-02-25T08:00:00Z"),
				source: "process" as const,
				command: "claude",
			};
			provider.getDiffSummary = () => "2 files · +30 / -10";
			const item = provider.getTreeItem({ type: "discovered", agent });
			expect(item.description).toContain("2 files · +30 / -10");
		});

		test("discovered item description excludes diff when getDiffSummary returns null", () => {
			const agent = {
				pid: 66666,
				projectDir: "/Users/test/projects/my-app",
				startTime: new Date("2026-02-25T08:00:00Z"),
				source: "process" as const,
				command: "claude",
			};
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "discovered", agent });
			expect(item.description).toContain("PID 66666");
			expect(item.description).not.toContain("files");
		});
	});

	describe("linked worktree display for discovered agents", () => {
		test("discovered item description includes branch worktree badge", () => {
			const agent = {
				pid: 77777,
				projectDir: "/Users/test/projects/my-app-feature-auth",
				startTime: new Date("2026-02-25T08:00:00Z"),
				source: "process" as const,
				command: "claude",
				worktree: {
					mainRepoDir: "/Users/test/projects/my-app",
					worktreeDir: "/Users/test/projects/my-app-feature-auth",
					branch: "feature/auth",
					isLinkedWorktree: true,
				},
			};
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "discovered", agent });
			expect(item.description).toContain("feature/auth · worktree");
		});

		test("discovered children include Worktree detail node for linked worktrees", () => {
			const agent = {
				pid: 88888,
				projectDir: "/Users/test/projects/my-app-feature-auth",
				startTime: new Date("2026-02-25T08:00:00Z"),
				source: "process" as const,
				command: "claude",
				worktree: {
					mainRepoDir: "/Users/test/projects/my-app",
					worktreeDir: "/Users/test/projects/my-app-feature-auth",
					branch: "feature/auth",
					isLinkedWorktree: true,
				},
			};
			const p = provider as unknown as {
				getDiscoveredChildren: (
					a: typeof agent,
				) => Array<{ type: string; label: string; value: string }>;
			};
			const details = p.getDiscoveredChildren(agent);
			const worktreeDetail = details.find((d) => d.label === "Worktree");
			expect(worktreeDetail).toBeDefined();
			expect(worktreeDetail?.value).toContain("feature/auth");
			expect(worktreeDetail?.value).toContain(
				"/Users/test/projects/my-app-feature-auth",
			);
		});

		test("project grouping uses main repo for linked worktree discovered agents", () => {
			vscodeMock.workspace.getConfiguration = mock(() => ({
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "agentStatus.groupByProject") return true;
					return defaultValue;
				}),
			}));

			const p = provider as unknown as { _discoveredAgents: unknown[] };
			p._discoveredAgents = [
				{
					pid: 99001,
					projectDir: "/Users/test/projects/my-app-feature-a",
					startTime: new Date("2026-02-25T08:00:00Z"),
					source: "process",
					command: "claude",
					worktree: {
						mainRepoDir: "/Users/test/projects/my-app",
						worktreeDir: "/Users/test/projects/my-app-feature-a",
						branch: "feature/a",
						isLinkedWorktree: true,
					},
				},
				{
					pid: 99002,
					projectDir: "/Users/test/projects/my-app-feature-b",
					startTime: new Date("2026-02-25T08:01:00Z"),
					source: "process",
					command: "claude",
					worktree: {
						mainRepoDir: "/Users/test/projects/my-app",
						worktreeDir: "/Users/test/projects/my-app-feature-b",
						branch: "feature/b",
						isLinkedWorktree: true,
					},
				},
			];

			const root = provider.getChildren();
			const projectGroups = root.filter((node) => node.type === "projectGroup");
			expect(projectGroups).toHaveLength(1);
			const group = projectGroups[0] as {
				type: "projectGroup";
				projectName: string;
			};
			expect(group.projectName).toBe("my-app");
		});
	});
});
