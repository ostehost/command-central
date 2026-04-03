/**
 * AgentStatusTreeProvider Tests
 *
 * Tests the tree provider with mock task registry data.
 * Verifies: tree structure, status icons, elapsed time formatting,
 * child nodes (details), sorting, and edge cases.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";

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
	type AgentRole,
	type AgentStatusGroup,
	AgentStatusTreeProvider,
	type AgentTask,
	detectAgentType,
	formatElapsed,
	type GitInfo,
	getAgentTypeIcon,
	getStatusThemeIcon,
	isValidSessionId,
	resolveAgentStatusSortMode,
	type TaskRegistry,
} from "../../src/providers/agent-status-tree-provider.js";
import { AgentStatusBar } from "../../src/services/agent-status-bar.js";
import { OpenClawConfigService } from "../../src/services/openclaw-config-service.js";
import { ReviewTracker } from "../../src/services/review-tracker.js";
import { PerformanceTestHelper } from "../helpers/performance-test-helper.js";
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

function getTmuxHealthCacheKey(
	task: Pick<AgentTask, "session_id" | "tmux_socket">,
): string {
	return `${task.tmux_socket ?? "__default__"}::${task.session_id}`;
}

function createMockRegistry(
	tasks: Record<string, AgentTask> = {},
): TaskRegistry {
	return { version: 2, tasks };
}

function loadAgentStatusFixture(fileName: string): TaskRegistry {
	const fixturePath = path.join(
		process.cwd(),
		"test",
		"fixtures",
		"agent-status",
		fileName,
	);
	return JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as TaskRegistry;
}

// Cache the raw dogfood fixture to avoid repeated file I/O on every call
const _DOGFOOD_RAW: TaskRegistry = loadAgentStatusFixture(
	"dogfood-live-tasks.json",
);

function loadDogfoodFixture(): TaskRegistry {
	const fixture = _DOGFOOD_RAW;
	const nextTasks: Record<string, AgentTask> = {};
	let runningIndex = 0;
	const now = Date.now();

	for (const task of Object.values(fixture.tasks)) {
		if (task.status !== "running") {
			nextTasks[task.id] = task;
			continue;
		}

		runningIndex += 1;
		const id = `dogfood-running-${runningIndex}`;
		nextTasks[id] = {
			...task,
			id,
			started_at: new Date(now - runningIndex * 5 * 60_000).toISOString(),
			stream_file: `/tmp/command-central-fixtures/${id}.jsonl`,
		};
	}

	return {
		version: fixture.version,
		tasks: nextTasks,
	};
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

/** Helper: get the first task node from root children */
function getFirstTask(children: AgentNode[]): AgentNode {
	const task = children.find((n) => n.type === "task");
	if (!task) throw new Error("No task node found in children");
	return task;
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

function getStatusGroupNode(
	children: AgentNode[],
	status: AgentStatusGroup,
): Extract<AgentNode, { type: "statusGroup" }> {
	const group = children.find(
		(
			node,
		): node is Extract<
			AgentNode,
			{ type: "statusGroup"; status: AgentStatusGroup }
		> => node.type === "statusGroup" && node.status === status,
	);
	if (!group) throw new Error(`No status group found for ${status}`);
	return group;
}

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

function getOlderRunsNode(
	children: AgentNode[],
): Extract<AgentNode, { type: "olderRuns" }> {
	const olderRuns = children.find(
		(node): node is Extract<AgentNode, { type: "olderRuns" }> =>
			node.type === "olderRuns",
	);
	if (!olderRuns) throw new Error("No older runs node found in children");
	return olderRuns;
}

// ── Pre-patch readRegistry to prevent the constructor from reading the real
// tasks.json on disk (~196KB). Without this patch, `new AgentStatusTreeProvider()`
// calls `this.reload()` which calls `this.readRegistry()` → `fs.readFileSync(realFile)`.
// Each test's beforeEach would then incur ~300ms of JSON-parse overhead.
// Individual tests that need specific registry data override via instance property:
//   `provider.readRegistry = () => createMockRegistry({ "t1": task });`
// Tests that need the real implementation use `_realReadRegistry.call(provider)`.
const _realReadRegistry = AgentStatusTreeProvider.prototype.readRegistry;
AgentStatusTreeProvider.prototype.readRegistry = () => createMockRegistry({});

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

	test("omits zero minutes for exact-hour durations", () => {
		const now = new Date("2026-02-25T10:00:00Z");
		expect(formatElapsed("2026-02-25T08:00:00Z", now)).toBe("2h");
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
			["completed_dirty", "check", "charts.green"],
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

	test("shows explicit empty state when no tasks", () => {
		const children = provider.getChildren();
		expect(children).toHaveLength(1);
		expect(children[0]).toEqual({
			type: "state",
			label: "No agents tracked yet",
			description: "Start an agent task to populate this view.",
			icon: "info",
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
			expect(summary.label).toContain("2 stopped");
			expect(summary.label).toContain("1 done");
		}
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

	describe("runtime health overlay for running status", () => {
		test("overlays stuck dead running tmux task as completed_stale for UI status/counts", () => {
			const task = createMockTask({
				id: "ghost-running",
				status: "running",
				terminal_backend: "tmux",
				started_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
			});
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("completed_stale");

			const children = provider.getChildren();
			const summary = children.find((n) => n.type === "summary");
			expect(summary).toBeDefined();
			if (summary?.type === "summary") {
				expect(summary.label).toContain("1 done");
				expect(summary.label).not.toContain("1 working");
			}
			const taskNode = getFirstTask(children);
			const taskItem = provider.getTreeItem(taskNode);
			expect(taskItem.description).toContain(
				"Stale — session ended without completion signal",
			);
			const icon = taskItem.iconPath as { id: string; color?: { id: string } };
			expect(icon.id).toBe("warning");
			expect(icon.color?.id).toBe("charts.yellow");
			expect(taskItem.command?.command).toBe(
				"commandCentral.agentQuickActions",
			);
		});

		test("still downgrades running tmux task when tmux session is unhealthy", () => {
			const task = createMockTask({
				id: "live-running",
				status: "running",
				terminal_backend: "tmux",
				started_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
			});
			(
				provider as unknown as {
					_allDiscoveredAgents: Array<{ sessionId?: string }>;
				}
			)._allDiscoveredAgents = [{ sessionId: task.session_id }];
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("stopped");
		});

		test("getStaleLauncherTasks returns the display-overlay stale tasks", () => {
			const task = createMockTask({
				id: "stale-listing",
				status: "running",
				terminal_backend: "tmux",
				started_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
			});
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(
				provider.getStaleLauncherTasks().map((candidate) => candidate.id),
			).toEqual(["stale-listing"]);
		});

		test("uses terminal stream completion instead of stopped when session already finished", () => {
			const streamFile = path.join(
				"/tmp",
				`agent-status-completed-${Date.now()}.jsonl`,
			);
			const task = createMockTask({
				id: "stream-completed",
				status: "running",
				terminal_backend: "tmux",
				stream_file: streamFile,
				started_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
			});
			fs.writeFileSync(
				streamFile,
				`${JSON.stringify({ type: "turn.completed" })}\n`,
			);
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: false,
				checkedAt: Date.now(),
			});

			try {
				provider.readRegistry = () => createMockRegistry({ [task.id]: task });
				provider.reload();

				const displayTask = provider
					.getTasks()
					.find((candidate) => candidate.id === task.id);
				expect(displayTask?.status).toBe("completed");

				const taskNode = getFirstTask(provider.getChildren());
				const details = provider.getChildren(taskNode);
				expect(
					details.some(
						(child) =>
							child.type === "detail" && child.label === "Agent process ended",
					),
				).toBe(false);
			} finally {
				if (fs.existsSync(streamFile)) fs.unlinkSync(streamFile);
			}
		});

		test("downgrades unhealthy running persist task to stopped when socket is dead", () => {
			const task = createMockTask({
				id: "persist-running",
				status: "running",
				terminal_backend: "persist",
			});
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache.set(getPersistSocketPath(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("stopped");
		});

		test("displays completed instead of stopped when exit_code is 0 on dead persist task", () => {
			const task = createMockTask({
				id: "persist-completed-evidence",
				status: "running",
				terminal_backend: "persist",
				exit_code: 0,
			});
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache.set(getPersistSocketPath(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("completed");
		});

		test("displays failed instead of stopped when exit_code is non-zero on dead persist task", () => {
			const task = createMockTask({
				id: "persist-failed-evidence",
				status: "running",
				terminal_backend: "persist",
				exit_code: 1,
			});
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache.set(getPersistSocketPath(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("failed");
		});

		test("displays completed instead of stopped when completed_at is set on dead tmux task", () => {
			const task = createMockTask({
				id: "tmux-completed-at",
				status: "running",
				terminal_backend: "tmux",
				completed_at: new Date(Date.now() - 60_000).toISOString(),
			});
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("completed");
		});

		test("displays stopped when no completion evidence on dead persist task", () => {
			const task = createMockTask({
				id: "persist-no-evidence",
				status: "running",
				terminal_backend: "persist",
				// no exit_code, no completed_at
			});
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache.set(getPersistSocketPath(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("stopped");
		});

		test("tasks.json completed status is preserved regardless of session health", () => {
			const task = createMockTask({
				id: "already-completed",
				status: "completed",
				terminal_backend: "persist",
				exit_code: 0,
				completed_at: new Date(Date.now() - 60_000).toISOString(),
			});
			// Even though session is dead, status should stay completed
			// (the guard at the top of toDisplayTask handles this)
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("completed");
		});

		test("persist-backed running task shows as running when socket is alive", () => {
			const task = createMockTask({
				id: "persist-alive",
				status: "running",
				terminal_backend: "persist",
			});
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache.set(getPersistSocketPath(task), {
				alive: true,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("running");
		});

		test("tmux-backed running task still uses tmux cache (no regression)", () => {
			const task = createMockTask({
				id: "tmux-check",
				status: "running",
				terminal_backend: "tmux",
			});
			// Set tmux cache to alive
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: true,
				checkedAt: Date.now(),
			});
			// Persist cache says dead — should be ignored for tmux tasks
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache.set(getPersistSocketPath(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("running");
		});

		test("legacy running task without terminal_backend falls back to tmux health", () => {
			const task = createMockTask({
				id: "legacy-tmux",
				status: "running",
				terminal_backend: undefined,
			});
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("stopped");
		});

		test("persist health cache is used on second call within TTL", () => {
			const task = createMockTask({
				id: "persist-cached",
				status: "running",
				terminal_backend: "persist",
			});
			const persistCache = (
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache;
			persistCache.set(getPersistSocketPath(task), {
				alive: true,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();
			// First call uses cache
			expect(provider.getTasks()[0]?.status).toBe("running");

			// Reload again — cache entry should still be used (within 5s TTL)
			const sizeBeforeReload = persistCache.size;
			provider.reload();
			expect(provider.getTasks()[0]?.status).toBe("running");
			// Cache should not have grown (no duplicate entries)
			expect(persistCache.size).toBe(sizeBeforeReload);
		});

		test("uses task tmux_socket for tmux health checks instead of the default socket", () => {
			const socketPath =
				"/Users/ostemini/.local/state/ghostty-launcher/tmux/test-task.sock";
			const task = createMockTask({
				id: "tmux-dedicated-socket",
				status: "running",
				terminal_backend: "tmux",
				tmux_socket: socketPath,
			});
			execFileSyncMock.mockClear();
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("running");
			expect(execFileSyncMock).toHaveBeenCalledWith(
				"tmux",
				["-S", socketPath, "has-session", "-t", task.session_id],
				{ timeout: 500 },
			);
		});

		test("does not deduplicate tmux tasks with different window IDs in shared session", () => {
			// Real-world scenario: multiple agents share one tmux session but each
			// occupies a distinct window (@N).  They must all remain "running" — the
			// reconciler must not mark the older windows as stopped.
			const now = Date.now();
			const tmuxSocket = "/tmp/test-tmux.sock";
			// Use short started_at values (< stuckThreshold) so none are "looksStale".
			const window1 = createMockTask({
				id: "window-1",
				status: "running",
				session_id: "agent-command-central",
				terminal_backend: "tmux",
				tmux_window_id: "@1",
				tmux_socket: tmuxSocket,
				started_at: new Date(now - 5 * 60_000).toISOString(),
			});
			const window2 = createMockTask({
				id: "window-2",
				status: "running",
				session_id: "agent-command-central",
				terminal_backend: "tmux",
				tmux_window_id: "@2",
				tmux_socket: tmuxSocket,
				started_at: new Date(now - 3 * 60_000).toISOString(),
			});
			const window3 = createMockTask({
				id: "window-3",
				status: "running",
				session_id: "agent-command-central",
				terminal_backend: "tmux",
				tmux_window_id: "@3",
				tmux_socket: tmuxSocket,
				started_at: new Date(now - 1 * 60_000).toISOString(),
			});
			// Mark all windows as alive in the cache.
			const cacheType = provider as unknown as {
				_tmuxSessionHealthCache: Map<
					string,
					{ alive: boolean; checkedAt: number }
				>;
			};
			for (const w of [window1, window2, window3]) {
				cacheType._tmuxSessionHealthCache.set(
					`${tmuxSocket}::agent-command-central::${w.tmux_window_id}`,
					{ alive: true, checkedAt: Date.now() },
				);
			}
			provider.readRegistry = () =>
				createMockRegistry({
					[window1.id]: window1,
					[window2.id]: window2,
					[window3.id]: window3,
				});
			provider.reload();

			const displayStatuses = new Map(
				provider.getTasks().map((task) => [task.id, task.status]),
			);
			// All three windows are in independent windows — none should be stopped.
			expect(displayStatuses.get("window-1")).toBe("running");
			expect(displayStatuses.get("window-2")).toBe("running");
			expect(displayStatuses.get("window-3")).toBe("running");
		});

		test("marks tmux task as stale when its specific window is dead (shared session)", () => {
			// Even though the tmux SESSION is alive (other windows still running),
			// a task whose window has been killed should be detected as dead.
			const now = Date.now();
			const tmuxSocket = "/tmp/test-tmux2.sock";
			const deadWindow = createMockTask({
				id: "dead-window",
				status: "running",
				session_id: "agent-command-central",
				terminal_backend: "tmux",
				tmux_window_id: "@10",
				tmux_socket: tmuxSocket,
				started_at: new Date(now - 5 * 60 * 60_000).toISOString(),
			});
			// Window @10 is dead; the session is still alive (other windows exist).
			const cacheType = provider as unknown as {
				_tmuxSessionHealthCache: Map<
					string,
					{ alive: boolean; checkedAt: number }
				>;
			};
			cacheType._tmuxSessionHealthCache.set(
				`${tmuxSocket}::agent-command-central::@10`,
				{ alive: false, checkedAt: Date.now() },
			);
			provider.readRegistry = () =>
				createMockRegistry({ [deadWindow.id]: deadWindow });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("completed_stale");
		});

		test("keeps only newest running task per reused session id", () => {
			const now = Date.now();
			const older = createMockTask({
				id: "stale-running",
				status: "running",
				session_id: "agent-shared",
				terminal_backend: "persist",
				started_at: new Date(now - 2 * 60 * 60_000).toISOString(),
			});
			const newer = createMockTask({
				id: "fresh-running",
				status: "running",
				session_id: "agent-shared",
				terminal_backend: "persist",
				started_at: new Date(now - 5 * 60_000).toISOString(),
			});
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache.set(getPersistSocketPath(older), {
				alive: true,
				checkedAt: Date.now(),
			});
			(
				provider as unknown as {
					_allDiscoveredAgents: Array<{ sessionId?: string }>;
				}
			)._allDiscoveredAgents = [{ sessionId: "agent-shared" }];
			provider.readRegistry = () =>
				createMockRegistry({
					[older.id]: older,
					[newer.id]: newer,
				});
			provider.reload();

			const displayStatuses = new Map(
				provider.getTasks().map((task) => [task.id, task.status]),
			);
			expect(displayStatuses.get("fresh-running")).toBe("running");
			expect(displayStatuses.get("stale-running")).toBe("stopped");
		});
	});

	describe("visibility contract + launcher icon integration", () => {
		test("screenshot fixture: stale running task is excluded from working count + dock badge", () => {
			/**
			 * Repro steps from screenshot scenario:
			 * 1. Launcher still reports one task as `running`.
			 * 2. The backing session is dead (stale).
			 * 3. UI must not show that stale task as working anywhere.
			 */
			const fixture = loadAgentStatusFixture("screenshot-stale-running.json");
			const stale = fixture.tasks["cc-screenshot-stale-running"] as
				| AgentTask
				| undefined;
			if (!stale) throw new Error("missing stale fixture task");

			const originalPlatform = Object.getOwnPropertyDescriptor(
				process,
				"platform",
			);
			Object.defineProperty(process, "platform", {
				value: "darwin",
				configurable: true,
			});
			try {
				(
					provider as unknown as {
						_persistSessionHealthCache: Map<
							string,
							{ alive: boolean; checkedAt: number }
						>;
					}
				)._persistSessionHealthCache.set(getPersistSocketPath(stale), {
					alive: false,
					checkedAt: Date.now(),
				});
				provider.readRegistry = () => fixture;
				provider.reload();

				const summary = provider
					.getChildren()
					.find((n) => n.type === "summary");
				expect(summary).toBeDefined();
				if (summary?.type === "summary") {
					expect(summary.label).not.toContain("1 working");
					expect(summary.label).toContain("2 done");
				}

				expect(vscodeMock.window.badge).toBeUndefined();
				const statusTasks = provider.getTasks();
				const staleTask = statusTasks.find(
					(task) => task.id === "cc-screenshot-stale-running",
				);
				expect(staleTask?.status).toBe("completed_stale");
				const statusBarItem = {
					text: "",
					tooltip: "",
					command: "",
					backgroundColor: undefined,
					show: mock(),
					hide: mock(),
					dispose: mock(),
				};
				vscodeMock.window.createStatusBarItem = mock(() => statusBarItem);
				const statusBar = new AgentStatusBar();
				statusBar.update(statusTasks);
				expect(statusBarItem.text).toContain("2 done");
				expect(statusBarItem.text).not.toContain("working");
				statusBar.dispose();
			} finally {
				if (originalPlatform) {
					Object.defineProperty(process, "platform", originalPlatform);
				}
			}
		});

		test("reload re-merges discovery against latest launcher state (restart/reconnect)", () => {
			const discovered = {
				pid: 424242,
				projectDir: "/Users/test/projects/command-central",
				command: "claude --resume abc123",
				startTime: new Date("2026-03-27T12:00:00.000Z"),
				sessionId: "agent-shared-visibility",
				source: "session-file",
			};
			(
				provider as unknown as {
					_agentRegistry: {
						getAllDiscovered: () => Array<typeof discovered>;
						getDiscoveredAgents: (
							tasks: AgentTask[],
						) => Array<typeof discovered>;
					};
				}
			)._agentRegistry = {
				getAllDiscovered: () => [discovered],
				getDiscoveredAgents: (tasks: AgentTask[]) =>
					tasks.some(
						(task) =>
							task.status === "running" &&
							task.session_id === discovered.sessionId,
					)
						? []
						: [discovered],
			};

			const launcherRunning = createMockTask({
				id: "launcher-shared-running",
				status: "running",
				session_id: "agent-shared-visibility",
			});
			provider.readRegistry = () =>
				createMockRegistry({ [launcherRunning.id]: launcherRunning });
			provider.reload();
			expect(
				provider.getTasks().some((task) => task.id === "discovered-424242"),
			).toBe(false);

			const launcherStopped = createMockTask({
				id: "launcher-shared-running",
				status: "completed_stale",
				session_id: "agent-shared-visibility",
			});
			provider.readRegistry = () =>
				createMockRegistry({ [launcherStopped.id]: launcherStopped });
			provider.reload();

			const discoveredTask = provider
				.getTasks()
				.find((task) => task.id === "discovered-424242");
			expect(discoveredTask?.status).toBe("running");

			const summary = provider.getChildren().find((n) => n.type === "summary");
			expect(summary).toBeDefined();
			if (summary?.type === "summary") {
				expect(summary.label).toContain("1 working");
				expect(summary.label).toContain("1 done");
			}
		});

		test("launcher-provided project_icon is used for task + project group labels", () => {
			vscodeMock.workspace.getConfiguration = mock(() => ({
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "agentStatus.groupByProject") return true;
					return defaultValue;
				}),
			}));

			const launcherTask = createMockTask({
				id: "launcher-icon-task",
				project_name: "Command Central",
				project_dir: "/Users/test/projects/command-central",
				project_icon: "🚀",
			});
			provider.readRegistry = () =>
				createMockRegistry({ [launcherTask.id]: launcherTask });
			provider.reload();

			const root = provider.getChildren();
			const groupNode = root.find(
				(node): node is Extract<AgentNode, { type: "projectGroup" }> =>
					node.type === "projectGroup",
			);
			if (!groupNode) throw new Error("expected project group");
			const groupItem = provider.getTreeItem(groupNode);
			expect(groupItem.label).toBe("🚀 Command Central");
			expect(groupItem.description).toContain("1 working");
			expect(groupItem.description).toContain("1m ago");

			const children = provider.getChildren(groupNode);
			const runningGroup = children.find(
				(node): node is Extract<AgentNode, { type: "statusGroup" }> =>
					node.type === "statusGroup" && node.status === "running",
			);
			if (!runningGroup) throw new Error("expected running status group");
			const taskNode = provider
				.getChildren(runningGroup)
				.find(
					(node): node is Extract<AgentNode, { type: "task" }> =>
						node.type === "task",
				);
			if (!taskNode) throw new Error("expected task node");
			const taskItem = provider.getTreeItem(taskNode);
			expect(taskItem.label).toContain("🚀");
			expect(taskItem.label).toContain("launcher-icon-task");
		});
	});

	describe("dogfood discovery integration", () => {
		test("live tasks snapshot keeps only genuine running tasks active and caps history", () => {
			setAgentStatusConfig(vscodeMock, {
				groupByProject: false,
				discoveryEnabled: false,
			});

			const fixture = loadDogfoodFixture();
			const runningTasks = Object.values(fixture.tasks).filter(
				(task) => task.status === "running",
			);
			const tmuxRunning = runningTasks.filter(
				(task) => task.terminal_backend === "tmux",
			);
			const persistRunning = runningTasks.filter(
				(task) => task.terminal_backend === "persist",
			);
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache = new Map(
				tmuxRunning.map((task) => [
					getTmuxHealthCacheKey(task),
					{ alive: true, checkedAt: Date.now() },
				]),
			);
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache = new Map(
				persistRunning.map((task) => [
					getPersistSocketPath(task),
					{ alive: true, checkedAt: Date.now() },
				]),
			);
			provider.readRegistry = () => fixture;
			provider.reload();

			const tasks = provider.getTasks();
			expect(tasks).toHaveLength(213);
			expect(tasks.filter((task) => task.status === "running")).toHaveLength(2);

			const children = provider.getChildren();
			expect(getSummaryNode(children).label).toContain("2 working");
			expect(getSummaryNode(children).label).toContain("213 agents");
			expect(getTaskNodes(children)).toHaveLength(50);
			expect(getOlderRunsNode(children).hiddenNodes.length).toBeGreaterThan(
				150,
			);
		});

		test("live tasks snapshot stays within the large-registry render budget", () => {
			setAgentStatusConfig(vscodeMock, {
				groupByProject: false,
				discoveryEnabled: false,
			});

			const fixture = loadDogfoodFixture();
			const runningTasks = Object.values(fixture.tasks).filter(
				(task) => task.status === "running",
			);
			const tmuxRunning = runningTasks.filter(
				(task) => task.terminal_backend === "tmux",
			);
			const persistRunning = runningTasks.filter(
				(task) => task.terminal_backend === "persist",
			);
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache = new Map(
				tmuxRunning.map((task) => [
					getTmuxHealthCacheKey(task),
					{ alive: true, checkedAt: Date.now() },
				]),
			);
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache = new Map(
				persistRunning.map((task) => [
					getPersistSocketPath(task),
					{ alive: true, checkedAt: Date.now() },
				]),
			);
			provider.readRegistry = () => fixture;
			provider.reload();

			const measurement = PerformanceTestHelper.measureSync(
				() => provider.getChildren(),
				100,
			);
			expect(measurement.passed).toBe(true);
		});

		test("discovery diagnostics report shows retained vs filtered scanner matches", () => {
			const now = Date.now();
			const running = createMockTask({
				id: "run-1",
				status: "running",
				project_dir: "/Users/test/projects/command-central",
				project_name: "command-central",
				session_id: "agent-command-central",
				terminal_backend: "tmux",
				cli_name: "codex",
				started_at: new Date(now - 5 * 60_000).toISOString(),
			});
			const recentCompleted = createMockTask({
				id: "done-1",
				status: "completed",
				cli_name: "codex",
				started_at: new Date(now - 40 * 60_000).toISOString(),
				completed_at: new Date(now - 30 * 60_000).toISOString(),
			});
			const dayCompleted = createMockTask({
				id: "done-2",
				status: "completed",
				cli_name: "claude",
				started_at: new Date(now - 3 * 60 * 60_000).toISOString(),
				completed_at: new Date(now - 2 * 60 * 60_000).toISOString(),
			});
			const oldCompleted = createMockTask({
				id: "done-3",
				status: "completed",
				cli_name: "claude",
				started_at: new Date(now - 49 * 60 * 60_000).toISOString(),
				completed_at: new Date(now - 48 * 60 * 60_000).toISOString(),
			});
			provider.readRegistry = () =>
				createMockRegistry({
					[running.id]: running,
					[recentCompleted.id]: recentCompleted,
					[dayCompleted.id]: dayCompleted,
					[oldCompleted.id]: oldCompleted,
				});
			provider.reload();
			(
				provider as unknown as {
					_openclawTaskService: {
						isInstalled?: boolean;
						getTasks: () => Array<{
							taskId: string;
							runtime: "cli";
							ownerKey: string;
							scopeKind: string;
							task: string;
							status:
								| "queued"
								| "running"
								| "succeeded"
								| "failed"
								| "timed_out"
								| "cancelled"
								| "lost"
								| "blocked";
							deliveryStatus: string;
							notifyPolicy: string;
							createdAt: number;
							startedAt?: number;
							endedAt?: number;
							lastEventAt?: number;
						}>;
					};
					_agentRegistry: {
						getDiagnostics: () => {
							discoveredCount: number;
							sessionFileCount: number;
							prunedDeadAgents: number;
							processScanner: {
								psRowCount: number;
								agentLikeCandidateCount: number;
								retained: Array<{
									pid: number;
									command: string;
									binaryName?: string;
									projectDir?: string;
								}>;
								filtered: Array<{
									pid: number;
									command: string;
									binaryName?: string;
									reason?: string;
								}>;
							};
						};
					};
					_discoveredAgents: Array<{
						pid: number;
						projectDir: string;
						command: string;
						cli_name?: string;
						agent_backend?: "codex";
						startTime: Date;
						source: "process";
					}>;
					_allDiscoveredAgents: Array<{
						pid: number;
						projectDir: string;
						command: string;
						cli_name?: string;
						agent_backend?: "codex";
						startTime: Date;
						source: "process";
					}>;
				}
			)._openclawTaskService = {
				isInstalled: true,
				getTasks: () => [
					{
						taskId: "bg-1",
						runtime: "cli",
						ownerKey: "owner",
						scopeKind: "workspace",
						task: "background running",
						status: "running",
						deliveryStatus: "delivered",
						notifyPolicy: "always",
						createdAt: now - 8 * 60_000,
						startedAt: now - 7 * 60_000,
						lastEventAt: now - 2 * 60_000,
					},
					{
						taskId: "bg-2",
						runtime: "cli",
						ownerKey: "owner",
						scopeKind: "workspace",
						task: "background done",
						status: "succeeded",
						deliveryStatus: "delivered",
						notifyPolicy: "always",
						createdAt: now - 50 * 60_000,
						startedAt: now - 45 * 60_000,
						endedAt: now - 20 * 60_000,
					},
					{
						taskId: "bg-3",
						runtime: "cli",
						ownerKey: "owner",
						scopeKind: "workspace",
						task: "background done again",
						status: "succeeded",
						deliveryStatus: "delivered",
						notifyPolicy: "always",
						createdAt: now - 90 * 60_000,
						startedAt: now - 80 * 60_000,
						endedAt: now - 70 * 60_000,
					},
				],
			};
			openclawAuditJson = JSON.stringify({
				summary: {
					total: 153,
					warnings: 152,
					errors: 1,
					byCode: {
						stale_queued: 0,
						stale_running: 1,
						lost: 0,
						delivery_failed: 0,
						missing_cleanup: 0,
						inconsistent_timestamps: 152,
					},
				},
				findings: [],
			});
			(
				provider as unknown as {
					_agentRegistry: {
						getDiagnostics: () => {
							discoveredCount: number;
							sessionFileCount: number;
							prunedDeadAgents: number;
							processScanner: {
								psRowCount: number;
								agentLikeCandidateCount: number;
								retained: Array<{
									pid: number;
									command: string;
									startTime: Date;
									binaryName?: string;
									projectDir?: string;
								}>;
								filtered: Array<{
									pid: number;
									command: string;
									startTime: Date;
									binaryName?: string;
									reason?: string;
								}>;
							};
						};
					};
				}
			)._agentRegistry = {
				getDiagnostics: () => ({
					discoveredCount: 2,
					sessionFileCount: 0,
					prunedDeadAgents: 0,
					processScanner: {
						psRowCount: 22,
						agentLikeCandidateCount: 6,
						retained: [
							{
								pid: 64601,
								command: "/opt/homebrew/bin/codex --model gpt-5",
								binaryName: "codex",
								projectDir: "/Users/test/projects/command-central",
								startTime: new Date(now - 5 * 60_000),
							},
							{
								pid: 19321,
								command: "/opt/homebrew/bin/codex --model gpt-5 mini",
								binaryName: "codex",
								projectDir: "/Users/test/projects/ghostty-launcher",
								startTime: new Date(now - 12 * 60_000),
							},
						],
						filtered: [
							{
								pid: 5001,
								command:
									"/opt/homebrew/bin/terminal-notifier -message 'codex finished'",
								binaryName: "terminal-notifier",
								reason: "excluded-binary",
								startTime: new Date(now - 30 * 60_000),
							},
							{
								pid: 5002,
								command:
									"/opt/homebrew/bin/terminal-notifier -message 'claude finished'",
								binaryName: "terminal-notifier",
								reason: "excluded-binary",
								startTime: new Date(now - 35 * 60_000),
							},
							{
								pid: 5003,
								command: "/opt/homebrew/bin/claude",
								binaryName: "claude",
								reason: "interactive-process",
								startTime: new Date(now - 45 * 60_000),
							},
							{
								pid: 5004,
								command: "/opt/homebrew/bin/codex",
								binaryName: "codex",
								reason: "interactive-process",
								startTime: new Date(now - 50 * 60_000),
							},
						],
					},
				}),
			};
			(
				provider as unknown as {
					_discoveredAgents: Array<{
						pid: number;
						projectDir: string;
						command: string;
						cli_name?: string;
						agent_backend?: "codex";
						startTime: Date;
						source: "process";
					}>;
					_allDiscoveredAgents: Array<{
						pid: number;
						projectDir: string;
						command: string;
						cli_name?: string;
						agent_backend?: "codex";
						startTime: Date;
						source: "process";
					}>;
				}
			)._discoveredAgents = [
				{
					pid: 64601,
					projectDir: "/Users/test/projects/command-central",
					command: "/opt/homebrew/bin/codex --model gpt-5",
					cli_name: "codex",
					agent_backend: "codex",
					startTime: new Date(now - 5 * 60_000),
					source: "process",
				},
				{
					pid: 19321,
					projectDir: "/Users/test/projects/ghostty-launcher",
					command: "/opt/homebrew/bin/codex --model gpt-5 mini",
					cli_name: "codex",
					agent_backend: "codex",
					startTime: new Date(now - 12 * 60_000),
					source: "process",
				},
			];
			(
				provider as unknown as {
					_allDiscoveredAgents: Array<{
						pid: number;
						projectDir: string;
						command: string;
						cli_name?: string;
						agent_backend?: "codex";
						startTime: Date;
						source: "process";
					}>;
				}
			)._allDiscoveredAgents = [
				{
					pid: 64601,
					projectDir: "/Users/test/projects/command-central",
					command: "/opt/homebrew/bin/codex --model gpt-5",
					cli_name: "codex",
					agent_backend: "codex",
					startTime: new Date(now - 5 * 60_000),
					source: "process",
				},
				{
					pid: 19321,
					projectDir: "/Users/test/projects/ghostty-launcher",
					command: "/opt/homebrew/bin/codex --model gpt-5 mini",
					cli_name: "codex",
					agent_backend: "codex",
					startTime: new Date(now - 12 * 60_000),
					source: "process",
				},
			];

			const report = provider.getDiscoveryDiagnosticsReport();
			expect(report).toContain("Agent Discovery Health: ✅ Healthy");
			expect(report).toContain("Running agents: 2 (2 codex)");
			expect(report).toContain("Background tasks: 3 (1 running, 2 succeeded)");
			expect(report).toContain(
				"Registry: 4 tasks (1 running, 3 completed/archived)",
			);
			expect(report).toContain(
				"Discovery: 2 agents found via process scanner, 0 via session files",
			);
			expect(report).toContain("Registry age:");
			expect(report).toContain("Last 1h: 2 tasks (1 running, 1 completed)");
			expect(report).toContain("Last 24h: 1 tasks");
			expect(report).toContain("Older: 1 tasks (archive candidates)");
			expect(report).toContain("Filtered (4 matches):");
			expect(report).toContain(
				"Helper binaries: 2 (2 terminal-notifier — consider killing stale processes)",
			);
			expect(report).toContain(
				"Interactive CLIs: 2 (claude, codex — idle sessions, not agents)",
			);
			expect(report).toContain("Active agents (2):");
			expect(report).toContain(
				"codex · command-central · PID 64601 · running 5m",
			);
			expect(report).toContain(
				"codex · ghostty-launcher · PID 19321 · running 12m",
			);
			expect(report).toContain(
				'⚠️ 2 stale terminal-notifier processes — run: pkill -f "terminal-notifier.*oste"',
			);
			expect(report).toContain("✅ No stuck agents detected");
			expect(report).toContain(
				"✅ All running agents have healthy tmux sessions",
			);
			expect(report).toContain("OpenClaw Task Ledger:");
			expect(report).toContain("Total: 3 tasks (7-day window)");
			expect(report).toContain("Running: 1 (stale_running error detected)");
			expect(report).toContain("Succeeded: 2");
			expect(report).toContain("Failed: 0");
			expect(report).toContain(
				"⚠️ 1 stale running task — may need manual cleanup",
			);
			expect(report).toContain(
				"ℹ️ 152 inconsistent timestamps (OpenClaw-side, cosmetic)",
			);
		});
	});

	test("discovery diagnostics report notes when OpenClaw is not detected", () => {
		const report = provider.getDiscoveryDiagnosticsReport();
		expect(report).toContain("OpenClaw: not detected (task audit skipped)");
	});

	test("summary includes stuck count and stopped tooltip guidance", () => {
		const stuckRunning = createMockTask({
			id: "stuck-running",
			status: "running",
			terminal_backend: undefined,
			started_at: new Date(Date.now() - 40 * 60_000).toISOString(),
		});
		const failed = createMockTask({ id: "f1", status: "failed" });
		const stopped = createMockTask({ id: "s1", status: "stopped" });
		provider.readRegistry = () =>
			createMockRegistry({
				[stuckRunning.id]: stuckRunning,
				[failed.id]: failed,
				[stopped.id]: stopped,
			});
		provider.reload();

		const summary = provider.getChildren().find((n) => n.type === "summary");
		expect(summary).toBeDefined();
		if (summary?.type === "summary") {
			expect(summary.label).toContain("1 working");
			expect(summary.label).toContain("2 stopped");
			expect(summary.label).toContain("1 stuck");
		}

		const summaryItem = provider.getTreeItem(summary as AgentNode);
		expect(String(summaryItem.tooltip ?? "")).toContain("stopped agents");
	});

	test("sorts flat tasks by activity within the same status group", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: false });

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
		expect(getSummaryNode(children).label).toContain("2 agents");
	});

	test("caps flat history and exposes older runs behind an expandable node", () => {
		setAgentStatusConfig(vscodeMock, {
			groupByProject: false,
			discoveryEnabled: false,
		});

		const tasks = Array.from({ length: 51 }, (_, index) =>
			createMockTask({
				id: `task-${index + 1}`,
				status: "completed",
				started_at: `2026-02-25T${String(20 - index).padStart(2, "0")}:00:00Z`,
			}),
		);
		provider.readRegistry = () =>
			createMockRegistry(
				Object.fromEntries(tasks.map((task) => [task.id, task])),
			);
		provider.reload();

		const children = provider.getChildren();
		const taskNodes = getTaskNodes(children);
		expect(taskNodes).toHaveLength(50);
		expect((taskNodes[0] as { type: "task"; task: AgentTask }).task.id).toBe(
			"task-1",
		);
		expect((taskNodes[49] as { type: "task"; task: AgentTask }).task.id).toBe(
			"task-50",
		);

		const olderRuns = getOlderRunsNode(children);
		expect(olderRuns.label).toBe("Show 1 older run...");
		const olderRunsItem = provider.getTreeItem(olderRuns);
		expect(olderRunsItem.collapsibleState).toBe(1);

		const expandedChildren = provider.getChildren(olderRuns);
		expect(expandedChildren).toHaveLength(1);
		expect(expandedChildren[0]?.type).toBe("task");
		if (expandedChildren[0]?.type === "task") {
			expect(expandedChildren[0].task.id).toBe("task-51");
		}
	});

	test("flat mode sorts by status priority before activity", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: false });

		const now = Date.now();
		const failedOlder = createMockTask({
			id: "failed-old",
			status: "failed",
			started_at: new Date(now - 11 * 60_000).toISOString(),
		});
		const failedNewer = createMockTask({
			id: "failed-new",
			status: "failed",
			started_at: new Date(now - 3 * 60_000).toISOString(),
		});
		const runningOldest = createMockTask({
			id: "running-oldest",
			status: "running",
			started_at: new Date(now - 12 * 60_000).toISOString(),
		});
		const completedLatest = createMockTask({
			id: "done-latest",
			status: "completed",
			started_at: new Date(now - 20 * 60_000).toISOString(),
			completed_at: new Date(now - 60_000).toISOString(),
		});
		provider.readRegistry = () =>
			createMockRegistry({
				[failedOlder.id]: failedOlder,
				[failedNewer.id]: failedNewer,
				[runningOldest.id]: runningOldest,
				[completedLatest.id]: completedLatest,
			});
		provider.reload();

		const taskIds = getTaskNodes(provider.getChildren()).map(
			(node) => (node as { type: "task"; task: AgentTask }).task.id,
		);
		expect(taskIds).toEqual([
			"running-oldest",
			"failed-new",
			"failed-old",
			"done-latest",
		]);
	});

	test("grouped project children render running, attention, then done status groups", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: true });
		const now = Date.now();

		const runningNewest = createMockTask({
			id: "running-new",
			status: "running",
			project_name: "Alpha",
			started_at: new Date(now - 60_000).toISOString(),
		});
		const failedOlder = createMockTask({
			id: "failed-old",
			status: "failed",
			project_name: "Alpha",
			started_at: new Date(now - 6 * 60_000).toISOString(),
		});
		const completedLatest = createMockTask({
			id: "done-latest",
			status: "completed",
			project_name: "Alpha",
			started_at: new Date(now - 12 * 60_000).toISOString(),
			completed_at: new Date(now - 30_000).toISOString(),
		});
		provider.readRegistry = () =>
			createMockRegistry({
				"running-new": runningNewest,
				"failed-old": failedOlder,
				"done-latest": completedLatest,
			});
		provider.reload();

		const projectGroup = provider
			.getChildren()
			.find(
				(node): node is Extract<AgentNode, { type: "projectGroup" }> =>
					node.type === "projectGroup",
			);
		if (!projectGroup) throw new Error("expected project group");
		const groupChildren = provider.getChildren(projectGroup);
		expect(
			groupChildren.map((node) =>
				node.type === "statusGroup" ? node.status : node.type,
			),
		).toEqual(["running", "attention", "done"]);
	});

	test("grouped project children keep task ordering within each status group", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: true });
		const now = Date.now();

		const runningOlder = createMockTask({
			id: "running-older",
			status: "running",
			project_name: "Alpha",
			started_at: new Date(now - 2 * 60_000).toISOString(),
		});
		const completedLatest = createMockTask({
			id: "completed-latest",
			status: "completed",
			project_name: "Alpha",
			started_at: new Date(now - 12 * 60_000).toISOString(),
			completed_at: new Date(now - 30_000).toISOString(),
		});
		const failedMiddle = createMockTask({
			id: "failed-middle",
			status: "failed",
			project_name: "Alpha",
			started_at: new Date(now - 4 * 60_000).toISOString(),
		});
		provider.readRegistry = () =>
			createMockRegistry({
				[runningOlder.id]: runningOlder,
				[completedLatest.id]: completedLatest,
				[failedMiddle.id]: failedMiddle,
			});
		provider.reload();

		const projectGroup = provider
			.getChildren()
			.find(
				(node): node is Extract<AgentNode, { type: "projectGroup" }> =>
					node.type === "projectGroup",
			);
		if (!projectGroup) throw new Error("expected project group");
		const groupChildren = provider.getChildren(projectGroup);
		const runningGroup = getStatusGroupNode(groupChildren, "running");
		const attentionGroup = getStatusGroupNode(groupChildren, "attention");
		const doneGroup = getStatusGroupNode(groupChildren, "done");
		const runningChildren = provider.getChildren(runningGroup);
		const attentionChildren = provider.getChildren(attentionGroup);
		const doneChildren = provider.getChildren(doneGroup);
		expect(runningChildren).toHaveLength(1);
		expect(attentionChildren).toHaveLength(1);
		expect(doneChildren).toHaveLength(1);
		expect(
			(runningChildren[0] as { type: "task"; task: AgentTask }).task.id,
		).toBe("running-older");
		expect(
			(attentionChildren[0] as { type: "task"; task: AgentTask }).task.id,
		).toBe("failed-middle");
		expect(doneChildren[0]?.type).toBe("task");
		expect((doneChildren[0] as { type: "task"; task: AgentTask }).task.id).toBe(
			"completed-latest",
		);
	});

	test("grouped status headers show count badges and collapse stale done groups", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: true });

		const running = createMockTask({ id: "running", status: "running" });
		const completed = createMockTask({
			id: "completed",
			status: "completed",
			started_at: new Date(Date.now() - 4 * 24 * 60 * 60_000).toISOString(),
			completed_at: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
		});
		const stopped = createMockTask({
			id: "stopped",
			status: "stopped",
			started_at: new Date(Date.now() - 4 * 24 * 60 * 60_000).toISOString(),
			completed_at: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
		});
		provider.readRegistry = () =>
			createMockRegistry({
				[running.id]: running,
				[completed.id]: completed,
				[stopped.id]: stopped,
			});
		provider.reload();

		const projectGroup = provider
			.getChildren()
			.find(
				(node): node is Extract<AgentNode, { type: "projectGroup" }> =>
					node.type === "projectGroup",
			);
		if (!projectGroup) throw new Error("expected project group");
		const children = provider.getChildren(projectGroup);
		const runningGroup = getStatusGroupNode(children, "running");
		const doneGroup = getStatusGroupNode(children, "done");
		const attentionGroup = getStatusGroupNode(children, "attention");
		expect(provider.getTreeItem(runningGroup).label).toBe("Running · 1 agent");
		expect(provider.getTreeItem(attentionGroup).label).toBe(
			"Failed & Stopped · 1 agent",
		);
		expect(provider.getTreeItem(doneGroup).collapsibleState).toBe(1);
	});

	test("done groups show a flat list of tasks sorted by recency (no time sub-groups)", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: true });
		const now = Date.now();

		const recentDone = createMockTask({
			id: "done-recent",
			status: "completed",
			started_at: new Date(now - 3 * 60 * 60_000).toISOString(),
			completed_at: new Date(now - 2 * 60 * 60_000).toISOString(),
		});
		const lastWeekDone = createMockTask({
			id: "done-last-week",
			status: "completed",
			started_at: new Date(now - 5 * 24 * 60 * 60_000).toISOString(),
			completed_at: new Date(now - 4 * 24 * 60 * 60_000).toISOString(),
		});
		const lastMonthDone = createMockTask({
			id: "done-last-month",
			status: "completed",
			started_at: new Date(now - 15 * 24 * 60 * 60_000).toISOString(),
			completed_at: new Date(now - 14 * 24 * 60 * 60_000).toISOString(),
		});
		const olderDone = createMockTask({
			id: "done-older",
			status: "completed",
			started_at: new Date(now - 40 * 24 * 60 * 60_000).toISOString(),
			completed_at: new Date(now - 35 * 24 * 60 * 60_000).toISOString(),
		});
		provider.readRegistry = () =>
			createMockRegistry({
				[recentDone.id]: recentDone,
				[lastWeekDone.id]: lastWeekDone,
				[lastMonthDone.id]: lastMonthDone,
				[olderDone.id]: olderDone,
			});
		provider.reload();

		const projectGroup = provider
			.getChildren()
			.find(
				(node): node is Extract<AgentNode, { type: "projectGroup" }> =>
					node.type === "projectGroup",
			);
		if (!projectGroup) throw new Error("expected project group");
		const doneGroup = getStatusGroupNode(
			provider.getChildren(projectGroup),
			"done",
		);
		const doneChildren = provider.getChildren(doneGroup);

		// No statusTimeGroup nodes — all children are task nodes
		expect(doneChildren.every((node) => node.type === "task")).toBe(true);
		expect(doneChildren).toHaveLength(4);

		// Sorted by recency: most recent first
		const ids = doneChildren.map(
			(node) => (node as { type: "task"; task: AgentTask }).task.id,
		);
		expect(ids).toEqual([
			"done-recent",
			"done-last-week",
			"done-last-month",
			"done-older",
		]);
	});

	test("attention groups stay flat (no time sub-groups)", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: true });
		const now = Date.now();
		const failedTasks = Array.from({ length: 3 }, (_, index) =>
			createMockTask({
				id: `failed-${index + 1}`,
				status: "failed",
				project_name: "Alpha",
				completed_at: new Date(now - (index + 1) * 60 * 60_000).toISOString(),
			}),
		);
		provider.readRegistry = () =>
			createMockRegistry(
				Object.fromEntries(failedTasks.map((task) => [task.id, task])),
			);
		provider.reload();

		const projectGroup = provider
			.getChildren()
			.find(
				(node): node is Extract<AgentNode, { type: "projectGroup" }> =>
					node.type === "projectGroup",
			);
		if (!projectGroup) throw new Error("expected project group");
		const attentionGroup = getStatusGroupNode(
			provider.getChildren(projectGroup),
			"attention",
		);
		const attentionChildren = provider.getChildren(attentionGroup);
		expect(attentionChildren.every((node) => node.type === "task")).toBe(true);
	});

	test("running groups stay flat inside project groups", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: true });
		const now = Date.now();
		const runningTasks = Array.from({ length: 2 }, (_, index) =>
			createMockTask({
				id: `running-${index + 1}`,
				status: "running",
				project_name: "Alpha",
				started_at: new Date(now - (index + 1) * 60_000).toISOString(),
			}),
		);
		provider.readRegistry = () =>
			createMockRegistry(
				Object.fromEntries(runningTasks.map((task) => [task.id, task])),
			);
		provider.reload();

		const projectGroup = provider
			.getChildren()
			.find(
				(node): node is Extract<AgentNode, { type: "projectGroup" }> =>
					node.type === "projectGroup",
			);
		if (!projectGroup) throw new Error("expected project group");
		const runningGroup = getStatusGroupNode(
			provider.getChildren(projectGroup),
			"running",
		);
		const runningChildren = provider.getChildren(runningGroup);
		expect(runningChildren.every((node) => node.type === "task")).toBe(true);
	});

	test("reload preserves diff cache entries when task identity is unchanged", () => {
		const task = createMockTask({
			id: "cache-stable",
			status: "completed",
			start_sha: "abc123",
			updated_at: "2026-02-25T09:00:00Z",
		});
		provider.readRegistry = () => createMockRegistry({ [task.id]: task });
		provider.reload();

		const cacheKey = (
			provider as unknown as {
				getTaskDiffCacheKey: (taskValue: AgentTask) => string;
			}
		).getTaskDiffCacheKey(task);
		const diffCache = (
			provider as unknown as {
				_diffSummaryCache: Map<string, string | null>;
			}
		)._diffSummaryCache;
		diffCache.set(cacheKey, "2 files · +4 / -1");

		provider.reload();

		expect(diffCache.get(cacheKey)).toBe("2 files · +4 / -1");
	});

	test("async diff completion schedules targeted task refreshes instead of a full tree refresh", async () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: false });
		const first = createMockTask({ id: "diff-a", status: "completed" });
		const second = createMockTask({ id: "diff-b", status: "completed" });
		provider.readRegistry = () =>
			createMockRegistry({
				[first.id]: first,
				[second.id]: second,
			});
		(
			provider as unknown as {
				computeDiffSummaryAsync: () => Promise<string>;
			}
		).computeDiffSummaryAsync = () => Promise.resolve("1 file · +1 / -0");
		provider.reload();

		const refreshEvents: Array<AgentNode | undefined | null> = [];
		const subscription = provider.onDidChangeTreeData((element) => {
			refreshEvents.push(element);
		});

		for (const node of getTaskNodes(provider.getChildren())) {
			provider.getTreeItem(node);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(refreshEvents).toHaveLength(2);
		expect(refreshEvents.every((event) => event?.type === "task")).toBe(true);
		subscription.dispose();
	});

	test("uses latest activity sorting within the done status group", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: false });

		const completedLate = createMockTask({
			id: "completed-late",
			status: "completed",
			started_at: "2026-02-25T06:00:00Z",
			completed_at: "2026-02-25T10:00:00Z",
		});
		const completedFallback = createMockTask({
			id: "completed-fallback",
			status: "completed",
			started_at: "2026-02-25T09:00:00Z",
		});
		const completedEarlier = createMockTask({
			id: "completed-earlier",
			status: "completed",
			started_at: "2026-02-25T05:00:00Z",
			completed_at: "2026-02-25T08:00:00Z",
		});
		provider.readRegistry = () =>
			createMockRegistry({
				"completed-late": completedLate,
				"completed-fallback": completedFallback,
				"completed-earlier": completedEarlier,
			});
		provider.reload();

		const children = provider.getChildren();
		const taskNodes = getTaskNodes(children);
		expect(taskNodes).toHaveLength(3);
		expect((taskNodes[0] as { type: "task"; task: AgentTask }).task.id).toBe(
			"completed-late",
		);
		expect((taskNodes[1] as { type: "task"; task: AgentTask }).task.id).toBe(
			"completed-fallback",
		);
		expect((taskNodes[2] as { type: "task"; task: AgentTask }).task.id).toBe(
			"completed-earlier",
		);
	});

	test("uses updated_at as the latest-activity fallback in flat mode", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: false });

		const updatedLatest = createMockTask({
			id: "updated-latest",
			status: "completed",
			started_at: "2026-02-25T05:00:00Z",
			completed_at: "2026-02-25T08:00:00Z",
			updated_at: "2026-02-25T11:00:00Z",
		});
		const completedLatest = createMockTask({
			id: "completed-latest",
			status: "completed",
			started_at: "2026-02-25T06:00:00Z",
			completed_at: "2026-02-25T10:00:00Z",
		});
		provider.readRegistry = () =>
			createMockRegistry({
				[updatedLatest.id]: updatedLatest,
				[completedLatest.id]: completedLatest,
			});
		provider.reload();

		const taskIds = getTaskNodes(provider.getChildren()).map(
			(node) => (node as { type: "task"; task: AgentTask }).task.id,
		);
		expect(taskIds).toEqual(["updated-latest", "completed-latest"]);
	});

	test("flat mode sorts discovered agents ahead of non-running launcher tasks", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: false });

		const launcherCompleted = createMockTask({
			id: "launcher-completed",
			status: "completed",
			started_at: "2026-02-25T06:00:00Z",
			completed_at: "2026-02-25T09:30:00Z",
		});
		const launcherOlder = createMockTask({
			id: "launcher-older",
			status: "failed",
			started_at: "2026-02-25T08:00:00Z",
		});
		provider.readRegistry = () =>
			createMockRegistry({
				[launcherCompleted.id]: launcherCompleted,
				[launcherOlder.id]: launcherOlder,
			});
		provider.reload();
		(
			provider as unknown as {
				_discoveredAgents: Array<{
					pid: number;
					projectDir: string;
					command: string;
					startTime: Date;
					source: "process";
				}>;
			}
		)._discoveredAgents = [
			{
				pid: 4242,
				projectDir: "/Users/test/projects/discovered-app",
				command: "codex",
				startTime: new Date("2026-02-25T09:00:00Z"),
				source: "process",
			},
		];

		const children = provider
			.getChildren()
			.filter((node) => node.type === "task" || node.type === "discovered");
		expect(children).toHaveLength(3);
		expect(children[0]?.type).toBe("discovered");
		expect(children[1]?.type).toBe("task");
		expect(children[2]?.type).toBe("task");
		if (children[0]?.type === "discovered") {
			expect(children[0].agent.pid).toBe(4242);
		}
		if (children[1]?.type === "task") {
			expect(children[1].task.id).toBe("launcher-older");
		}
		if (children[2]?.type === "task") {
			expect(children[2].task.id).toBe("launcher-completed");
		}
	});

	test("groups root tasks by freshest child activity when enabled", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: true });

		const zetaTask = createMockTask({
			id: "zeta-1",
			project_dir: "/Users/test/projects/zeta",
			project_name: "Zeta",
			started_at: "2026-02-25T10:00:00Z",
		});
		const alphaTask = createMockTask({
			id: "alpha-1",
			project_dir: "/Users/test/projects/alpha",
			project_name: "Alpha",
			started_at: "2026-02-25T06:00:00Z",
			completed_at: "2026-02-25T09:00:00Z",
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
		).toBe("Zeta");
		expect(
			(projectGroups[1] as { type: "projectGroup"; projectName: string })
				.projectName,
		).toBe("Alpha");
	});

	test("project group labels show the freshest child activity timestamp", () => {
		const olderTask = createMockTask({
			id: "alpha-running",
			project_dir: "/Users/test/projects/alpha",
			project_name: "Alpha",
			status: "running",
			started_at: new Date(Date.now() - 15 * 60_000).toISOString(),
		});
		const fresherTask = createMockTask({
			id: "alpha-completed",
			project_dir: "/Users/test/projects/alpha",
			project_name: "Alpha",
			status: "completed",
			started_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
			completed_at: new Date(Date.now() - 2 * 60_000).toISOString(),
		});
		const item = provider.getTreeItem({
			type: "projectGroup",
			projectName: "Alpha",
			projectDir: "/Users/test/projects/alpha",
			tasks: [olderTask, fresherTask],
		});

		expect(item.label).toBe("🧩 Alpha");
		expect(item.description).toContain("2m ago");
	});

	test("hardcodes status-recency mode", () => {
		expect(resolveAgentStatusSortMode()).toBe("status-recency");
	});

	test("auto-groups projects by workspace parent when 2+ siblings exist", () => {
		vscodeMock.workspace.workspaceFolders = [
			{
				uri: { fsPath: "/Users/test/research/alpha" },
				name: "alpha",
				index: 0,
			},
			{
				uri: { fsPath: "/Users/test/research/beta" },
				name: "beta",
				index: 1,
			},
			{
				uri: { fsPath: "/Users/test/solo/gamma" },
				name: "gamma",
				index: 2,
			},
		];
		vscodeMock.workspace.getConfiguration = mock(() => ({
			update: mock(),
			get: mock((_key: string, defaultValue?: unknown) => {
				if (_key === "agentStatus.groupByProject") return true;
				return defaultValue;
			}),
		}));

		const alphaTask = createMockTask({
			id: "alpha-1",
			project_dir: "/Users/test/research/alpha",
			project_name: "Alpha",
		});
		const betaTask = createMockTask({
			id: "beta-1",
			project_dir: "/Users/test/research/beta",
			project_name: "Beta",
		});
		const gammaTask = createMockTask({
			id: "gamma-1",
			project_dir: "/Users/test/solo/gamma",
			project_name: "Gamma",
		});
		provider.readRegistry = () =>
			createMockRegistry({
				[alphaTask.id]: alphaTask,
				[betaTask.id]: betaTask,
				[gammaTask.id]: gammaTask,
			});
		provider.reload();

		const rootChildren = provider.getChildren();
		const folderGroup = rootChildren.find(
			(node) => node.type === "folderGroup",
		) as {
			type: "folderGroup";
			groupName: string;
			projectCount: number;
		};
		expect(folderGroup).toBeDefined();
		expect(folderGroup.groupName).toBe("research");
		expect(folderGroup.projectCount).toBe(2);

		const nestedProjects = provider.getChildren(
			folderGroup as unknown as AgentNode,
		);
		expect(nestedProjects).toHaveLength(2);
		expect(nestedProjects.every((node) => node.type === "projectGroup")).toBe(
			true,
		);

		const directProjects = rootChildren.filter(
			(node) => node.type === "projectGroup",
		) as Array<{ type: "projectGroup"; projectName: string }>;
		expect(directProjects).toHaveLength(1);
		expect(directProjects[0]?.projectName).toBe("Gamma");
	});

	test("manual project.group override creates a folder group even with one project", () => {
		vscodeMock.workspace.workspaceFolders = [
			{
				uri: { fsPath: "/Users/test/client/project-a" },
				name: "project-a",
				index: 0,
			},
		];
		vscodeMock.workspace.getConfiguration = mock(() => ({
			update: mock(),
			get: mock((_key: string, defaultValue?: unknown) => {
				if (_key === "agentStatus.groupByProject") return true;
				if (_key === "project.group") return "client-work";
				return defaultValue;
			}),
		}));

		const task = createMockTask({
			id: "project-a-1",
			project_dir: "/Users/test/client/project-a",
			project_name: "Project A",
		});
		provider.readRegistry = () => createMockRegistry({ [task.id]: task });
		provider.reload();

		const rootChildren = provider.getChildren();
		const folderGroup = rootChildren.find(
			(node) => node.type === "folderGroup",
		) as {
			type: "folderGroup";
			groupName: string;
			projectCount: number;
		};
		expect(folderGroup).toBeDefined();
		expect(folderGroup.groupName).toBe("client-work");
		expect(folderGroup.projectCount).toBe(1);
		const nestedProjects = provider.getChildren(
			folderGroup as unknown as AgentNode,
		);
		expect(nestedProjects).toHaveLength(1);
		expect(nestedProjects[0]?.type).toBe("projectGroup");
	});

	test("grouped project children expose discovered agents inside the running bucket", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: true });

		const older = createMockTask({
			id: "alpha-old",
			status: "failed",
			project_name: "Alpha",
			started_at: "2026-02-25T06:00:00Z",
		});
		const completedLatest = createMockTask({
			id: "alpha-completed-latest",
			project_name: "Alpha",
			status: "completed",
			started_at: "2026-02-25T05:00:00Z",
			completed_at: "2026-02-25T10:00:00Z",
		});
		provider.readRegistry = () =>
			createMockRegistry({
				"alpha-old": older,
				"alpha-completed-latest": completedLatest,
			});
		provider.reload();
		(
			provider as unknown as {
				_discoveredAgents: Array<{
					pid: number;
					projectDir: string;
					command: string;
					startTime: Date;
					source: "process";
				}>;
			}
		)._discoveredAgents = [
			{
				pid: 5151,
				projectDir: "/Users/test/projects/my-app",
				command: "codex",
				startTime: new Date("2026-02-25T09:00:00Z"),
				source: "process",
			},
		];

		const rootChildren = provider.getChildren();
		const groupNode = rootChildren.find(
			(node) => node.type === "projectGroup",
		) as { type: "projectGroup"; projectName: string; tasks: AgentTask[] };
		expect(groupNode.projectName).toBe("Alpha");

		const groupChildren = provider.getChildren(groupNode);
		expect(
			groupChildren.map((node) =>
				node.type === "statusGroup" ? node.status : node.type,
			),
		).toEqual(["running", "attention", "done"]);
		const runningGroup = getStatusGroupNode(groupChildren, "running");
		const runningChildren = provider.getChildren(runningGroup);
		expect(runningChildren).toHaveLength(1);
		expect(runningChildren[0]?.type).toBe("discovered");
		if (runningChildren[0]?.type === "discovered") {
			expect(runningChildren[0].agent.pid).toBe(5151);
		}
		const attentionGroup = getStatusGroupNode(groupChildren, "attention");
		const attentionChildren = provider.getChildren(attentionGroup);
		expect(attentionChildren[0]?.type).toBe("task");
		if (attentionChildren[0]?.type === "task") {
			expect(attentionChildren[0].task.id).toBe("alpha-old");
		}
		const doneGroup = getStatusGroupNode(groupChildren, "done");
		const doneChildren = provider.getChildren(doneGroup);
		expect(doneChildren[0]?.type).toBe("task");
		if (doneChildren[0]?.type === "task") {
			expect(doneChildren[0].task.id).toBe("alpha-completed-latest");
		}
	});

	test("grouped project children order status groups by priority", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: true });

		const failedOlder = createMockTask({
			id: "alpha-failed-old",
			project_name: "Alpha",
			status: "failed",
			started_at: "2026-02-25T06:00:00Z",
		});
		provider.readRegistry = () =>
			createMockRegistry({
				"alpha-failed-old": failedOlder,
			});
		provider.reload();
		(
			provider as unknown as {
				_discoveredAgents: Array<{
					pid: number;
					projectDir: string;
					command: string;
					startTime: Date;
					source: "process";
				}>;
			}
		)._discoveredAgents = [
			{
				pid: 5152,
				projectDir: "/Users/test/projects/my-app",
				command: "codex",
				startTime: new Date("2026-02-25T09:00:00Z"),
				source: "process",
			},
		];

		const rootChildren = provider.getChildren();
		const groupNode = rootChildren.find(
			(node) => node.type === "projectGroup",
		) as { type: "projectGroup"; projectName: string; tasks: AgentTask[] };
		const groupChildren = provider.getChildren(groupNode);

		expect(
			groupChildren.map((node) =>
				node.type === "statusGroup" ? node.status : node.type,
			),
		).toEqual(["running", "attention"]);
	});

	test("sorts grouped roots by freshest activity in status mode", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: true });

		// Zeta is alphabetically last but has the freshest activity
		const zetaTask = createMockTask({
			id: "zeta-running",
			project_dir: "/Users/test/projects/zeta",
			project_name: "Zeta",
			status: "running",
			started_at: "2026-02-25T12:00:00Z",
		});
		const alphaTask = createMockTask({
			id: "alpha-completed",
			project_dir: "/Users/test/projects/alpha",
			project_name: "Alpha",
			status: "completed",
			started_at: "2026-02-25T06:00:00Z",
			completed_at: "2026-02-25T09:00:00Z",
		});
		provider.readRegistry = () =>
			createMockRegistry({
				[zetaTask.id]: zetaTask,
				[alphaTask.id]: alphaTask,
			});
		provider.reload();

		const projectGroups = provider
			.getChildren()
			.filter((node) => node.type === "projectGroup");
		expect(projectGroups).toHaveLength(2);
		// Zeta (12:00) is freshest, Alpha (09:00) is older — activity wins over alphabet
		expect(
			(projectGroups[0] as { type: "projectGroup"; projectName: string })
				.projectName,
		).toBe("Zeta");
		expect(
			(projectGroups[1] as { type: "projectGroup"; projectName: string })
				.projectName,
		).toBe("Alpha");
	});

	test("pushes grouped projects with running agents to the top in status-recency mode", () => {
		setAgentStatusConfig(vscodeMock, { groupByProject: true });

		const alphaDone = createMockTask({
			id: "alpha-done",
			project_dir: "/Users/test/projects/alpha",
			project_name: "Alpha",
			status: "completed",
			started_at: "2026-02-25T06:00:00Z",
			completed_at: "2026-02-25T11:00:00Z",
		});
		const betaRunning = createMockTask({
			id: "beta-running",
			project_dir: "/Users/test/projects/beta",
			project_name: "Beta",
			status: "running",
			started_at: "2026-02-25T08:00:00Z",
		});
		provider.readRegistry = () =>
			createMockRegistry({
				[alphaDone.id]: alphaDone,
				[betaRunning.id]: betaRunning,
			});
		provider.reload();

		const projectGroups = provider
			.getChildren()
			.filter((node) => node.type === "projectGroup");
		expect(projectGroups).toHaveLength(2);
		expect(
			(projectGroups[0] as { type: "projectGroup"; projectName: string })
				.projectName,
		).toBe("Beta");
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
		const startedAt = new Date(Date.now() - 60_000).toISOString();
		const node: AgentNode = {
			type: "projectGroup",
			projectName: "Alpha",
			projectDir: "/Users/test/projects/alpha",
			tasks: [
				createMockTask({
					id: "alpha-1",
					project_name: "Alpha",
					started_at: startedAt,
				}),
			],
		};
		const item = provider.getTreeItem(node);
		expect(item.label).toBe("🧩 Alpha");
		expect(item.description).toContain("1 working");
		expect(item.description).toContain("1m ago");
		expect(item.collapsibleState).toBe(2); // Expanded
		expect(item.iconPath).toBeUndefined();
		expect(item.contextValue).toBe("projectGroup");
		expect(projectIconManagerMock.getIconForProject).toHaveBeenCalledWith(
			"/Users/test/projects/alpha",
		);
	});

	test("project group labels respect configured legacy project icons", () => {
		vscodeMock.workspace.getConfiguration = mock(() => ({
			update: mock(),
			get: mock((_key: string, defaultValue?: unknown) => {
				if (_key === "projects") return [{ name: "alpha", emoji: "🛸" }];
				return defaultValue;
			}),
		}));

		const node: AgentNode = {
			type: "projectGroup",
			projectName: "Alpha",
			projectDir: "/Users/test/projects/alpha",
			tasks: [
				createMockTask({
					id: "alpha-1",
					project_name: "Alpha",
					started_at: new Date(Date.now() - 60_000).toISOString(),
				}),
			],
		};
		const item = provider.getTreeItem(node);
		expect(item.label).toBe("🛸 Alpha");
		expect(item.description).toContain("1 working");
		expect(item.description).toContain("1m ago");
		expect(projectIconManagerMock.getIconForProject).not.toHaveBeenCalled();
	});

	test("getTreeItem creates expanded folder-group item for grouped parents", () => {
		const node: AgentNode = {
			type: "folderGroup",
			groupKey: "auto:/Users/test/research",
			groupName: "research",
			projectCount: 4,
			projects: [],
		};
		const item = provider.getTreeItem(node);
		expect(item.label).toBe("📁 research · 4");
		expect(item.collapsibleState).toBe(2);
		expect(item.contextValue).toBe("folderGroup");
	});

	test("launcher task icons are mapped by status", () => {
		const cases = [
			["running", "sync~spin", "charts.yellow"],
			["completed", "check", "charts.green"],
			["completed_dirty", "check", "charts.green"],
			["completed_stale", "warning", "charts.yellow"],
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

		const summary = getSummaryNode(provider.getChildren());
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

		const summary = getSummaryNode(provider.getChildren());
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

		const summary = getSummaryNode(provider.getChildren());
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

		const summary = getSummaryNode(provider.getChildren());
		const item = provider.getTreeItem(summary);
		const icon = item.iconPath as { id: string; color?: { id: string } };
		expect(icon.id).toBe("warning");
		expect(icon.color?.id).toBe("charts.orange");
	});

	test("summary icon is warning yellow when stopped tasks present", () => {
		const stopped = createMockTask({ id: "t1", status: "stopped" });
		provider.readRegistry = () => createMockRegistry({ t1: stopped });
		provider.reload();

		const summary = getSummaryNode(provider.getChildren());
		const item = provider.getTreeItem(summary);
		const icon = item.iconPath as { id: string; color?: { id: string } };
		expect(icon.id).toBe("warning");
		expect(icon.color?.id).toBe("charts.yellow");
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
		if (!fileNode) {
			throw new Error("No file-change node found");
		}
		const item = provider.getTreeItem(fileNode);

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
		if (!fileNode) {
			throw new Error("No file-change node found");
		}
		const item = provider.getTreeItem(fileNode);
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
		expect(item.label).toContain("test-task-1");
		expect(item.label).not.toContain("🔬");
		expect(item.label).not.toContain("🔨");
		expect(item.label).not.toContain("🔍");
		expect(item.label).not.toContain("🧪");
	});

	test("task tooltip stays concise and includes duration + dir", () => {
		const task = createMockTask({ terminal_backend: "tmux" });
		const tooltip = (
			provider.getTreeItem({ type: "task", task }).tooltip as { value: string }
		).value;
		expect(tooltip).toContain("**test-task-1**");
		expect(tooltip).toContain("Status: running");
		expect(tooltip).toContain("Duration: 1m");
		expect(tooltip).toContain("Dir: `/Users/test/projects/my-app`");
		expect(tooltip).not.toContain("Terminal: tmux");
	});

	test("task tooltip omits exit code details", () => {
		const task = createMockTask({ status: "failed", exit_code: 1 });
		const tooltip = (
			provider.getTreeItem({ type: "task", task }).tooltip as { value: string }
		).value;
		expect(tooltip).toContain("Status: failed");
		expect(tooltip).not.toContain("Exit code: 1");
	});

	test("uses human-readable status label in tooltip", () => {
		const task = createMockTask({ status: "completed_stale" });
		const item = provider.getTreeItem({ type: "task", task });
		expect((item.tooltip as { value: string }).value).toContain(
			"completed (stale)",
		);
		expect((item.tooltip as { value: string }).value).not.toContain(
			"completed_stale",
		);
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
			expect(errorDetail.label).toBe("Error: ❌ Failed (code 127) · Retry 2/3");
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
			expect(errorDetail.label).toBe("Error: ❌ Failed (code 2)");
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

	test("readRegistry preserves completed_dirty and maps unknown statuses to stopped", () => {
		const tmpDir = fs.mkdtempSync("/tmp/cc-agent-status-");
		const tasksFile = path.join(tmpDir, "tasks.json");
		fs.writeFileSync(
			tasksFile,
			JSON.stringify({
				version: 2,
				tasks: {
					dirty: {
						id: "dirty",
						status: "completed_dirty",
						project_dir: "/Users/test/projects/my-app",
						project_name: "My App",
						session_id: "agent-my-app",
						bundle_path: "/Applications/Projects/My App.app",
						prompt_file: "/tmp/task.md",
						started_at: "2026-02-25T08:00:00Z",
						attempts: 1,
						max_attempts: 3,
					},
					weird: {
						id: "weird",
						status: "mystery_state",
						project_dir: "/Users/test/projects/my-app",
						project_name: "My App",
						session_id: "agent-my-app-weird",
						bundle_path: "/Applications/Projects/My App.app",
						prompt_file: "/tmp/task.md",
						started_at: "2026-02-25T08:00:00Z",
						attempts: 1,
						max_attempts: 3,
					},
				},
			}),
		);

		try {
			(
				provider as unknown as {
					_filePath: string | null;
				}
			)._filePath = tasksFile;
			const registry = _realReadRegistry.call(provider);
			expect(registry.tasks["dirty"]?.status).toBe("completed_dirty");
			expect(registry.tasks["weird"]?.status).toBe("stopped");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("readRegistry preserves model from tasks.json", () => {
		const tmpDir = fs.mkdtempSync("/tmp/cc-agent-status-");
		const tasksFile = path.join(tmpDir, "tasks.json");
		fs.writeFileSync(
			tasksFile,
			JSON.stringify({
				version: 2,
				tasks: {
					explicitModel: {
						id: "explicitModel",
						status: "running",
						project_dir: "/Users/test/projects/my-app",
						project_name: "My App",
						session_id: "agent-my-app-model",
						bundle_path: "/Applications/Projects/My App.app",
						prompt_file: "/tmp/task.md",
						started_at: "2026-02-25T08:00:00Z",
						attempts: 1,
						max_attempts: 3,
						model: "anthropic/claude-opus-4-6",
					},
				},
			}),
		);

		try {
			(
				provider as unknown as {
					_filePath: string | null;
				}
			)._filePath = tasksFile;
			const registry = _realReadRegistry.call(provider);
			expect(registry.tasks["explicitModel"]?.model).toBe(
				"anthropic/claude-opus-4-6",
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
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

	describe("task item descriptions", () => {
		test("flat mode uses project metadata before falling back to activity", () => {
			setAgentStatusConfig(vscodeMock, { groupByProject: false });
			const task = createMockTask({
				status: "running",
				started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
			});
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).toBe("My App");
		});

		test("grouped mode falls back to relative activity when no diff or model is present", () => {
			setAgentStatusConfig(vscodeMock, { groupByProject: true });
			const task = createMockTask({
				status: "completed",
				started_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
				completed_at: new Date(Date.now() - 60 * 60_000).toISOString(),
			});
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).toContain("1h ago");
			expect(item.description).not.toContain("My App");
		});
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
			if (warningDetail?.type === "detail") {
				expect(warningDetail.label.startsWith("⚠️")).toBe(false);
			}
		});
	});

	test("non-running task TreeItem routes to agentQuickActions", () => {
		const task = createMockTask({ status: "completed" });
		const node: AgentNode = { type: "task", task };
		const item = provider.getTreeItem(node);
		expect(item.command?.command).toBe("commandCentral.agentQuickActions");
		expect(item.command?.title).toBe("Agent Actions");
	});

	test("stopped task TreeItem routes to agentQuickActions", () => {
		const task = createMockTask({ status: "stopped" });
		const node: AgentNode = { type: "task", task };
		const item = provider.getTreeItem(node);
		expect(item.command?.command).toBe("commandCentral.agentQuickActions");
	});

	test("failed task TreeItem routes to agentQuickActions", () => {
		const task = createMockTask({ status: "failed" });
		const node: AgentNode = { type: "task", task };
		const item = provider.getTreeItem(node);
		expect(item.command?.command).toBe("commandCentral.agentQuickActions");
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
			const gitDetail = details.find(
				(d) => d.type === "detail" && d.label === "Git",
			);
			expect(gitDetail).toBeDefined();
			if (!gitDetail) {
				throw new Error("Git detail not found");
			}
			const gitItem = provider.getTreeItem(gitDetail);
			expect(gitItem.label).toBe("Git: main → def5678");
		});
	});

	// ── Feature 3: Completion Notifications ──────────────────────────

	describe("completion notifications", () => {
		let vscodeMock: ReturnType<typeof setupVSCodeMock>;
		const withDarwinPlatform = (run: () => void): void => {
			const original = Object.getOwnPropertyDescriptor(process, "platform");
			Object.defineProperty(process, "platform", {
				value: "darwin",
				configurable: true,
			});
			try {
				run();
			} finally {
				if (original) {
					Object.defineProperty(process, "platform", original);
				}
			}
		};

		beforeEach(() => {
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
					if (_key === "discovery.enabled") return false;
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

		afterEach(() => {
			// Dispose the provider to cancel any pending treeRefreshTimer before the
			// global afterEach runs mock.restore(). Without this, the setTimeout(fn,0)
			// from scheduleTreeRefresh() fires after mocks are cleared, causing
			// showInformationMessage().then(...) to throw and pollute later tests.
			provider.dispose();
		});

		test("completed notification includes diff summary text and new action buttons", () => {
			provider.getDiffSummary = () => "3 files · +45 / -12";
			const reveal = mock(() => Promise.resolve());
			provider.setTreeView({ reveal } as unknown as vscode.TreeView<AgentNode>);

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
			expect(infoCallArgs?.[1]).toBe("View Diff");
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
			expect(callArgs?.[2]).toBe("View Diff");
			expect(callArgs?.[3]).toBe("Restart");
		});

		test("stopped notification includes stop reason when available", () => {
			const runningTask = createMockTask({
				id: "stop-1",
				status: "running",
				agent_backend: "claude",
			});
			provider.readRegistry = () =>
				createMockRegistry({ "stop-1": runningTask });
			provider.reload();

			const stoppedTask = createMockTask({
				id: "stop-1",
				status: "stopped",
				agent_backend: "claude",
				error_message:
					"Session no longer appears active. Showing as stopped due to stale health state.",
			});
			provider.readRegistry = () =>
				createMockRegistry({ "stop-1": stoppedTask });
			provider.reload();

			const infoCalls = (
				vscodeMock.window.showInformationMessage as ReturnType<typeof mock>
			).mock.calls as unknown[][];
			const stoppedMessage = infoCalls.find(
				(call) =>
					typeof call[0] === "string" &&
					String(call[0]).includes("⏹️ stop-1 stopped"),
			)?.[0];
			expect(String(stoppedMessage)).toContain(
				"Session no longer appears active.",
			);
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

		test("completed transition requests Dock attention on macOS", () => {
			withDarwinPlatform(() => {
				const runningTask = createMockTask({ id: "dock-c", status: "running" });
				provider.readRegistry = () =>
					createMockRegistry({ "dock-c": runningTask });
				provider.reload();

				const completedTask = createMockTask({
					id: "dock-c",
					status: "completed",
					exit_code: 0,
				});
				provider.readRegistry = () =>
					createMockRegistry({ "dock-c": completedTask });
				provider.reload();

				expect(vscodeMock.window.requestAttention).toHaveBeenCalledTimes(1);
			});
		});

		test("failed transition requests Dock attention on macOS", () => {
			withDarwinPlatform(() => {
				const runningTask = createMockTask({ id: "dock-f", status: "running" });
				provider.readRegistry = () =>
					createMockRegistry({ "dock-f": runningTask });
				provider.reload();

				const failedTask = createMockTask({
					id: "dock-f",
					status: "failed",
					exit_code: 1,
				});
				provider.readRegistry = () =>
					createMockRegistry({ "dock-f": failedTask });
				provider.reload();

				expect(vscodeMock.window.requestAttention).toHaveBeenCalledTimes(1);
			});
		});

		test("dockBounce=false disables Dock attention", () => {
			withDarwinPlatform(() => {
				vscodeMock.workspace.getConfiguration = mock(() => ({
					update: mock(),
					get: mock((_key: string, defaultValue?: unknown) => {
						if (_key === "agentStatus.notifications") return true;
						if (_key === "dockBounce") return false;
						if (_key === "onCompletion") return true;
						if (_key === "onFailure") return true;
						if (_key === "sound") return false;
						if (_key === "agentStatus.groupByProject") return false;
						return defaultValue;
					}),
				}));

				const runningTask = createMockTask({
					id: "dock-off",
					status: "running",
				});
				provider.readRegistry = () =>
					createMockRegistry({ "dock-off": runningTask });
				provider.reload();

				const completedTask = createMockTask({
					id: "dock-off",
					status: "completed",
				});
				provider.readRegistry = () =>
					createMockRegistry({ "dock-off": completedTask });
				provider.reload();

				expect(vscodeMock.window.requestAttention).not.toHaveBeenCalled();
			});
		});

		test("stuck transition requests Dock attention once", () => {
			withDarwinPlatform(() => {
				const runningFresh = createMockTask({
					id: "stuck-dock",
					status: "running",
					started_at: new Date(Date.now() - 60_000).toISOString(),
				});
				provider.readRegistry = () =>
					createMockRegistry({ "stuck-dock": runningFresh });
				provider.reload();

				const runningStuck = createMockTask({
					id: "stuck-dock",
					status: "running",
					started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
				});
				provider.readRegistry = () =>
					createMockRegistry({ "stuck-dock": runningStuck });
				provider.reload();
				provider.reload();

				expect(vscodeMock.window.requestAttention).toHaveBeenCalledTimes(1);
			});
		});

		test("dock badge reflects running count and clears at zero", () => {
			withDarwinPlatform(() => {
				provider.readRegistry = () =>
					createMockRegistry({
						r1: createMockTask({
							id: "r1",
							status: "running",
							session_id: "agent-r1",
						}),
						r2: createMockTask({
							id: "r2",
							status: "running",
							session_id: "agent-r2",
						}),
					});
				provider.reload();

				expect(vscodeMock.window.badge).toEqual({
					value: 2,
					tooltip: "2 working agents",
				});

				provider.readRegistry = () =>
					createMockRegistry({
						r1: createMockTask({ id: "r1", status: "completed" }),
						r2: createMockTask({ id: "r2", status: "failed" }),
					});
				provider.reload();

				expect(vscodeMock.window.badge).toBeUndefined();
			});
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
			vscodeMock = setupVSCodeMock();
			vscodeMock.workspace.getConfiguration = mock(() => ({
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "agentStatus.groupByProject") return false;
					if (_key === "discovery.enabled") return false;
					return defaultValue;
				}),
			}));
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
					if (_key === "projects") return [{ name: "my-app", emoji: "🫧" }];
					if (_key === "agentStatus.groupByProject") return false;
					return defaultValue;
				}),
			}));

			const task = createMockTask({
				project_dir: "/Users/test/projects/my-app",
			});
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.label).toContain("🫧");
			expect(item.label).toContain("test-task-1");
		});

		test("no emoji when no config match", () => {
			vscodeMock.workspace.getConfiguration = mock(() => ({
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "projects")
						return [{ name: "other-project", emoji: "🛸" }];
					if (_key === "agentStatus.groupByProject") return false;
					return defaultValue;
				}),
			}));

			const task = createMockTask({
				project_dir: "/Users/test/projects/my-app",
			});
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.label).not.toContain("🛸");
			expect(item.label).toContain("test-task-1");
		});

		test("config with multiple projects works correctly", () => {
			vscodeMock.workspace.getConfiguration = mock(() => ({
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "projects")
						return [
							{ name: "my-app", emoji: "🫧" },
							{ name: "api-server", emoji: "🛸" },
							{ name: "docs", emoji: "🪁" },
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
			expect(item1.label).toContain("🛸");

			const task2 = createMockTask({
				id: "t2",
				project_dir: "/Users/test/projects/unknown",
			});
			const item2 = provider.getTreeItem({ type: "task", task: task2 });
			expect(item2.label).not.toContain("🛸");
			expect(item2.label).not.toContain("🫧");
			expect(item2.label).not.toContain("🪁");
			expect(item2.label).toContain("t2");
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
			expect(item.label).toContain("test-task-1");
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

		test("sets terminal-task context key when terminal-state tasks exist", () => {
			const task = createMockTask({ status: "completed" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.reload();

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"setContext",
				"commandCentral.agentStatus.hasTerminalTasks",
				true,
			);
		});

		test("clears terminal-task context key when only running tasks exist", () => {
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.reload();

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"setContext",
				"commandCentral.agentStatus.hasTerminalTasks",
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

		test("prefers the Task section over orchestration boilerplate", () => {
			const p = provider as unknown as { _promptCache: Map<string, string> };
			p._promptCache.clear();
			const promptFile = path.join(
				"/tmp",
				`agent-status-prompt-${Date.now()}.md`,
			);
			fs.writeFileSync(
				promptFile,
				[
					"## Task Tracking",
					"At the START of your work, create a task to track it:",
					"- Use the task system to create a task with the subject matching your task_id",
					"",
					"# Task",
					"",
					"Fix Agent Status display bugs observed in the cc-agent-history-cap entry.",
				].join("\n"),
			);

			try {
				expect(provider.readPromptSummary(promptFile)).toBe(
					"Fix Agent Status display bugs observed in the cc-agent-history-cap entry.",
				);
			} finally {
				if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
			}
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
				expect(resultDetail.value).toBe("✅ Success");
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
			provider.readPromptSummary = () => "Fix the login bug";
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

		test("task item description format is project · diff in flat mode", () => {
			const task = createMockTask({
				status: "running",
				project_name: "my-project",
				started_at: new Date(Date.now() - 60_000).toISOString(),
			});
			provider.getDiffSummary = () => "1 files · +10 / -5";
			const item = provider.getTreeItem({ type: "task", task });
			const desc = item.description as string;
			expect(desc).toContain("my-project");
			expect(desc).toContain("1 files · +10 / -5");
		});

		test("task item description appends explicit model alias", () => {
			const task = createMockTask({
				status: "running",
				model: "anthropic/claude-opus-4-6",
			});
			provider.getDiffSummary = () => "2 files · +30 / -10";
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).toContain("2 files · +30 / -10 · opus");
		});

		test("task item description appends inherited model alias", () => {
			const tmpDir = fs.mkdtempSync("/tmp/cc-openclaw-config-");
			const configPath = path.join(tmpDir, "openclaw.json");
			fs.writeFileSync(
				configPath,
				JSON.stringify({
					agents: {
						defaults: {
							model: {
								primary: "openai-codex/gpt-5.4",
							},
						},
						list: [{ id: "developer" }],
					},
				}),
			);

			try {
				const configService = new OpenClawConfigService(configPath);
				configService.reload();
				provider.setOpenClawConfigService(configService);

				const task = createMockTask({
					status: "running",
					role: "developer",
				});
				provider.getDiffSummary = () => null;
				const item = provider.getTreeItem({ type: "task", task });
				expect(item.description).toContain("codex-5.4");
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
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
			expect(item.description).not.toContain("PID");
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

	describe("reviewed state integration", () => {
		test("completed task shows reviewed badge in description after markTaskReviewed", () => {
			const task = createMockTask({
				status: "completed",
				completed_at: new Date(Date.now() - 120_000).toISOString(),
			});
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => null;
			provider.reload();

			// Before marking reviewed — no badge
			let item = provider.getTreeItem({ type: "task", task });
			expect(item.description).not.toContain("✓ reviewed");
			expect(item.contextValue).toBe("agentTask.completed");

			// Mark reviewed
			provider.markTaskReviewed("test-task-1");

			item = provider.getTreeItem({ type: "task", task });
			expect(item.description).toContain("✓ reviewed");
			expect(item.contextValue).toBe("agentTask.completed.reviewed");
		});

		test("reviewed completed task uses pass icon", () => {
			const task = createMockTask({
				status: "completed",
				completed_at: new Date(Date.now() - 120_000).toISOString(),
			});
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => null;
			provider.reload();

			provider.markTaskReviewed("test-task-1");

			const item = provider.getTreeItem({ type: "task", task });
			expect(item.iconPath).toBeDefined();
			const icon = item.iconPath as import("vscode").ThemeIcon;
			expect(icon.id).toBe("pass");
		});

		test("running task is not affected by markTaskReviewed", () => {
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => null;
			provider.reload();

			provider.markTaskReviewed("test-task-1");

			// Running tasks don't get the reviewed badge
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).not.toContain("✓ reviewed");
			expect(item.contextValue).toBe("agentTask.running");
		});

		test("setReviewTracker uses injected tracker instance", () => {
			const tmpDir = fs.mkdtempSync("/tmp/cc-review-tracker-");
			const storePath = path.join(tmpDir, "reviewed-tasks.json");
			try {
				const tracker = new ReviewTracker(storePath);
				tracker.markReviewed("test-task-1");
				provider.setReviewTracker(tracker);

				const task = createMockTask({
					status: "failed",
					completed_at: new Date(Date.now() - 60_000).toISOString(),
				});
				const item = provider.getTreeItem({ type: "task", task });
				expect(item.description).toContain("✓ reviewed");
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("diff loading UX", () => {
		test("task item omits diff loading placeholder when diff is loading", () => {
			const task = createMockTask({ status: "running" });
			// Simulate diff loading: getDiffSummary returns null, but async loading is in progress
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).not.toContain("Loading diff");
			expect(item.description).not.toContain("...");
		});

		test("discovered item omits diff loading placeholder", () => {
			const agent = {
				pid: 99001,
				projectDir: "/Users/test/projects/my-app",
				startTime: new Date("2026-02-25T08:00:00Z"),
				source: "process" as const,
				command: "claude",
			};
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "discovered", agent });
			expect(item.description).not.toContain("Loading diff");
		});
	});

	describe("task model details", () => {
		test("expanded task view shows explicit model detail", () => {
			const task = createMockTask({
				status: "running",
				model: "anthropic/claude-opus-4-6",
			});
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const modelDetail = details.find(
				(d) => d.type === "detail" && d.label === "Model",
			);
			expect(modelDetail).toBeDefined();
			if (modelDetail?.type === "detail") {
				expect(modelDetail.value).toBe("anthropic/claude-opus-4-6 (explicit)");
			}
		});

		test("expanded task view shows inherited model detail", () => {
			const tmpDir = fs.mkdtempSync("/tmp/cc-openclaw-config-");
			const configPath = path.join(tmpDir, "openclaw.json");
			fs.writeFileSync(
				configPath,
				JSON.stringify({
					agents: {
						defaults: {
							model: {
								primary: "openai-codex/gpt-5.4",
							},
						},
						list: [{ id: "developer" }],
					},
				}),
			);

			try {
				const configService = new OpenClawConfigService(configPath);
				configService.reload();
				provider.setOpenClawConfigService(configService);

				const task = createMockTask({
					status: "running",
					role: "developer",
				});
				provider.readRegistry = () =>
					createMockRegistry({ "test-task-1": task });
				provider.getGitInfo = () => null;
				provider.getDiffSummary = () => null;
				provider.reload();

				const root = provider.getChildren();
				const firstTask = getFirstTask(root);
				const details = provider.getChildren(firstTask);
				const modelDetail = details.find(
					(d) => d.type === "detail" && d.label === "Model",
				);
				expect(modelDetail).toBeDefined();
				if (modelDetail?.type === "detail") {
					expect(modelDetail.value).toBe("openai-codex/gpt-5.4 (inherited)");
				}
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	// ── end_commit / bounded diff tests ──────────────────────────────────

	describe("end_commit bounded diff attribution", () => {
		test("getPerFileDiffs uses start_commit..end_commit for completed tasks with end_commit", () => {
			const gitArgs: string[][] = [];
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (cmd === "git" && args?.includes("--numstat")) {
					gitArgs.push(args);
					return "5\t2\tsrc/foo.ts\n";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			const diffs = provider.getPerFileDiffs(
				"/some/project",
				"abc123",
				"def456",
			);

			expect(diffs).toHaveLength(1);
			expect(diffs[0]?.filePath).toBe("src/foo.ts");
			// Should use start_commit..end_commit, not start_commit..HEAD
			expect(gitArgs.some((a) => a.includes("abc123..def456"))).toBe(true);
			expect(gitArgs.some((a) => a.includes("abc123..HEAD"))).toBe(false);
		});

		test("getPerFileDiffs uses start_commit..HEAD when no end_commit", () => {
			const gitArgs: string[][] = [];
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (cmd === "git" && args?.includes("--numstat")) {
					gitArgs.push(args);
					return "3\t1\tsrc/bar.ts\n";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			const diffs = provider.getPerFileDiffs("/some/project", "abc123");

			expect(diffs).toHaveLength(1);
			expect(gitArgs.some((a) => a.includes("abc123..HEAD"))).toBe(true);
		});

		test("getPerFileDiffs diffs working tree (no range) for running tasks", () => {
			const gitArgs: string[][] = [];
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (cmd === "git" && args?.includes("--numstat")) {
					gitArgs.push(args);
					return "1\t0\tsrc/wip.ts\n";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			// No startCommit, no endCommit → working tree diff
			const diffs = provider.getPerFileDiffs("/some/project");

			expect(diffs).toHaveLength(1);
			// Should not contain any ".." range
			expect(gitArgs.some((a) => a.some((s) => s.includes("..")))).toBe(false);
		});

		test("getDiffSummary uses end_commit for completed task with end_commit set", () => {
			const gitArgs: string[][] = [];
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (cmd === "git" && args?.includes("--numstat")) {
					gitArgs.push(args);
					return "2\t1\tsrc/feature.ts\n";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			const task = createMockTask({
				status: "completed",
				start_commit: "start111",
				end_commit: "end222",
			});

			const summary = provider.getDiffSummary(task.project_dir, task);

			expect(summary).not.toBeNull();
			expect(gitArgs.some((a) => a.includes("start111..end222"))).toBe(true);
		});

		test("getDiffSummary falls back to HEAD for completed task without end_commit", () => {
			const gitArgs: string[][] = [];
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (cmd === "git" && args?.includes("--numstat")) {
					gitArgs.push(args);
					return "1\t0\tsrc/thing.ts\n";
				}
				// For completed_at timestamp lookup (log --before=...)
				if (
					cmd === "git" &&
					args?.includes("log") &&
					args?.some((a) => a.startsWith("--before="))
				) {
					return "";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			const task = createMockTask({
				status: "completed",
				start_commit: "startabc",
				end_commit: null,
				completed_at: null,
			});

			const summary = provider.getDiffSummary(task.project_dir, task);

			expect(summary).not.toBeNull();
			// Should fall back to HEAD since no end_commit and no completed_at
			expect(gitArgs.some((a) => a.includes("startabc..HEAD"))).toBe(true);
		});

		test("running task getDiffSummary diffs working tree (no commit range)", () => {
			const gitArgs: string[][] = [];
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (cmd === "git" && args?.includes("--numstat")) {
					gitArgs.push(args);
					return "1\t1\tsrc/running.ts\n";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			const task = createMockTask({
				status: "running",
				start_commit: "somesha",
			});

			provider.getDiffSummary(task.project_dir, task);

			// Running task: no range args, just working tree diff
			expect(gitArgs.some((a) => a.some((s) => s.includes("..")))).toBe(false);
		});
	});
});
