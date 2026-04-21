/**
 * AgentStatusTreeProvider Tests
 *
 * Tests the tree provider with mock task registry data.
 * Verifies: tree structure, status icons, elapsed time formatting,
 * child nodes (details), sorting, and edge cases.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");

import * as os from "node:os";
import * as path from "node:path";

// Keep this test file on real node:fs even when other files mock it.
const fs = require("node:fs") as typeof import("node:fs");
mock.module("node:fs", () => fs);

const execFileSyncMock = mock((...fnArgs: unknown[]) =>
	realChildProcess.execFileSync(
		fnArgs[0] as string,
		fnArgs[1] as string[] | undefined,
		fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
	),
);
let openclawAuditJson = JSON.stringify({
	summary: {
		total: 0,
		warnings: 0,
		errors: 0,
		byCode: {
			stale_queued: 0,
			stale_running: 0,
			lost: 0,
			delivery_failed: 0,
			missing_cleanup: 0,
			inconsistent_timestamps: 0,
		},
	},
	findings: [],
});
mock.module("node:child_process", () => ({
	...realChildProcess,
	execFileSync: execFileSyncMock,
}));

// Mock port-detector to avoid real lsof calls in tree provider tests
const mockDetectListeningPorts = mock(
	() => [] as Array<{ port: number; pid: number; process: string }>,
);
mock.module("../../src/utils/port-detector.js", () => ({
	detectListeningPorts: mockDetectListeningPorts,
	detectListeningPortsAsync: mock(async () => mockDetectListeningPorts()),
}));

import {
	type AgentNode,
	AgentStatusTreeProvider,
	type AgentTask,
	type StatusGroupNode,
	type StatusTimeGroupNode,
	type TaskRegistry,
} from "../../src/providers/agent-status-tree-provider.js";
import type { ReviewTracker } from "../../src/services/review-tracker.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// ── Mock data ────────────────────────────────────────────────────────

function createMockTask(overrides: Partial<AgentTask> = {}): AgentTask {
	const task: AgentTask = {
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

	if (task.terminal_backend === "persist" && !task.persist_socket) {
		task.persist_socket = getPersistSocketPath(task);
	}

	return task;
}

function getPersistSocketPath(
	task: Pick<AgentTask, "session_id" | "persist_socket">,
): string {
	return (
		task.persist_socket ??
		path.join(
			os.homedir(),
			".local",
			"share",
			"cc",
			"sockets",
			`${task.session_id}.sock`,
		)
	);
}

function createMockRegistry(
	tasks: Record<string, AgentTask> = {},
): TaskRegistry {
	return { version: 2, tasks };
}

// Lightweight in-memory ReviewTracker — avoids filesystem I/O in tests.
// The real ReviewTracker is tested in test/services/review-tracker.test.ts.
class InMemoryReviewTracker {
	private reviewed = new Set<string>();
	markReviewed(taskId: string): void {
		this.reviewed.add(taskId);
	}
	isReviewed(taskId: string): boolean {
		return this.reviewed.has(taskId);
	}
	getReviewedIds(): Set<string> {
		return new Set(this.reviewed);
	}
	save(): void {}
}

/** Helper: extract only task nodes from root children (skips summary node) */
function getTaskNodes(children: AgentNode[]): AgentNode[] {
	return children.filter((n) => n.type === "task");
}

/** Helper: get the summary node from root children */
function getSummaryNode(
	children: AgentNode[],
): Extract<AgentNode, { type: "summary" }> {
	const summary = children.find(
		(n): n is Extract<AgentNode, { type: "summary" }> => n.type === "summary",
	);
	if (!summary) throw new Error("No summary node found in children");
	return summary;
}

// getStatusGroupNode helper removed — ≤5 agents now render flat (no status sub-groups)

function setAgentStatusConfig(
	vscodeMock: ReturnType<typeof setupVSCodeMock>,
	options: {
		groupByProject?: boolean;
		projectGroup?: string;
		discoveryEnabled?: boolean;
	},
): void {
	const getConfigurationMock = mock((_section?: string) => ({
		update: mock(),
		get: mock((_key: string, defaultValue?: unknown) => {
			if (_key === "agentStatus.groupByProject") {
				return options.groupByProject ?? false;
			}
			if (_key === "project.group") {
				return options.projectGroup ?? defaultValue;
			}
			if (_key === "discovery.enabled") {
				return options.discoveryEnabled ?? false;
			}
			return defaultValue;
		}),
		inspect: mock((_key: string) => undefined),
		has: mock((_key: string) => true),
	}));

	vscodeMock.workspace.getConfiguration =
		getConfigurationMock as unknown as typeof vscodeMock.workspace.getConfiguration;
	const runtimeVscode = require("vscode") as typeof import("vscode");
	runtimeVscode.workspace.getConfiguration =
		getConfigurationMock as unknown as typeof runtimeVscode.workspace.getConfiguration;
}

// ── Pre-patch readRegistry to prevent the constructor from reading the real
// tasks.json on disk (~196KB). Without this patch, `new AgentStatusTreeProvider()`
// calls `this.reload()` which calls `this.readRegistry()` → `fs.readFileSync(realFile)`.
// Each test's beforeEach would then incur ~300ms of JSON-parse overhead.
// Individual tests that need specific registry data override via instance property:
//   `provider.readRegistry = () => createMockRegistry({ "t1": task });`
// Tests that need the real implementation are in
// agent-status-tree-provider-read-registry.test.ts (extracted to escape the
// pollution this clobber causes).
(globalThis as Record<string, unknown>)["__realAgentStatusReadRegistry"] ??=
	AgentStatusTreeProvider.prototype.readRegistry;
AgentStatusTreeProvider.prototype.readRegistry = () => createMockRegistry({});

// Pure-helper tests (formatElapsed, detectAgentType, getAgentTypeIcon,
// getStatusThemeIcon) extracted to agent-status-tree-provider-pure-helpers.test.ts

// ── TreeProvider tests ───────────────────────────────────────────────

describe("AgentStatusTreeProvider", () => {
	let provider: AgentStatusTreeProvider;
	let vscodeMock: ReturnType<typeof setupVSCodeMock>;
	let projectIconManagerMock: {
		getIconForProject: ReturnType<typeof mock>;
		setCustomIcon: ReturnType<typeof mock>;
	};

	beforeEach(() => {
		mock.restore();
		openclawAuditJson = JSON.stringify({
			summary: {
				total: 0,
				warnings: 0,
				errors: 0,
				byCode: {
					stale_queued: 0,
					stale_running: 0,
					lost: 0,
					delivery_failed: 0,
					missing_cleanup: 0,
					inconsistent_timestamps: 0,
				},
			},
			findings: [],
		});
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[] | undefined];
			if (cmd === "tmux" && args?.includes("has-session")) return "";
			if (cmd === "persist" && args?.[0] === "-s") return "";
			if (
				cmd === "openclaw" &&
				args?.[0] === "tasks" &&
				args[1] === "audit" &&
				args[2] === "--json"
			) {
				return openclawAuditJson;
			}
			return realChildProcess.execFileSync(
				cmd,
				args,
				fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
			);
		});
		vscodeMock = setupVSCodeMock();
		projectIconManagerMock = {
			getIconForProject: mock(() => "🧩"),
			setCustomIcon: mock(() => Promise.resolve()),
		};
		setAgentStatusConfig(vscodeMock, {});
		// Ensure show*Message mocks return promises (needed for notification .then())
		vscodeMock.window.showInformationMessage = mock(() =>
			Promise.resolve(undefined),
		);
		vscodeMock.window.showWarningMessage = mock(() =>
			Promise.resolve(undefined),
		);

		provider = new AgentStatusTreeProvider(
			projectIconManagerMock as unknown as ConstructorParameters<
				typeof AgentStatusTreeProvider
			>[0],
		);
		// Inject a fresh, in-memory ReviewTracker for each test to avoid
		// cross-test pollution and unnecessary filesystem I/O.
		provider.setReviewTracker(
			new InMemoryReviewTracker() as unknown as ReviewTracker,
		);
		// Override readRegistry to return mock data (no file I/O)
		provider.readRegistry = () => createMockRegistry({});
		provider.reload();
	});

	afterEach(() => {
		// Null out _agentRegistry if it lacks dispose() (test mocks may omit it)
		const p = provider as unknown as { _agentRegistry: unknown };
		if (
			p._agentRegistry &&
			typeof (p._agentRegistry as { dispose?: unknown }).dispose !== "function"
		) {
			p._agentRegistry = null;
		}
		provider.dispose();
	});

	test("shows explicit empty state when no tasks", () => {
		const children = provider.getChildren();
		expect(children).toHaveLength(1);
		expect(children[0]).toEqual({
			type: "state",
			label: "Waiting for agents...",
			description: "Start Claude Code, Codex, or Gemini in any terminal",
			icon: "search",
		});
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

	test("preserves tmux window metadata from launcher tasks", () => {
		const task = createMockTask({
			tmux_conf: "/tmp/project.tmux.conf",
			tmux_socket: "/tmp/project.tmux.sock",
			tmux_window_id: "@42",
			tmux_window_name: "reviewer",
			tmux_pane_id: "%7",
		});
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.reload();

		const loadedTask = provider.getTasks()[0];
		expect(loadedTask?.tmux_conf).toBe("/tmp/project.tmux.conf");
		expect(loadedTask?.tmux_socket).toBe("/tmp/project.tmux.sock");
		expect(loadedTask?.tmux_window_id).toBe("@42");
		expect(loadedTask?.tmux_window_name).toBe("reviewer");
		expect(loadedTask?.tmux_pane_id).toBe("%7");
	});

	test("summary node has correct format", () => {
		const t1 = createMockTask({ id: "t1", status: "running" });
		const t2 = createMockTask({ id: "t2", status: "completed" });
		const t3 = createMockTask({ id: "t3", status: "failed" });
		const t4 = createMockTask({ id: "t4", status: "stopped" });
		provider.readRegistry = () => createMockRegistry({ t1, t2, t3, t4 });
		provider.reload();

		const children = provider.getChildren();
		const summary = children.find((n) => n.type === "summary");
		expect(summary).toBeDefined();
		expect(summary?.type).toBe("summary");
		if (summary?.type === "summary") {
			expect(summary.label).toContain("4 agents");
			expect(summary.label).toContain("1 working");
			expect(summary.label).toContain("2 ⏹");
			expect(summary.label).toContain("1 ✓");
		}
	});

	test("running task click focuses the terminal", () => {
		const task = createMockTask({ status: "running" });
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.reload();

		const children = provider.getChildren();
		const taskNode = getTaskNodes(children)[0];
		expect(taskNode).toBeDefined();
		if (!taskNode) {
			throw new Error("Expected running task node");
		}
		const item = provider.getTreeItem(taskNode);
		expect(item.command?.command).toBe("commandCentral.focusAgentTerminal");
		expect(item.command?.title).toBe("Focus Terminal");
	});

	test("completed task click resumes the session", () => {
		const task = createMockTask({ status: "completed" });
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.reload();

		const children = provider.getChildren();
		const taskNode = getTaskNodes(children)[0];
		expect(taskNode).toBeDefined();
		if (!taskNode) {
			throw new Error("Expected completed task node");
		}
		const item = provider.getTreeItem(taskNode);
		expect(item.command?.command).toBe("commandCentral.resumeAgentSession");
		expect(item.command?.title).toBe("Resume Session");
	});

	test("summary node TreeItem has info icon and correct contextValue", () => {
		const task = createMockTask();
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.reload();

		const children = provider.getChildren();
		const summary = getSummaryNode(children);
		const item = provider.getTreeItem(summary);
		expect(item.contextValue).toBe("agentSummary");
		expect(item.collapsibleState).toBe(0); // None
	});

	test("status groups in different projects with the same status get distinct TreeItem ids", () => {
		const groupAlpha: StatusGroupNode = {
			type: "statusGroup",
			status: "running",
			nodes: [],
			parentProjectName: "Alpha",
			parentProjectDir: "/Users/test/projects/alpha",
		};
		const groupBeta: StatusGroupNode = {
			type: "statusGroup",
			status: "running",
			nodes: [],
			parentProjectName: "Beta",
			parentProjectDir: "/Users/test/projects/beta",
		};

		const itemAlpha = provider.getTreeItem(groupAlpha);
		const itemBeta = provider.getTreeItem(groupBeta);

		expect(itemAlpha.id).not.toBe(itemBeta.id);
		expect(itemAlpha.id).toContain("/Users/test/projects/alpha");
		expect(itemBeta.id).toContain("/Users/test/projects/beta");
	});

	test("status-time groups in different projects with the same status and period get distinct TreeItem ids", () => {
		const timeGroupAlpha: StatusTimeGroupNode = {
			type: "statusTimeGroup",
			status: "done",
			period: "today",
			label: "Today (1)",
			nodes: [],
			collapsibleState: 1,
			parentProjectName: "Alpha",
			parentProjectDir: "/Users/test/projects/alpha",
		};
		const timeGroupBeta: StatusTimeGroupNode = {
			type: "statusTimeGroup",
			status: "done",
			period: "today",
			label: "Today (1)",
			nodes: [],
			collapsibleState: 1,
			parentProjectName: "Beta",
			parentProjectDir: "/Users/test/projects/beta",
		};

		const itemAlpha = provider.getTreeItem(timeGroupAlpha);
		const itemBeta = provider.getTreeItem(timeGroupBeta);

		expect(itemAlpha.id).not.toBe(itemBeta.id);
		expect(itemAlpha.id).toContain("/Users/test/projects/alpha");
		expect(itemBeta.id).toContain("/Users/test/projects/beta");
	});
});
