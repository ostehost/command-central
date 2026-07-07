import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AgentNode,
	AgentTask,
	TaskRegistry,
} from "../../src/providers/agent-status-tree-provider.js";
import type { OpenClawTaskService } from "../../src/services/openclaw-task-service.js";
import type { TaskFlowService } from "../../src/services/taskflow-service.js";
import { countAgentStatuses } from "../../src/utils/agent-counts.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("OpenClaw task nodes", () => {
	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
	});

	function setConfig(options: { groupByProject?: boolean }): void {
		const vscodeMock = setupVSCodeMock();
		const getConfigurationMock = mock((_section?: string) => ({
			update: mock(),
			get: mock((key: string, defaultValue?: unknown) => {
				if (key === "agentTasksFile") return "";
				if (key === "discovery.enabled") return false;
				if (key === "agentStatus.groupByProject") {
					return options.groupByProject ?? false;
				}
				return defaultValue;
			}),
			inspect: mock(() => undefined),
			has: mock(() => true),
		}));

		vscodeMock.workspace.getConfiguration =
			getConfigurationMock as unknown as typeof vscodeMock.workspace.getConfiguration;
		const runtimeVscode = require("vscode") as typeof import("vscode");
		runtimeVscode.workspace.getConfiguration =
			getConfigurationMock as unknown as typeof runtimeVscode.workspace.getConfiguration;
	}

	function createTask(
		overrides: Partial<{
			taskId: string;
			runtime: "acp" | "subagent" | "cron" | "cli";
			status:
				| "queued"
				| "running"
				| "succeeded"
				| "failed"
				| "timed_out"
				| "cancelled"
				| "lost"
				| "blocked";
			label: string;
			task: string;
			childSessionKey: string;
			runId: string;
			progressSummary: string;
			lastEventAt: number;
			trackerKind: string;
			issueId: string;
			issueIdentifier: string;
			issueState: string;
			issueUrl: string;
			workspacePath: string;
			execMode: string;
			execNodeName: string;
			execNodeId: string;
			host: string;
			nodeConnected: boolean;
			workflowName: string;
			workflowPath: string;
		}> = {},
	) {
		return {
			taskId: "bg-1",
			runtime: "cron" as const,
			ownerKey: "main",
			scopeKind: "workspace",
			task: "Nightly summary",
			status: "running" as const,
			deliveryStatus: "pending",
			notifyPolicy: "silent",
			createdAt: Date.now() - 20_000,
			lastEventAt: Date.now() - 5_000,
			...overrides,
		};
	}

	function createFlow(
		overrides: Partial<{
			flowId: string;
			label: string;
			status:
				| "queued"
				| "running"
				| "waiting"
				| "blocked"
				| "succeeded"
				| "failed"
				| "cancelled"
				| "lost";
			tasks: ReturnType<typeof createTask>[];
		}> = {},
	) {
		return {
			flowId: "flow-1",
			label: "Flow 1",
			status: "running" as const,
			createdAt: Date.now() - 10_000,
			taskCount: overrides.tasks?.length ?? 1,
			completedCount: 0,
			failedCount: 0,
			tasks: [createTask({ taskId: "bg-1", runtime: "subagent" })],
			...overrides,
		};
	}

	function isCodexLauncherTask(task: AgentTask): boolean {
		return [task.agent_backend, task.cli_name].some((value) =>
			value?.toLowerCase().includes("codex"),
		);
	}

	function createLauncherTask(overrides: Partial<AgentTask> = {}): AgentTask {
		return {
			id: "launcher-1",
			status: "running",
			project_dir: "/tmp/my-app",
			project_name: "My App",
			session_id: "agent-my-app",
			bundle_path: "",
			prompt_file: "",
			started_at: new Date().toISOString(),
			attempts: 1,
			max_attempts: 1,
			...overrides,
		};
	}

	function setLauncherTasks(provider: unknown, tasks: AgentTask[]): void {
		(provider as { registry: TaskRegistry }).registry = {
			version: 2,
			tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
		};
	}

	async function createProvider(
		openclawTasks: ReturnType<typeof createTask>[],
		flows: ReturnType<typeof createFlow>[] = [],
		viewMode: "agentStatus" | "symphony" = "symphony",
	) {
		setConfig({ groupByProject: false });
		const { AgentStatusTreeProvider } = await import(
			"../../src/providers/agent-status-tree-provider.js"
		);
		const provider = new AgentStatusTreeProvider(undefined, undefined, {
			viewMode,
		});
		(
			provider as unknown as {
				readRegistry: () => { version: number; tasks: Record<string, never> };
			}
		).readRegistry = () => ({ version: 2, tasks: {} });
		(
			provider as unknown as {
				reload: () => void;
			}
		).reload();
		provider.setOpenClawTaskService({
			getTasks: () => openclawTasks,
		} as unknown as OpenClawTaskService);
		provider.setTaskFlowService({
			getFlows: () => flows,
		} as unknown as TaskFlowService);
		(
			provider as unknown as {
				_agentRegistry: null;
				_discoveredAgents: [];
				_allDiscoveredAgents: [];
			}
		)._agentRegistry = null;
		(
			provider as unknown as {
				_agentRegistry: null;
				_discoveredAgents: [];
				_allDiscoveredAgents: [];
			}
		)._discoveredAgents = [];
		(
			provider as unknown as {
				_agentRegistry: null;
				_discoveredAgents: [];
				_allDiscoveredAgents: [];
			}
		)._allDiscoveredAgents = [];
		(
			provider as unknown as {
				registry: {
					version: number;
					tasks: Record<string, never>;
				};
			}
		).registry = { version: 2, tasks: {} };
		return provider;
	}

	async function createAgentStatusProvider(
		openclawTasks: ReturnType<typeof createTask>[],
		flows: ReturnType<typeof createFlow>[] = [],
	) {
		return createProvider(openclawTasks, flows, "agentStatus");
	}

	function getSingleTaskFlowChildren(provider: {
		getChildren: (element?: AgentNode) => AgentNode[];
	}): AgentNode[] {
		const flowsNode = getTaskFlowsNode(provider);
		const groups = provider.getChildren(flowsNode);
		const group = groups.find((node) => node.type === "taskFlowGroup");
		if (group?.type !== "taskFlowGroup") {
			throw new Error("No taskFlowGroup node found");
		}
		return provider.getChildren(group);
	}

	function getTaskFlowsNode(provider: {
		getChildren: (element?: AgentNode) => AgentNode[];
	}): Extract<AgentNode, { type: "taskflows" }> {
		const flowsNode = getSymphonyChildren(provider).find(
			(node) => node.type === "taskflows",
		);
		if (flowsNode?.type !== "taskflows") {
			throw new Error("No Symphony Workstreams node found");
		}
		return flowsNode;
	}

	function getCodexRunsNode(provider: {
		getChildren: (element?: AgentNode) => AgentNode[];
	}): Extract<AgentNode, { type: "codexRuns" }> {
		const runsNode = getSymphonyChildren(provider).find(
			(node) => node.type === "codexRuns",
		);
		if (runsNode?.type !== "codexRuns") {
			throw new Error("No Symphony Run Attempts node found");
		}
		return runsNode;
	}

	function getSymphonyChildren(provider: {
		getChildren: (element?: AgentNode) => AgentNode[];
	}): AgentNode[] {
		const root = provider.getChildren();
		const symphonyNode = root.find((node) => node.type === "symphony");
		if (symphonyNode && symphonyNode.type === "symphony") {
			return provider.getChildren(symphonyNode);
		}
		return root;
	}

	function getCodexRunNodes(provider: {
		getChildren: (element?: AgentNode) => AgentNode[];
	}): Array<Extract<AgentNode, { type: "codexRun" }>> {
		return provider
			.getChildren(getCodexRunsNode(provider))
			.filter(
				(node): node is Extract<AgentNode, { type: "codexRun" }> =>
					node.type === "codexRun",
			);
	}

	function getSymphonyRunGroupNode(
		provider: { getChildren: (element?: AgentNode) => AgentNode[] },
		kind: "running" | "retryQueued" | "released",
	): Extract<AgentNode, { type: "symphonyRunGroup" }> | undefined {
		return getSymphonyChildren(provider).find(
			(node): node is Extract<AgentNode, { type: "symphonyRunGroup" }> =>
				node.type === "symphonyRunGroup" && node.kind === kind,
		);
	}

	function findCodexRun(
		provider: { getChildren: (element?: AgentNode) => AgentNode[] },
		predicate: (
			run: Extract<AgentNode, { type: "codexRun" }>["run"],
		) => boolean,
	): Extract<AgentNode, { type: "codexRun" }>["run"] {
		const run = getCodexRunNodes(provider)
			.map((node) => node.run)
			.find(predicate);
		if (!run) throw new Error("No matching Codex run found");
		return run;
	}

	function normalizeSnapshotText(value: string): string {
		return value
			.replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/g, "<timestamp>")
			.replace(/\b\d+\s*(?:s|m|h|d) ago\b/g, "<age>")
			.replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/g, "<duration>");
	}

	function itemText(
		provider: { getTreeItem: (element: AgentNode) => unknown },
		node: AgentNode,
	): string {
		const item = provider.getTreeItem(node) as {
			label?: string;
			description?: string;
			contextValue?: string;
		};
		const label =
			typeof item.label === "string" ? item.label : JSON.stringify(item.label);
		const description = item.description ? ` — ${item.description}` : "";
		const context = item.contextValue ? ` {${item.contextValue}}` : "";
		return normalizeSnapshotText(`${label}${description}${context}`);
	}

	function renderTreeSnapshot(
		provider: {
			getTreeItem: (element: AgentNode) => unknown;
			getChildren: (element?: AgentNode) => AgentNode[];
		},
		root: AgentNode,
		maxDepth = 3,
	): string {
		const lines: string[] = [];
		const walk = (node: AgentNode, depth: number): void => {
			lines.push(`${"  ".repeat(depth)}- ${itemText(provider, node)}`);
			if (depth >= maxDepth) return;
			for (const child of provider.getChildren(node)) {
				walk(child, depth + 1);
			}
		};
		walk(root, 0);
		return lines.join("\n");
	}

	function assertTreeSnapshot(name: string, content: string): void {
		const snapshotPath = path.join(
			process.cwd(),
			"test",
			"fixtures",
			"tree-view",
			"symphony-run-attempts",
			`${name}.snapshot.txt`,
		);
		if (process.env["UPDATE_TREE_SNAPSHOTS"] === "1") {
			fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
			fs.writeFileSync(snapshotPath, `${content}\n`);
		}
		expect(content).toBe(fs.readFileSync(snapshotPath, "utf8").trimEnd());
	}

	test("OpenClaw tasks appear inline in flat mode", async () => {
		const provider = await createAgentStatusProvider([createTask()]);
		const root = provider.getChildren();
		expect(root.some((node) => node.type === "openclawTask")).toBe(true);
	});

	test("Agent Status keeps only a lightweight Symphony summary", async () => {
		const provider = await createAgentStatusProvider([
			createTask({
				taskId: "running-openclaw",
				task: "Running source-owned run attempt",
				status: "running",
			}),
		]);

		const root = provider.getChildren();
		expect(root.some((node) => node.type === "symphony")).toBe(false);
		// V2: the former "Symphony Status Surface" row is folded into a read-only
		// Sources provenance feed — Symphony contributes run attempts as a source,
		// not as a competing top-level status denominator.
		const summary = root.find(
			(node) => node.type === "summary" && node.label.startsWith("Sources"),
		);
		expect(summary).toBeDefined();
		if (summary?.type === "summary") {
			expect(summary.label).toContain("Sources · Symphony");
			expect(summary.label).toContain("run attempts 1");
			expect(summary.label).toContain("1 running");
			expect(summary.label).not.toContain("standalone run attempts");
			expect(String(summary.tooltip ?? "")).toContain(
				"read-only provenance feed",
			);
		}
	});

	test("Symphony Run Attempts container remains visible when empty", async () => {
		const provider = await createProvider([]);
		const root = provider.getChildren();
		expect(root.some((node) => node.type === "symphony")).toBe(false);
		expect(root.map((node) => node.type)).toEqual([
			"symphonyDashboard",
			"symphonyRunGroup",
			"symphonyRunGroup",
			"taskflows",
			"codexRuns",
		]);

		const runsNode = getCodexRunsNode(provider);

		const item = provider.getTreeItem(runsNode);
		expect(item.label).toBe("Run Attempts · 0");
		expect(item.description).toBe("no projected runs");

		const children = provider.getChildren(runsNode);
		expect(children).toContainEqual({
			type: "state",
			label: "No projected run attempts",
			description: "OpenClaw, TaskFlow, or launcher rows will appear here",
			icon: "circle-slash",
		});
	});

	test("Symphony nodes expose stable TreeItem ids for refresh/reveal", async () => {
		const provider = await createProvider([
			createTask({
				taskId: "running-openclaw",
				childSessionKey: "session:agent-my-app",
				runId: "run-101",
				status: "running",
			}),
		]);
		const symphonyChildren = getSymphonyChildren(provider);
		const dashboard = symphonyChildren.find(
			(node) => node.type === "symphonyDashboard",
		);
		const runningGroup = getSymphonyRunGroupNode(provider, "running");
		const runsContainer = getCodexRunsNode(provider);
		const runNode = getCodexRunNodes(provider)[0];
		if (!dashboard || !runningGroup || !runNode) {
			throw new Error(
				"Expected Symphony dashboard, running group, and run node",
			);
		}

		const items = [dashboard, runningGroup, runsContainer, runNode].map(
			(node) => provider.getTreeItem(node) as { id?: string },
		);

		expect(items.map((item) => item.id)).toEqual([
			"symphony:dashboard",
			"symphony:run-group:running",
			"symphony:codex-runs",
			// Container-qualified so the same run rendered under a run-group
			// fallback and under the Run Attempts container never collide.
			"symphony:codex-run:runs:run-101",
		]);
	});

	test("Codex run rendered under a run group vs the Run Attempts container gets distinct ids and parents", async () => {
		const provider = await createProvider([
			createTask({
				taskId: "running-openclaw",
				childSessionKey: "session:agent-my-app",
				runId: "run-101",
				status: "running",
			}),
		]);
		const runsContainerNode = getCodexRunNodes(provider)[0];
		if (!runsContainerNode) {
			throw new Error(
				"Expected a Codex run node under the Run Attempts container",
			);
		}
		// Same run, but projected under a run-group fallback instead.
		const runGroupNode: Extract<AgentNode, { type: "codexRun" }> = {
			type: "codexRun",
			run: runsContainerNode.run,
			container: "running",
		};

		const runsId = (provider.getTreeItem(runsContainerNode) as { id?: string })
			.id;
		const groupId = (provider.getTreeItem(runGroupNode) as { id?: string }).id;
		expect(runsId).toBe("symphony:codex-run:runs:run-101");
		expect(groupId).toBe("symphony:codex-run:running:run-101");
		expect(runsId).not.toBe(groupId);

		// Each reports the container it was actually rendered under.
		expect(provider.getParent(runsContainerNode)?.type).toBe("codexRuns");
		expect(provider.getParent(runGroupNode)?.type).toBe("symphonyRunGroup");
	});

	test("Symphony getParent: top-level containers report no parent, nested nodes resolve to their in-tree parent", async () => {
		const flow = createFlow({ flowId: "flow-1" });
		const provider = await createProvider(
			[
				createTask({
					taskId: "running-openclaw",
					childSessionKey: "session:agent-my-app",
					runId: "run-101",
					status: "running",
				}),
			],
			[flow],
		);
		const symphonyChildren = getSymphonyChildren(provider);
		const dashboard = symphonyChildren.find(
			(node) => node.type === "symphonyDashboard",
		);
		const runningGroup = getSymphonyRunGroupNode(provider, "running");
		const runsContainer = getCodexRunsNode(provider);
		const runNode = getCodexRunNodes(provider)[0];
		const flowsContainer = getTaskFlowsNode(provider);
		const flowNode = provider
			.getChildren(flowsContainer)
			.find((node) => node.type === "taskFlowGroup");
		if (!dashboard || !runningGroup || !runNode || !flowNode) {
			throw new Error("Expected projected Symphony nodes");
		}

		// In symphony viewMode these containers are the root items, so the
		// synthetic Symphony root node is never in the tree — they must report
		// no parent or reveal/refresh would chase an absent node.
		expect(provider.getParent(dashboard)).toBeUndefined();
		expect(provider.getParent(runningGroup)).toBeUndefined();
		expect(provider.getParent(runsContainer)).toBeUndefined();
		expect(provider.getParent(flowsContainer)).toBeUndefined();
		// Nested nodes still resolve to their real, in-tree parent container.
		const runParent = provider.getParent(runNode);
		expect(runParent?.type).toBe("codexRuns");
		if (runParent?.type !== "codexRuns") {
			throw new Error("Expected Codex Runs parent");
		}
		expect(runParent.runs.some((run) => run.runId === "run-101")).toBe(true);
		expect(provider.getParent(flowNode)).toEqual({
			type: "taskflows",
			flows: [flow],
		});
	});

	test("Symphony root exposes Operations Dashboard and read-only kanban groups", async () => {
		const provider = await createProvider([
			createTask({
				taskId: "running-openclaw",
				task: "Running source-owned run attempt",
				status: "running",
			}),
		]);
		setLauncherTasks(provider, [
			createLauncherTask({
				id: "running-row",
				status: "completed",
				agent_backend: "codex",
				source_authority: "launcher",
				owner_kind: "launcher",
				prompt_summary: "Running source-owned run attempt",
				turn_count: 3,
				codex_total_tokens: 900,
				runtime_seconds: 120,
				rate_limit_summary: "remaining=42",
			}),
			createLauncherTask({
				id: "retry-row",
				status: "failed",
				agent_backend: "claude",
				source_authority: "launcher",
				owner_kind: "launcher",
				prompt_summary: "Retry queued source-owned run attempt",
				retry_attempt: 2,
				retry_due_at: "2026-02-24T20:16:00Z",
				retry_error: "backoff",
			}),
			createLauncherTask({
				id: "released-row",
				status: "Released" as AgentTask["status"],
				agent_backend: "claude",
				source_authority: "launcher",
				owner_kind: "launcher",
				prompt_summary: "Released source-owned run attempt",
			}),
		]);

		const symphonyChildren = getSymphonyChildren(provider);
		const dashboard = symphonyChildren.find(
			(node) => node.type === "symphonyDashboard",
		);
		if (dashboard?.type !== "symphonyDashboard") {
			throw new Error("No Operations Dashboard node found");
		}
		const dashboardItem = provider.getTreeItem(dashboard);
		expect(dashboardItem.label).toBe("Operations Dashboard");
		expect(dashboardItem.description).toContain("1 running");
		expect(dashboardItem.description).toContain("1 RetryQueued");
		const dashboardDetails = provider.getChildren(dashboard);
		const dashboardValues = new Map(
			dashboardDetails
				.filter((node) => node.type === "detail")
				.map((node) => [node.label, node.value]),
		);
		expect(dashboardValues.get("Boundary")).toContain(
			"Read-only Status Surface",
		);
		expect(dashboardValues.get("Orchestrator Runtime State")).toBe(
			"Not provided by lifecycle owner",
		);
		expect(dashboardValues.get("Process visibility")).toContain(
			"Last-known projected run attempts only",
		);
		expect(dashboardValues.get("Evidence freshness")).toContain(
			"No runtime snapshot",
		);
		expect(dashboardValues.get("Loop contract")).toContain(
			"Workroom owns item",
		);
		expect(dashboardValues.get("running")).toBe("1");
		expect(dashboardValues.get("retrying")).toBe("1");
		expect(dashboardValues.get("Released")).toBe("1");
		expect(dashboardValues.get("codex_totals.total_tokens")).toBe("900");
		expect(dashboardValues.get("codex_totals.seconds_running")).toBe("120");
		expect(dashboardValues.get("rate_limits")).toBe("remaining=42");
		// codex_totals fields with no source row contributing must be honest
		// rather than synthesised.
		expect(dashboardValues.get("codex_totals.input_tokens")).toBe(
			"Not provided by lifecycle owner",
		);
		expect(dashboardValues.get("codex_totals.output_tokens")).toBe(
			"Not provided by lifecycle owner",
		);

		const runningGroup = getSymphonyRunGroupNode(provider, "running");
		const retryGroup = getSymphonyRunGroupNode(provider, "retryQueued");
		const releasedGroup = getSymphonyRunGroupNode(provider, "released");
		if (!runningGroup || !retryGroup || !releasedGroup) {
			throw new Error("Expected Symphony kanban groups were not rendered");
		}
		expect(provider.getTreeItem(runningGroup).label).toBe(
			"Running Sessions · 1",
		);
		expect(provider.getTreeItem(runningGroup).description).toBe("Running");
		expect(provider.getChildren(runningGroup).map((node) => node.type)).toEqual(
			["codexRun"],
		);
		expect(provider.getTreeItem(retryGroup).label).toBe("Retry Queue · 1");
		expect(provider.getTreeItem(retryGroup).description).toBe("RetryQueued");
		expect(provider.getTreeItem(releasedGroup).label).toBe("Released · 1");
		expect(
			provider.getChildren(releasedGroup).map((node) => node.type),
		).toEqual(["codexRun"]);
	});

	test("Symphony Operations Dashboard consumes owner-provided runtime snapshot rows read-only", async () => {
		const provider = await createProvider([]);
		setLauncherTasks(provider, [
			createLauncherTask({
				id: "snapshot-row",
				agent_backend: "codex",
				source_authority: "launcher",
				owner_kind: "launcher",
				prompt_summary: "Elixir-shaped Symphony snapshot owner",
				symphony_runtime_snapshot: {
					generated_at: "2026-05-10T14:55:00Z",
					last_cron_tick: "2026-05-10T14:50:00Z",
					workflow_path: "/Users/ostemini/projects/demo/WORKFLOW.md",
					polling_cadence_ms: 300000,
					counts: { running: 1, retrying: 1, claimed: 3, completed: 42 },
					completed_limit: 100,
					running: [
						{
							issue_identifier: "SYM-101",
							state: "In Progress",
							run_attempt: "attempt-101",
							workspace_path: "/tmp/symphony/SYM-101",
							session_id: "thread-101-turn-1",
							phase: "StreamingTurn",
							last_event: "agent_message_delta",
							last_message: "editing files",
							turn_count: 3,
							tokens: {
								input_tokens: 1200,
								output_tokens: 400,
								total_tokens: 1600,
							},
						},
					],
					retrying: [
						{
							issue_identifier: "SYM-202",
							issue_state: "RetryQueued",
							run_attempt: "attempt-202",
							attempt: 2,
							due_at: "2026-05-10T15:00:00Z",
							error: "rate limited",
						},
					],
					codex_totals: {
						input_tokens: 1200,
						output_tokens: 400,
						total_tokens: 1600,
						seconds_running: 245,
					},
					rate_limits: { remaining: 17, limit: 100 },
					diagnostics: {
						last_cron_tick_status: "ok",
						last_reconciliation_duration_ms: 1834,
						last_linear_error_at: "2026-05-10T14:30:00Z",
						consecutive_linear_errors: 0,
						last_callback_status: "404",
						last_callback_url:
							"https://gateway.partnerai.dev/delegation/result",
						last_wake_at: "2026-05-10T14:55:12Z",
						node_connected: false,
					},
				},
			}),
		]);

		const symphonyChildren = getSymphonyChildren(provider);
		const dashboard = symphonyChildren.find(
			(node) => node.type === "symphonyDashboard",
		);
		if (dashboard?.type !== "symphonyDashboard") {
			throw new Error("No Operations Dashboard node found");
		}
		const dashboardValues = new Map(
			provider
				.getChildren(dashboard)
				.filter((node) => node.type === "detail")
				.map((node) => [node.label, node.value]),
		);
		expect(dashboardValues.get("Orchestrator Runtime State")).toBe("fresh");
		expect(dashboardValues.get("Process visibility")).toContain(
			"Live runtime snapshot from launcher",
		);
		expect(dashboardValues.get("Evidence freshness")).toBe(
			"Fresh snapshot generated 2026-05-10T14:55:00Z",
		);
		expect(dashboardValues.get("generated_at")).toBe("2026-05-10T14:55:00Z");
		expect(dashboardValues.get("last_cron_tick")).toBe("2026-05-10T14:50:00Z");
		expect(dashboardValues.get("workflow_path")).toBe(
			"/Users/ostemini/projects/demo/WORKFLOW.md",
		);
		expect(dashboardValues.get("polling_cadence_ms")).toBe("300000");
		expect(dashboardValues.get("running")).toBe("1");
		expect(dashboardValues.get("retrying")).toBe("1");
		expect(dashboardValues.get("claimed")).toBe("3");
		expect(dashboardValues.get("completed")).toBe("42");
		expect(dashboardValues.get("completed_limit")).toBe("100");
		expect(dashboardValues.get("codex_totals.input_tokens")).toBe("1200");
		expect(dashboardValues.get("codex_totals.output_tokens")).toBe("400");
		expect(dashboardValues.get("codex_totals.total_tokens")).toBe("1600");
		expect(dashboardValues.get("codex_totals.seconds_running")).toBe("245");
		expect(dashboardValues.get("rate_limits")).toBe(
			'{"remaining":17,"limit":100}',
		);
		expect(dashboardValues.get("diagnostics.last_cron_tick_status")).toBe("ok");
		expect(
			dashboardValues.get("diagnostics.last_reconciliation_duration_ms"),
		).toBe("1834");
		expect(dashboardValues.get("diagnostics.last_linear_error_at")).toBe(
			"2026-05-10T14:30:00Z",
		);
		expect(dashboardValues.get("diagnostics.consecutive_linear_errors")).toBe(
			"0",
		);
		expect(dashboardValues.get("diagnostics.last_callback_status")).toBe("404");
		expect(dashboardValues.get("diagnostics.last_callback_url")).toBe(
			"https://gateway.partnerai.dev/delegation/result",
		);
		expect(dashboardValues.get("diagnostics.last_wake_at")).toBe(
			"2026-05-10T14:55:12Z",
		);
		expect(dashboardValues.get("diagnostics.node_connected")).toBe("false");

		const runningGroup = getSymphonyRunGroupNode(provider, "running");
		const retryGroup = getSymphonyRunGroupNode(provider, "retryQueued");
		if (!runningGroup || !retryGroup) {
			throw new Error("Expected Symphony snapshot groups were not rendered");
		}
		expect(provider.getTreeItem(runningGroup).label).toBe(
			"Running Sessions · 1",
		);
		expect(provider.getTreeItem(retryGroup).label).toBe("Retry Queue · 1");
		const runningRows = provider.getChildren(runningGroup);
		const retryRows = provider.getChildren(retryGroup);
		expect(runningRows.map((node) => node.type)).toEqual([
			"symphonySnapshotEntry",
		]);
		expect(retryRows.map((node) => node.type)).toEqual([
			"symphonySnapshotEntry",
		]);
		const runningRow = runningRows[0];
		const retryRow = retryRows[0];
		if (!runningRow || !retryRow) {
			throw new Error("Expected snapshot entries were not rendered");
		}
		expect(provider.getTreeItem(runningRow).label).toBe(
			"Live Session: thread-101-turn-1",
		);
		expect(provider.getTreeItem(retryRow).label).toBe(
			"Retry Entry: SYM-202 · RetryQueued",
		);
		const runningDetails = new Map(
			provider
				.getChildren(runningRow)
				.filter((node) => node.type === "detail")
				.map((node) => [node.label, node.value]),
		);
		expect(runningDetails.get("Issue")).toBe("SYM-101 · In Progress");
		expect(runningDetails.get("Run Attempt")).toBe("attempt-101");
		expect(runningDetails.get("Live Session")).toBe("thread-101-turn-1");
		expect(runningDetails.get("Phase")).toBe("StreamingTurn");
		expect(runningDetails.get("last_codex_event")).toBe("agent_message_delta");
		expect(runningDetails.get("turn_count")).toBe("3");
		expect(runningDetails.get("codex_total_tokens")).toBe("1600");
		const retryDetails = new Map(
			provider
				.getChildren(retryRow)
				.filter((node) => node.type === "detail")
				.map((node) => [node.label, node.value]),
		);
		expect(retryDetails.get("Issue")).toBe("SYM-202 · RetryQueued");
		expect(retryDetails.get("Run Attempt")).toBe("attempt-202");
		expect(retryDetails.get("attempt")).toBe("2");
		expect(retryDetails.get("due_at")).toBe("2026-05-10T15:00:00Z");
		expect(retryDetails.get("error")).toBe("rate limited");
	});

	test("Symphony Operations Dashboard reports snapshot error envelopes from source", async () => {
		const provider = await createProvider([]);
		setLauncherTasks(provider, [
			createLauncherTask({
				id: "timeout-row",
				agent_backend: "codex",
				source_authority: "launcher",
				owner_kind: "launcher",
				symphony_runtime_snapshot: {
					generated_at: "2026-05-10T14:56:00Z",
					counts: { running: 9, retrying: 4 },
					error: {
						code: "snapshot_timeout",
						message: "Snapshot timed out",
					},
				},
			}),
		]);
		let dashboard = getSymphonyChildren(provider).find(
			(node) => node.type === "symphonyDashboard",
		);
		if (dashboard?.type !== "symphonyDashboard") {
			throw new Error("No Operations Dashboard node found");
		}
		let dashboardValues = new Map(
			provider
				.getChildren(dashboard)
				.filter((node) => node.type === "detail")
				.map((node) => [node.label, node.value]),
		);
		expect(dashboardValues.get("Orchestrator Runtime State")).toBe(
			"snapshot_timeout: Snapshot timed out",
		);
		expect(provider.getTreeItem(dashboard).description).not.toContain(
			"9 running",
		);
		expect(dashboardValues.get("Process visibility")).toContain(
			"counts are not live confidence",
		);
		expect(dashboardValues.get("running")).toBe("0");

		setLauncherTasks(provider, [
			createLauncherTask({
				id: "unavailable-row",
				agent_backend: "codex",
				source_authority: "launcher",
				owner_kind: "launcher",
				symphony_runtime_snapshot: {
					error: {
						code: "snapshot_unavailable",
						message: "Snapshot unavailable",
					},
				},
			}),
		]);
		dashboard = getSymphonyChildren(provider).find(
			(node) => node.type === "symphonyDashboard",
		);
		if (dashboard?.type !== "symphonyDashboard") {
			throw new Error("No Operations Dashboard node found");
		}
		dashboardValues = new Map(
			provider
				.getChildren(dashboard)
				.filter((node) => node.type === "detail")
				.map((node) => [node.label, node.value]),
		);
		expect(dashboardValues.get("Orchestrator Runtime State")).toBe(
			"snapshot_unavailable: Snapshot unavailable",
		);
	});

	test("Symphony command surface does not add lifecycle mutation commands", () => {
		const packageJson = JSON.parse(
			fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
		) as { contributes?: { commands?: Array<{ command?: string }> } };
		const commands = packageJson.contributes?.commands ?? [];
		const forbidden = commands
			.map((entry) => entry.command ?? "")
			.filter((command) =>
				/(symphony|codex|agentStatus).*(retry|cancel|dispatch|tracker|linear)/i.test(
					command,
				),
			);
		expect(forbidden).toEqual([]);
	});

	test("Symphony Run Attempts container appears and expands to projected details", async () => {
		const provider = await createProvider([
			createTask({
				taskId: "bg-1",
				task: "bg-1",
				childSessionKey: "session:agent-my-app",
			}),
		]);
		(
			provider as unknown as {
				registry: {
					version: number;
					tasks: Record<string, unknown>;
				};
			}
		).registry = {
			version: 2,
			tasks: {
				launcher: {
					id: "launcher-1",
					status: "running",
					project_dir: "/tmp/my-app",
					project_name: "My App",
					session_id: "agent-my-app",
					stream_file: "/tmp/my-app/stream.jsonl",
					bundle_path: "",
					handoff_file: "/tmp/my-app/handoff.md",
					prompt_file: "/tmp/my-app/prompt.md",
					started_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					attempts: 1,
					max_attempts: 1,
					model: "gpt-5.5",
					role: "reviewer",
					prompt_summary: "Projected Codex run",
				},
			},
		};

		const runsNode = getCodexRunsNode(provider);

		const item = provider.getTreeItem(runsNode);
		expect(item.label).toBe("Run Attempts · 1");
		expect(item.description).toBe("1 working");
		expect((item.tooltip as { value: string }).value).toContain(
			"read-only projected run attempt",
		);
		expect((item.tooltip as { value: string }).value).toContain(
			"Lifecycle ownership stays with the source owner",
		);

		const runs = provider.getChildren(runsNode);
		const run = runs.find((node) => node.type === "codexRun");
		if (run?.type !== "codexRun") {
			throw new Error("No Codex run child found");
		}
		expect(run.run.source).toEqual({ kind: "openclaw-task", id: "bg-1" });
		expect(run.run.mergedFrom).toContainEqual({
			kind: "launcher",
			id: "launcher-1",
			path: "/tmp/my-app",
		});

		const runItem = provider.getTreeItem(run);
		expect(String(runItem.description)).toContain("reviewer");
		expect((runItem.tooltip as { value: string }).value).toContain(
			"Role: `reviewer`",
		);

		const details = provider.getChildren(run);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Status" &&
					node.value === "Running",
			),
		).toBe(true);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Owner status" &&
					node.value === "running",
			),
		).toBe(true);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Lifecycle owner" &&
					node.value === "OpenClaw task bg-1",
			),
		).toBe(true);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Projection boundary" &&
					node.value === "Source-owned row with Launcher metadata",
			),
		).toBe(true);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Role" &&
					node.value === "reviewer",
			),
		).toBe(true);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Sources" &&
					node.value ===
						"OpenClaw task bg-1 + Launcher launcher-1 (/tmp/my-app)",
			),
		).toBe(true);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Provenance from Launcher launcher-1 (/tmp/my-app)" &&
					node.value.includes("role") &&
					node.value.includes("model"),
			),
		).toBe(true);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Run attempt ID" &&
					node.value === "bg-1",
			),
		).toBe(true);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Workspace" &&
					node.value === "/tmp/my-app",
			),
		).toBe(true);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Evidence: Stream" &&
					node.value === "/tmp/my-app/stream.jsonl",
			),
		).toBe(true);
	});

	test("legacy OpenClaw and launcher rows disclose Symphony Run Attempts coexistence", async () => {
		const openClawTask = createTask({
			taskId: "bg-1",
			childSessionKey: "session:agent-my-app",
		});
		const provider = await createProvider([openClawTask]);
		const launcherTask: AgentTask = {
			id: "launcher-1",
			status: "running",
			project_dir: "/tmp/my-app",
			project_name: "My App",
			session_id: "agent-my-app",
			agent_backend: "codex",
			bundle_path: "",
			prompt_file: "/tmp/my-app/prompt.md",
			started_at: new Date().toISOString(),
			attempts: 1,
			max_attempts: 1,
		};
		(
			provider as unknown as {
				registry: {
					version: number;
					tasks: Record<string, AgentTask>;
				};
			}
		).registry = {
			version: 2,
			tasks: { launcher: launcherTask },
		};

		const openClawItem = provider.getTreeItem({
			type: "openclawTask",
			task: openClawTask,
		});
		expect((openClawItem.tooltip as { value: string }).value).toContain(
			"Also shown in Symphony / Run Attempts as OpenClaw task bg-1.",
		);

		const launcherItem = provider.getTreeItem({
			type: "task",
			task: launcherTask,
		});
		expect((launcherItem.tooltip as { value: string }).value).toContain(
			"explicit OpenClaw session join",
		);
	});

	test("Symphony Run Attempts respect the Agent Status project filter", async () => {
		const provider = await createProvider([
			createTask({
				taskId: "bg-1",
				task: "bg-1",
				childSessionKey: "session:agent-my-app",
			}),
			createTask({
				taskId: "bg-2",
				task: "bg-2",
				childSessionKey: "session:agent-other-app",
			}),
		]);
		(
			provider as unknown as {
				registry: {
					version: number;
					tasks: Record<string, unknown>;
				};
			}
		).registry = {
			version: 2,
			tasks: {
				launcher: {
					id: "launcher-1",
					status: "running",
					project_dir: "/tmp/my-app",
					project_name: "My App",
					session_id: "agent-my-app",
					bundle_path: "",
					prompt_file: "/tmp/my-app/prompt.md",
					started_at: new Date().toISOString(),
					attempts: 1,
					max_attempts: 1,
					model: "gpt-5.5",
					prompt_summary: "My App run",
				},
				other: {
					id: "launcher-2",
					status: "running",
					project_dir: "/tmp/other-app",
					project_name: "Other App",
					session_id: "agent-other-app",
					bundle_path: "",
					prompt_file: "/tmp/other-app/prompt.md",
					started_at: new Date().toISOString(),
					attempts: 1,
					max_attempts: 1,
					model: "gpt-5.5",
					prompt_summary: "Other App run",
				},
			},
		};

		provider.filterToProject("/tmp/my-app");

		const runsNode = getCodexRunsNode(provider);

		expect(runsNode.runs.map((run) => run.workspacePath)).toEqual([
			"/tmp/my-app",
		]);
		expect(runsNode.runs.map((run) => run.taskId)).toEqual(["bg-1"]);
	});

	test("Symphony Run Attempts keep dogfood launcher-only rows distinct", async () => {
		const provider = await createProvider([]);
		const fixturePath = path.join(
			process.cwd(),
			"test",
			"fixtures",
			"agent-status",
			"dogfood-live-tasks.json",
		);
		const registry = JSON.parse(
			fs.readFileSync(fixturePath, "utf8"),
		) as TaskRegistry;
		(
			provider as unknown as {
				registry: TaskRegistry;
			}
		).registry = registry;

		const expectedCodexLauncherCount = Object.values(registry.tasks).filter(
			isCodexLauncherTask,
		).length;
		expect(expectedCodexLauncherCount).toBeGreaterThan(90);

		const runsNode = getCodexRunsNode(provider);

		const launcherSourceIds = runsNode.runs
			.map((run) => run.source)
			.filter((source) => source.kind === "launcher")
			.map((source) => source.id);

		expect(runsNode.runs).toHaveLength(expectedCodexLauncherCount);
		expect(new Set(launcherSourceIds).size).toBe(launcherSourceIds.length);
		expect(runsNode.runs.some((run) => run.mergedFrom.length > 1)).toBe(false);

		const item = provider.getTreeItem(runsNode);
		expect(String(item.description)).toContain("needs attention");
		expect(String(item.description)).toContain("stopped");
		expect(String(item.description)).toContain("completed");
		const tooltip = (item.tooltip as { value: string }).value;
		expect(tooltip).toContain("Failed:");
		expect(tooltip).toContain("Stopped:");
		expect(tooltip).toContain("Succeeded:");
		expect(tooltip.indexOf("Running:")).toBeLessThan(
			tooltip.indexOf("Failed:"),
		);
		expect(tooltip.indexOf("Failed:")).toBeLessThan(
			tooltip.indexOf("Stopped:"),
		);
		expect(tooltip.indexOf("Stopped:")).toBeLessThan(
			tooltip.indexOf("Succeeded:"),
		);
	});

	test("Symphony Run Attempts surface mode and next step for failed owner rows", async () => {
		const provider = await createProvider([]);
		setLauncherTasks(provider, [
			{
				...createLauncherTask({
					id: "team-contract-failure",
					status: "contract_failure",
					source_authority: "launcher",
					owner_kind: "launcher",
					agent_backend: "claude",
					prompt_summary: "Fix Symphony continuation",
					tracker_kind: "linear",
					issue_identifier: "CC-456",
					issue_state: "Human Review",
					workflow_file: "/Users/ostehost/projects/command-central/WORKFLOW.md",
				}),
				team: "full",
			} as AgentTask,
		]);

		const run = findCodexRun(
			provider,
			(candidate) => candidate.runId === "team-contract-failure",
		);
		const details = provider.getChildren({ type: "codexRun", run });

		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Mode" &&
					node.value === "team:full",
			),
		).toBe(true);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Next step" &&
					node.value ===
						"Review evidence, then route launcher fixup or relaunch (team:full)",
			),
		).toBe(true);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Automation source" &&
					node.value === "Tracker-driven (linear)",
			),
		).toBe(true);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Issue" &&
					node.value === "CC-456 · Human Review",
			),
		).toBe(true);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Workflow contract" &&
					node.value === "/Users/ostehost/projects/command-central/WORKFLOW.md",
			),
		).toBe(true);
	});

	test("Symphony Run Attempts exclude non-Codex launcher-only rows from projection", async () => {
		const provider = await createAgentStatusProvider([]);
		const symphonyProvider = await createProvider([]);
		const launcherTask = createLauncherTask({
			id: "codex-looking-claude-row",
			agent_backend: "claude",
			session_id: "codex-looking-session",
			prompt_summary: "codex-looking prompt",
		});
		setLauncherTasks(provider, [launcherTask]);
		setLauncherTasks(symphonyProvider, [launcherTask]);

		const root = provider.getChildren();
		expect(
			root.some(
				(node) =>
					node.type === "task" && node.task.id === "codex-looking-claude-row",
			),
		).toBe(true);
		expect(getCodexRunNodes(symphonyProvider)).toHaveLength(0);
	});

	test("Symphony Run Attempts idle tree matches the operator snapshot", async () => {
		const provider = await createProvider([]);
		assertTreeSnapshot(
			"idle",
			renderTreeSnapshot(provider, getCodexRunsNode(provider)),
		);
	});

	test("Symphony Run Attempts active joined tree matches the operator snapshot", async () => {
		const provider = await createProvider([
			createTask({
				taskId: "bg-joined",
				task: "Review the Symphony projection",
				childSessionKey: "session:agent-symphony",
				status: "running",
				runId: "run-bg-joined",
				lastEventAt: Date.now() - 30_000,
			}),
		]);
		setLauncherTasks(provider, [
			createLauncherTask({
				id: "launcher-joined",
				status: "running",
				project_dir: "/tmp/symphony-app",
				project_name: "Symphony App",
				session_id: "agent-symphony",
				stream_file: "/tmp/symphony-app/stream.jsonl",
				handoff_file: "/tmp/symphony-app/handoff.md",
				prompt_file: "/tmp/symphony-app/prompt.md",
				model: "gpt-5.5",
				role: "reviewer",
				agent_backend: "codex",
				terminal_backend: "applescript",
				prompt_summary: "Review the Symphony projection",
				updated_at: new Date(Date.now() - 20_000).toISOString(),
			}),
		]);

		assertTreeSnapshot(
			"active_joined",
			renderTreeSnapshot(provider, getCodexRunsNode(provider)),
		);
	});

	test("Symphony Workstreams tree matches the conductor snapshot", async () => {
		const matchedTask = createTask({
			taskId: "bg-workstream-1",
			task: "Implement conductor grouping",
			runtime: "subagent",
			status: "running",
			childSessionKey: "session-workstream-1",
		});
		const provider = await createProvider(
			[matchedTask],
			[
				createFlow({
					flowId: "flow-symphony-preview",
					label: "Symphony preview conductor",
					status: "running",
					tasks: [
						matchedTask,
						createTask({
							taskId: "bg-workstream-2",
							task: "Review conductor evidence",
							runtime: "subagent",
							status: "queued",
							childSessionKey: "session-workstream-2",
						}),
					],
				}),
			],
		);
		const flowsNode = getTaskFlowsNode(provider);

		assertTreeSnapshot(
			"workstream_conductor",
			renderTreeSnapshot(provider, flowsNode),
		);
	});

	test("dedups OpenClaw tasks that match launcher session ids", async () => {
		const provider = await createAgentStatusProvider([
			createTask({ childSessionKey: "session:agent-my-app" }),
		]);
		(
			provider as unknown as {
				registry: {
					version: number;
					tasks: Record<string, unknown>;
				};
			}
		).registry = {
			version: 2,
			tasks: {
				launcher: {
					id: "launcher-1",
					status: "running",
					project_dir: "/tmp/my-app",
					project_name: "My App",
					session_id: "agent-my-app",
					bundle_path: "",
					prompt_file: "",
					started_at: new Date().toISOString(),
					attempts: 1,
					max_attempts: 1,
				},
			},
		};

		const root = provider.getChildren();
		expect(root.some((node) => node.type === "backgroundTasks")).toBe(false);
	});

	test("dedups OpenClaw tasks by explicit task and run identity", async () => {
		const cases = [
			{
				openclaw: createTask({
					taskId: "launcher-task-id",
					childSessionKey: "session:unrelated-task",
				}),
				launcher: createLauncherTask({
					id: "launcher-task-id",
					session_id: "different-task-session",
				}),
			},
			{
				openclaw: createTask({
					taskId: "bg-run-id",
					runId: "launcher-run-id",
					childSessionKey: "session:unrelated-run",
				}),
				launcher: createLauncherTask({
					id: "launcher-run-id",
					session_id: "different-run-session",
				}),
			},
		];

		for (const { openclaw, launcher } of cases) {
			const provider = await createAgentStatusProvider([openclaw]);
			setLauncherTasks(provider, [launcher]);

			const root = provider.getChildren();
			expect(
				root.some(
					(node) =>
						node.type === "openclawTask" &&
						node.task.taskId === openclaw.taskId,
				),
			).toBe(false);
		}
	});

	test("does not dedupe OpenClaw tasks by label-only launcher id matches", async () => {
		const provider = await createAgentStatusProvider([
			createTask({
				taskId: "bg-label",
				label: "launcher-1",
				childSessionKey: "session:owner-task",
			}),
		]);
		setLauncherTasks(provider, [
			createLauncherTask({
				id: "launcher-1",
				session_id: "unrelated-session",
			}),
		]);

		const root = provider.getChildren();
		expect(
			root.some(
				(node) =>
					node.type === "openclawTask" && node.task.taskId === "bg-label",
			),
		).toBe(true);
	});

	test("does not dedupe OpenClaw tasks by substring session matches", async () => {
		const provider = await createAgentStatusProvider([
			createTask({
				taskId: "bg-session",
				childSessionKey: "session:abc-extra",
			}),
		]);
		setLauncherTasks(provider, [
			createLauncherTask({
				id: "launcher-abc",
				session_id: "abc",
			}),
		]);

		const root = provider.getChildren();
		expect(
			root.some(
				(node) =>
					node.type === "openclawTask" && node.task.taskId === "bg-session",
			),
		).toBe(true);
	});

	test("task flow children do not reuse launchers by label-only id matches", async () => {
		const provider = await createProvider(
			[],
			[
				createFlow({
					tasks: [
						createTask({
							taskId: "bg-flow-label",
							runtime: "subagent",
							label: "launcher-1",
							childSessionKey: "session:flow-only",
						}),
					],
				}),
			],
		);
		setLauncherTasks(provider, [
			createLauncherTask({
				id: "launcher-1",
				session_id: "unrelated-session",
			}),
		]);

		const children = getSingleTaskFlowChildren(provider);
		expect(
			children.some(
				(node) =>
					node.type === "taskFlowChild" && node.taskId === "bg-flow-label",
			),
		).toBe(true);
		expect(
			children.some(
				(node) => node.type === "task" && node.task.id === "launcher-1",
			),
		).toBe(false);
	});

	test("task flow children do not reuse launchers by substring session matches", async () => {
		const provider = await createProvider(
			[],
			[
				createFlow({
					tasks: [
						createTask({
							taskId: "bg-flow-session",
							runtime: "subagent",
							childSessionKey: "session:abc-extra",
						}),
					],
				}),
			],
		);
		setLauncherTasks(provider, [
			createLauncherTask({
				id: "launcher-abc",
				session_id: "abc",
			}),
		]);

		const children = getSingleTaskFlowChildren(provider);
		expect(
			children.some(
				(node) =>
					node.type === "taskFlowChild" && node.taskId === "bg-flow-session",
			),
		).toBe(true);
		expect(
			children.some(
				(node) => node.type === "task" && node.task.id === "launcher-abc",
			),
		).toBe(false);
	});

	test("Symphony Workstreams group children by explicit identity, not workstream/task title text", async () => {
		// Two TaskFlow children share the workstream's title verbatim, but only one
		// carries an explicit launcher identity (taskId match). Title-text grouping
		// would adopt both rows; explicit-identity grouping must keep the unmatched
		// row as a placeholder and never broad-match by label/title text.
		const explicitChild = createTask({
			taskId: "launcher-explicit-id",
			runtime: "subagent",
			task: "Symphony preview conductor",
			label: "Symphony preview conductor",
			childSessionKey: "session:flow-only",
		});
		const titleOnlyChild = createTask({
			taskId: "bg-title-only",
			runtime: "subagent",
			task: "Symphony preview conductor",
			label: "Symphony preview conductor",
			childSessionKey: "session:flow-title-only",
		});
		const provider = await createProvider(
			[],
			[
				createFlow({
					flowId: "flow-symphony-preview",
					label: "Symphony preview conductor",
					status: "running",
					tasks: [explicitChild, titleOnlyChild],
				}),
			],
		);
		setLauncherTasks(provider, [
			createLauncherTask({
				id: "launcher-explicit-id",
				session_id: "different-session-from-flow",
			}),
			createLauncherTask({
				id: "launcher-title-only",
				prompt_summary: "Symphony preview conductor",
				session_id: "different-session-still",
			}),
		]);

		const children = getSingleTaskFlowChildren(provider);

		// Explicit taskId match → reuse the launcher row by identity.
		expect(
			children.some(
				(node) =>
					node.type === "task" && node.task.id === "launcher-explicit-id",
			),
		).toBe(true);
		// Title/prompt-text match alone must NOT be promoted to a launcher row.
		expect(
			children.some(
				(node) =>
					node.type === "task" && node.task.id === "launcher-title-only",
			),
		).toBe(false);
		// The unmatched workstream task stays a placeholder so the operator can
		// see the missing identity.
		expect(
			children.some(
				(node) =>
					node.type === "taskFlowChild" && node.taskId === "bg-title-only",
			),
		).toBe(true);
	});

	test("task flow children reuse launchers by explicit task and run identity", async () => {
		const cases = [
			{
				flowTask: createTask({
					taskId: "launcher-task-id",
					runtime: "subagent",
					childSessionKey: "session:unrelated-task",
				}),
				launcher: createLauncherTask({
					id: "launcher-task-id",
					session_id: "different-task-session",
				}),
			},
			{
				flowTask: createTask({
					taskId: "bg-flow-run-id",
					runId: "launcher-run-id",
					runtime: "subagent",
					childSessionKey: "session:unrelated-run",
				}),
				launcher: createLauncherTask({
					id: "launcher-run-id",
					session_id: "different-run-session",
				}),
			},
		];

		for (const { flowTask, launcher } of cases) {
			const provider = await createProvider(
				[],
				[
					createFlow({
						tasks: [flowTask],
					}),
				],
			);
			setLauncherTasks(provider, [launcher]);

			const children = getSingleTaskFlowChildren(provider);
			expect(
				children.some(
					(node) => node.type === "task" && node.task.id === launcher.id,
				),
			).toBe(true);
			expect(
				children.some(
					(node) =>
						node.type === "taskFlowChild" && node.taskId === flowTask.taskId,
				),
			).toBe(false);
		}
	});

	test("exact normalized sessions still dedupe OpenClaw tasks and reuse TaskFlow launchers", async () => {
		const provider = await createProvider(
			[
				createTask({
					taskId: "bg-exact",
					childSessionKey: "session:abc",
				}),
			],
			[
				createFlow({
					tasks: [
						createTask({
							taskId: "bg-flow-exact",
							runtime: "subagent",
							childSessionKey: "session:abc",
						}),
					],
				}),
			],
		);
		setLauncherTasks(provider, [
			createLauncherTask({
				id: "launcher-exact",
				session_id: "abc",
			}),
		]);

		const root = provider.getChildren();
		expect(
			root.some(
				(node) =>
					node.type === "openclawTask" && node.task.taskId === "bg-exact",
			),
		).toBe(false);

		const children = getSingleTaskFlowChildren(provider);
		expect(
			children.some(
				(node) => node.type === "task" && node.task.id === "launcher-exact",
			),
		).toBe(true);
	});

	test("exact normalized sessions match when the session prefix is on the launcher side", async () => {
		const provider = await createProvider(
			[
				createTask({
					taskId: "bg-reverse-exact",
					childSessionKey: "abc",
				}),
			],
			[
				createFlow({
					tasks: [
						createTask({
							taskId: "bg-flow-reverse-exact",
							runtime: "subagent",
							childSessionKey: "abc",
						}),
					],
				}),
			],
		);
		setLauncherTasks(provider, [
			createLauncherTask({
				id: "launcher-reverse-exact",
				session_id: "session:abc",
			}),
		]);

		const root = provider.getChildren();
		expect(
			root.some(
				(node) =>
					node.type === "openclawTask" &&
					node.task.taskId === "bg-reverse-exact",
			),
		).toBe(false);

		const children = getSingleTaskFlowChildren(provider);
		expect(
			children.some(
				(node) =>
					node.type === "task" && node.task.id === "launcher-reverse-exact",
			),
		).toBe(true);
	});

	test("Symphony Run Attempts projection keeps loose OpenClaw launcher matches separate", async () => {
		const cases = [
			{
				openclaw: createTask({
					taskId: "bg-label-projection",
					label: "launcher-label",
					childSessionKey: "session:owner-label",
				}),
				launcher: createLauncherTask({
					id: "launcher-label",
					session_id: "unrelated-label-session",
					agent_backend: "codex",
					model: "gpt-5.5",
					stream_file: "/tmp/my-app/label-stream.jsonl",
				}),
			},
			{
				openclaw: createTask({
					taskId: "bg-session-projection",
					childSessionKey: "session:abc-extra",
				}),
				launcher: createLauncherTask({
					id: "launcher-abc",
					session_id: "abc",
					agent_backend: "codex",
					model: "gpt-5.5",
					stream_file: "/tmp/my-app/session-stream.jsonl",
				}),
			},
			{
				openclaw: createTask({
					taskId: "bg-project-projection",
					label: "My App",
					childSessionKey: "session:bg-project",
				}),
				launcher: createLauncherTask({
					id: "launcher-project",
					session_id: "session:other",
					agent_backend: "codex",
					project_dir: "/tmp/my-app",
					project_name: "My App",
					model: "gpt-5.5",
				}),
			},
		];

		for (const { openclaw, launcher } of cases) {
			const provider = await createProvider([openclaw]);
			setLauncherTasks(provider, [launcher]);

			const runs = getCodexRunNodes(provider).map((node) => node.run);
			const ownerRun = runs.find((run) => run.taskId === openclaw.taskId);
			const launcherRun = runs.find((run) => run.source.kind === "launcher");

			expect(runs).toHaveLength(2);
			expect(ownerRun?.mergedFrom).toEqual([
				{ kind: "openclaw-task", id: openclaw.taskId },
			]);
			expect(ownerRun?.workspacePath).toBeUndefined();
			expect(ownerRun?.model).toBeUndefined();
			expect(ownerRun?.artifactPaths).toBeUndefined();
			expect(launcherRun?.runId).toBe(launcher.id);
		}
	});

	test("Symphony Run Attempts projection enriches exact session joins without changing lifecycle authority", async () => {
		const provider = await createProvider([
			createTask({
				taskId: "bg-projected-exact",
				childSessionKey: "session:abc",
			}),
		]);
		setLauncherTasks(provider, [
			createLauncherTask({
				id: "launcher-projected-exact",
				session_id: "abc",
				agent_backend: "codex",
				model: "gpt-5.5",
				stream_file: "/tmp/my-app/exact-stream.jsonl",
			}),
		]);

		const run = findCodexRun(
			provider,
			(candidate) => candidate.taskId === "bg-projected-exact",
		);
		expect(getCodexRunNodes(provider)).toHaveLength(1);
		expect(run.source).toEqual({
			kind: "openclaw-task",
			id: "bg-projected-exact",
		});
		expect(run.mergedFrom).toContainEqual({
			kind: "launcher",
			id: "launcher-projected-exact",
			path: "/tmp/my-app",
		});
		expect(run.workspacePath).toBe("/tmp/my-app");
		expect(run.model).toBe("gpt-5.5");
		expect(run.artifactPaths).toContain("/tmp/my-app/exact-stream.jsonl");

		const details = provider.getChildren({ type: "codexRun", run });
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Lifecycle owner" &&
					node.value === "OpenClaw task bg-projected-exact",
			),
		).toBe(true);
	});

	test("Symphony Run Attempts mirrors runtime snapshot rows from owner metadata", async () => {
		const provider = await createProvider([]);
		setLauncherTasks(provider, [
			createLauncherTask({
				id: "snapshot-row",
				agent_backend: "claude",
				source_authority: "launcher",
				owner_kind: "launcher",
				turn_count: 7,
				codex_input_tokens: 1200,
				codex_output_tokens: 800,
				codex_total_tokens: 2000,
				runtime_seconds: 1834.2,
				retry_attempt: 3,
				retry_due_at: "2026-02-24T20:16:00Z",
				retry_error: "no available orchestrator slots",
				rate_limit_summary: "remaining=42 · reset_at=2026-02-24T21:00:00Z",
			}),
		]);

		const runsNode = getCodexRunsNode(provider);
		const runsItem = provider.getTreeItem(runsNode);
		expect(runsItem.description).toContain("1 retrying");
		expect(runsItem.description).toContain("2000 tokens");

		const [runNode] = getCodexRunNodes(provider);
		if (!runNode) throw new Error("No projected Codex run found");
		const details = provider.getChildren(runNode);
		const valuesByLabel = new Map(
			details
				.filter((node) => node.type === "detail")
				.map((node) => [node.label, node.value]),
		);
		expect(valuesByLabel.get("Turns")).toBe("7");
		expect(valuesByLabel.get("Tokens")).toBe(
			"input 1200 · output 800 · total 2000",
		);
		expect(valuesByLabel.get("Runtime")).toBe("1834s");
		expect(valuesByLabel.get("Retry")).toBe(
			"attempt 3 · due 2026-02-24T20:16:00Z · error no available orchestrator slots",
		);
		expect(valuesByLabel.get("Rate limits")).toBe(
			"remaining=42 · reset_at=2026-02-24T21:00:00Z",
		);
	});

	test("projected Codex Run tree items remain read-only", async () => {
		const provider = await createProvider([
			createTask({
				taskId: "bg-readonly",
				childSessionKey: "session:agent-my-app",
			}),
		]);
		setLauncherTasks(provider, [
			createLauncherTask({
				id: "launcher-readonly",
				session_id: "agent-my-app",
				agent_backend: "codex",
				stream_file: "/tmp/my-app/read-only-stream.jsonl",
			}),
		]);

		const runNode = getCodexRunNodes(provider)[0];
		if (!runNode) throw new Error("No projected Codex run found");

		const item = provider.getTreeItem(runNode);
		expect(item.command).toBeUndefined();
		expect(item.contextValue).toBe("codexRun.running");
		expect((item.tooltip as { value: string }).value).toContain(
			"Lifecycle Owner",
		);

		const detailItems = provider.getChildren(runNode).map((node) => ({
			node,
			item: provider.getTreeItem(node),
		}));
		const nonArtifactDetailCommands = detailItems
			.filter(
				({ node }) =>
					node.type === "detail" &&
					node.label !== "Run attempt ID" &&
					!node.label.startsWith("Artifact") &&
					!node.label.startsWith("Evidence:"),
			)
			.map(({ item }) => item.command)
			.filter(Boolean);
		expect(nonArtifactDetailCommands).toEqual([]);
		expect(
			detailItems.find(
				({ node }) => node.type === "detail" && node.label === "Run attempt ID",
			)?.item.command,
		).toMatchObject({
			command: "commandCentral.copyToClipboard",
			title: "Copy Run Attempt ID",
		});
		expect(
			detailItems
				.filter(
					({ node }) =>
						node.type === "detail" &&
						(node.label.startsWith("Artifact") ||
							node.label.startsWith("Evidence:")),
				)
				.map(({ item }) => item.command?.command),
		).toEqual(["vscode.open"]);

		const packageJson = JSON.parse(
			fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
		) as {
			contributes?: {
				menus?: {
					"view/item/context"?: Array<{
						command: string;
						when?: string;
					}>;
				};
			};
		};
		const lifecycleCommand =
			/cancel|claim|kill|launch|remove|resume|retry|restart/i;
		const codexRunLifecycleMenus =
			packageJson.contributes?.menus?.["view/item/context"]?.filter(
				(entry) =>
					entry.when?.includes("codexRun") &&
					lifecycleCommand.test(entry.command),
			) ?? [];
		expect(codexRunLifecycleMenus).toEqual([]);
	});

	test("blocked status renders as Needs Approval with shield icon", async () => {
		const provider = await createProvider([createTask({ status: "blocked" })]);
		const item = provider.getTreeItem({
			type: "openclawTask",
			task: createTask({ status: "blocked" }),
		});
		expect(item.contextValue).toBe("openclawTask.blocked");
		expect(item.iconPath).toMatchObject({ id: "shield" });

		const details = provider.getChildren({
			type: "openclawTask",
			task: createTask({ status: "blocked" }),
		});
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Status" &&
					node.value === "Needs Approval",
			),
		).toBe(true);
	});

	test("running OpenClaw tasks contribute to summary working count", async () => {
		const provider = await createProvider([createTask({ status: "running" })]);
		expect(countAgentStatuses(provider.getTasks()).working).toBe(1);
	});

	test("summary includes background task count", async () => {
		const provider = await createAgentStatusProvider([
			createTask({ taskId: "bg-1" }),
			createTask({ taskId: "bg-2", status: "succeeded" }),
		]);
		const root = provider.getChildren();
		const summary = root.find((node) => node.type === "summary");
		if (summary?.type !== "summary") {
			throw new Error("No summary node found");
		}
		expect(summary.label).toContain("2 background tasks");
	});

	test("task flow children reuse matching OpenClaw task nodes", async () => {
		const task = createTask({
			taskId: "bg-1",
			runtime: "subagent",
			childSessionKey: "session-abc123",
		});
		const provider = await createProvider(
			[task],
			[
				createFlow({
					tasks: [
						createTask({
							taskId: "bg-1",
							runtime: "subagent",
							childSessionKey: "session-abc123",
						}),
					],
				}),
			],
		);

		const flowsNode = getTaskFlowsNode(provider);
		const groups = provider.getChildren(flowsNode);
		const group = groups.find((node) => node.type === "taskFlowGroup");
		if (group?.type !== "taskFlowGroup") {
			throw new Error("No taskFlowGroup node found");
		}
		const children = provider.getChildren(group);
		expect(
			children.some(
				(node) => node.type === "openclawTask" && node.task.taskId === "bg-1",
			),
		).toBe(true);
	});

	test("task flow children fall back to placeholders when unmatched", async () => {
		const provider = await createProvider(
			[],
			[
				createFlow({
					tasks: [createTask({ taskId: "bg-unmatched", runtime: "subagent" })],
				}),
			],
		);

		const flowsNode = getTaskFlowsNode(provider);
		const groups = provider.getChildren(flowsNode);
		const group = groups.find((node) => node.type === "taskFlowGroup");
		if (group?.type !== "taskFlowGroup") {
			throw new Error("No taskFlowGroup node found");
		}
		const children = provider.getChildren(group);
		expect(
			children.some(
				(node) =>
					node.type === "taskFlowChild" && node.taskId === "bg-unmatched",
			),
		).toBe(true);
	});

	test("package contributions expose OpenClaw task context actions", async () => {
		const packageJson = await import("../../package.json");
		const menuEntries =
			packageJson.default.contributes.menus["view/item/context"];
		expect(
			menuEntries.some(
				(entry: { command: string; when: string }) =>
					entry.command === "commandCentral.cancelOpenClawTask" &&
					entry.when === "viewItem =~ /^openclawTask\\.(running|queued)$/",
			),
		).toBe(true);
		expect(
			menuEntries.some(
				(entry: { command: string; when: string }) =>
					entry.command === "commandCentral.showOpenClawTaskDetail" &&
					entry.when === "viewItem =~ /^openclawTask\\./",
			),
		).toBe(true);
	});

	test("cross-project OpenClaw issues surface tracker, workspace, and node identity (CC-006)", async () => {
		// A real dogfood lane: a Linear-tracked issue targeting a different
		// project, executing on a remote node. The base detail rows
		// (runtime/status) used to be all that rendered, so this looked
		// identical to a local background task. The cross-project orchestration
		// identity must now be visible.
		const crossProjectTask = createTask({
			taskId: "bg-cross-project",
			task: "Dogfood cross-project orchestration",
			status: "running",
			trackerKind: "linear",
			issueIdentifier: "PAR-158",
			issueState: "In Progress",
			issueUrl: "https://linear.app/partnerai/issue/PAR-158",
			workspacePath: "/Users/ostemini/projects/ghostty-launcher",
			execMode: "spoke",
			execNodeName: "node-2",
			nodeConnected: false,
			workflowName: "release-prep",
		});
		const provider = await createProvider([crossProjectTask]);

		const details = provider.getChildren({
			type: "openclawTask",
			task: crossProjectTask,
		});
		const detailRows = details.filter(
			(node): node is Extract<AgentNode, { type: "detail" }> =>
				node.type === "detail",
		);
		const rowsByLabel = new Map(detailRows.map((node) => [node.label, node]));

		const trackedIssue = rowsByLabel.get("Tracked issue");
		if (!trackedIssue) {
			throw new Error("No Tracked issue detail row");
		}
		expect(trackedIssue.value).toBe("linear · PAR-158 · In Progress");
		// The issue URL must be openable directly from the row.
		expect(trackedIssue.command?.command).toBe("vscode.open");
		expect(String(trackedIssue.command?.arguments?.[0])).toContain(
			"https://linear.app/partnerai/issue/PAR-158",
		);

		expect(rowsByLabel.get("Project workspace")?.value).toBe(
			"/Users/ostemini/projects/ghostty-launcher",
		);
		expect(rowsByLabel.get("Execution node")?.value).toBe(
			"node-2 · disconnected",
		);
		expect(rowsByLabel.get("Workflow contract")?.value).toBe("release-prep");

		// The inline tree item tooltip must also disclose the tracked issue so a
		// cross-project lane is recognizable without expanding it.
		const item = provider.getTreeItem({
			type: "openclawTask",
			task: crossProjectTask,
		});
		expect((item.tooltip as { value: string }).value).toContain(
			"Tracked issue: linear · PAR-158 · In Progress",
		);
	});

	test("plain local OpenClaw tasks add no cross-project orchestration rows (CC-006)", async () => {
		const localTask = createTask({ taskId: "bg-local", status: "running" });
		const provider = await createProvider([localTask]);

		const details = provider.getChildren({
			type: "openclawTask",
			task: localTask,
		});
		const labels = details
			.filter(
				(node): node is Extract<AgentNode, { type: "detail" }> =>
					node.type === "detail",
			)
			.map((node) => node.label);
		expect(labels).not.toContain("Tracked issue");
		expect(labels).not.toContain("Project workspace");
		expect(labels).not.toContain("Execution node");
		expect(labels).not.toContain("Workflow contract");
	});
});
