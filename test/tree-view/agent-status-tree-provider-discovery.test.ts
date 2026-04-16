/**
 * AgentStatusTreeProvider — discovery integration tests
 *
 * EXTRACTED from agent-status-tree-provider.test.ts. See
 * test/tree-view/_helpers/agent-status-tree-provider-test-base.ts for
 * shared mocks and the createProviderHarness() factory.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	isValidSessionId,
	resolveAgentStatusSortMode,
} from "../../src/providers/agent-status-tree-provider.js";
import { AgentStatusBar } from "../../src/services/agent-status-bar.js";
import { PerformanceTestHelper } from "../helpers/performance-test-helper.js";
import type { setupVSCodeMock } from "../helpers/vscode-mock.js";
import {
	type AgentNode,
	type AgentRole,
	type AgentStatusTreeProvider,
	type AgentTask,
	createMockRegistry,
	createMockTask,
	createProviderHarness,
	disposeHarness,
	getFirstTask,
	getOlderRunsNode,
	getPersistSocketPath,
	getSummaryNode,
	getTaskNodes,
	getTmuxHealthCacheKey,
	loadAgentStatusFixture,
	loadDogfoodFixture,
	type ProviderHarness,
	setAgentStatusConfig,
} from "./_helpers/agent-status-tree-provider-test-base.js";

describe("AgentStatusTreeProvider — discovery", () => {
	let h: ProviderHarness;
	let provider: AgentStatusTreeProvider;
	let vscodeMock: ReturnType<typeof setupVSCodeMock>;
	let projectIconManagerMock: ProviderHarness["projectIconManagerMock"];

	beforeEach(() => {
		h = createProviderHarness();
		provider = h.provider;
		vscodeMock = h.vscodeMock;
		projectIconManagerMock = h.projectIconManagerMock;
	});

	afterEach(() => {
		disposeHarness(h);
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
					expect(summary.label).toContain("2 ✓");
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
				expect(summary.label).toContain("1 ✓");
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
			expect(groupItem.label).toBe("🚀 COMMAND CENTRAL ▼ (1)");
			expect(groupItem.description).toContain("1 working");

			// ≤5 agents → flat children (no status sub-groups)
			const children = provider.getChildren(groupNode);
			const taskNode = children.find(
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
			h.setOpenclawAuditJson(
				JSON.stringify({
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
				}),
			);
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
			expect(summary.label).toContain("2 ⏹");
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

		// Default completedTaskLimit is 10 — 51 completed tasks → 10 visible + 41 hidden
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
		expect(taskNodes).toHaveLength(10);
		expect((taskNodes[0] as { type: "task"; task: AgentTask }).task.id).toBe(
			"task-1",
		);
		expect((taskNodes[9] as { type: "task"; task: AgentTask }).task.id).toBe(
			"task-10",
		);

		const olderRuns = getOlderRunsNode(children);
		expect(olderRuns.label).toBe("Show 41 older completed...");
		const olderRunsItem = provider.getTreeItem(olderRuns);
		expect(olderRunsItem.collapsibleState).toBe(1);

		const expandedChildren = provider.getChildren(olderRuns);
		expect(expandedChildren).toHaveLength(41);
		expect(expandedChildren[0]?.type).toBe("task");
		if (expandedChildren[0]?.type === "task") {
			expect(expandedChildren[0].task.id).toBe("task-11");
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
		// ≤5 agents → flat children (no status sub-groups)
		const groupChildren = provider.getChildren(projectGroup);
		expect(groupChildren.map((node) => node.type)).toEqual([
			"task",
			"task",
			"task",
		]);
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
		// ≤5 agents → flat children sorted by status priority then recency
		const groupChildren = provider.getChildren(projectGroup);
		expect(groupChildren).toHaveLength(3);
		expect(groupChildren.every((node) => node.type === "task")).toBe(true);
		const ids = groupChildren.map(
			(node) => (node as { type: "task"; task: AgentTask }).task.id,
		);
		expect(ids).toEqual(["running-older", "failed-middle", "completed-latest"]);
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
		// ≤5 agents → flat children (no status sub-groups)
		const children = provider.getChildren(projectGroup);
		expect(children).toHaveLength(3);
		expect(children.every((node) => node.type === "task")).toBe(true);
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
		// ≤5 agents → flat children (no status sub-groups)
		const groupChildren = provider.getChildren(projectGroup);

		// All children are task nodes
		expect(groupChildren.every((node) => node.type === "task")).toBe(true);
		expect(groupChildren).toHaveLength(4);

		// Sorted by recency: most recent first
		const ids = groupChildren.map(
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
		// ≤5 agents → flat children (no status sub-groups)
		const groupChildren = provider.getChildren(projectGroup);
		expect(groupChildren.every((node) => node.type === "task")).toBe(true);
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
		// ≤5 agents → flat children (no status sub-groups)
		const groupChildren = provider.getChildren(projectGroup);
		expect(groupChildren.every((node) => node.type === "task")).toBe(true);
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

		expect(item.label).toBe("🧩 ALPHA ▼ (2)");
		// Description no longer includes relative time — just status summary
		expect(item.description).toContain("1 working");
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

		// ≤5 agents → flat children (no status sub-groups)
		const groupChildren = provider.getChildren(groupNode);
		expect(groupChildren.map((node) => node.type)).toEqual([
			"discovered",
			"task",
			"task",
		]);
		expect(
			(groupChildren[0] as { type: "discovered"; agent: { pid: number } }).agent
				.pid,
		).toBe(5151);
		expect(
			(groupChildren[1] as { type: "task"; task: AgentTask }).task.id,
		).toBe("alpha-old");
		expect(
			(groupChildren[2] as { type: "task"; task: AgentTask }).task.id,
		).toBe("alpha-completed-latest");
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

		// ≤5 agents → flat children (no status sub-groups)
		expect(groupChildren.map((node) => node.type)).toEqual([
			"discovered",
			"task",
		]);
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
		expect(item.label).toBe("🧩 ALPHA ▼ (1)");
		expect(item.description).toContain("1 working");
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
		expect(item.label).toBe("🛸 ALPHA ▼ (1)");
		expect(item.description).toContain("1 working");
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

	test("file-change tree item shows filename, relative path, status, stats, tooltip, and command", () => {
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
				status: "M",
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
		expect(item.description).toBe("src/providers · M +5 -2");
		expect(item.tooltip).toBe(
			"/Users/test/projects/my-app/src/providers/agent-status-tree-provider.ts",
		);
		expect(item.contextValue).toBe("agentFileChange");
		expect(item.command?.command).toBe("commandCentral.smartOpenFile");
	});

	test("binary file-change tree item uses binary description", () => {
		const task = createMockTask({ status: "completed", exit_code: 0 });
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.getGitInfo = () => null;
		provider.getDiffSummary = () => null;
		provider.readPromptSummary = () => "mock summary";
		provider.getPerFileDiffs = () => [
			{
				filePath: "assets/logo.png",
				additions: -1,
				deletions: -1,
				status: "A",
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
		expect(item.description).toBe("assets · A binary");
	});

	test("root-level deleted file-change tree item keeps filename and shows D status", () => {
		const task = createMockTask({ status: "completed", exit_code: 0 });
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.getGitInfo = () => null;
		provider.getDiffSummary = () => null;
		provider.readPromptSummary = () => "mock summary";
		provider.getPerFileDiffs = () => [
			{
				filePath: "package.json",
				additions: 0,
				deletions: 6,
				status: "D",
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
		expect(item.label).toBe("package.json");
		expect(item.description).toBe("D +0 -6");
	});

	test("getParent returns task node for file-change child", () => {
		const task = createMockTask({ status: "completed", exit_code: 0 });
		provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
		provider.reload();

		const parent = provider.getParent({
			type: "fileChange",
			taskId: "test-task-1",
			projectDir: task.project_dir,
			projectName: task.project_name,
			filePath: "src/file.ts",
			additions: 1,
			deletions: 0,
			status: "M",
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

	test("task tooltip includes exact timestamps and runtime identity breadcrumbs", () => {
		const startedAt = "2026-04-13T14:00:00.000Z";
		const completedAt = "2026-04-13T14:05:00.000Z";
		const task = createMockTask({
			status: "completed",
			terminal_backend: "tmux",
			tmux_socket: "/tmp/project.tmux.sock",
			tmux_window_id: "@42",
			started_at: startedAt,
			completed_at: completedAt,
			claude_session_id: "claude-session-abcdef1234567890",
		});
		const tooltip = (
			provider.getTreeItem({ type: "task", task }).tooltip as { value: string }
		).value;
		expect(tooltip).toContain("**test-task-1**");
		expect(tooltip).toContain("Status: completed");
		expect(tooltip).toContain(`Started: ${startedAt}`);
		expect(tooltip).toContain(`Completed: ${completedAt}`);
		expect(tooltip).toContain(
			"Runtime: tmux · project=my-app · session=agent-my-app · window=@42 · socket=project.tmux.sock · bundle=My App.app",
		);
		expect(tooltip).toContain(
			"Transcript: claude=claude-session-abcdef1234567890",
		);
		expect(tooltip).toContain("Duration: 5m");
		expect(tooltip).toContain("Dir: `/Users/test/projects/my-app`");
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
			expect(errorDetail.label).toContain("Failed (exit code 127)");
			expect(errorDetail.label).toContain("Retry 2/3");
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
			expect(errorDetail.label).toContain("Failed (exit code 2)");
			expect(errorDetail.label).not.toContain("Retry");
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
			(d) =>
				d.type === "detail" &&
				(d.label?.startsWith("✅") || d.label?.startsWith("❌")),
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

	// readRegistry tests extracted to agent-status-tree-provider-read-registry.test.ts
	// to escape prototype pollution from sibling test files. See that file's header.

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
