import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
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
			progressSummary: string;
			lastEventAt: number;
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

	async function createProvider(
		openclawTasks: ReturnType<typeof createTask>[],
		flows: ReturnType<typeof createFlow>[] = [],
	) {
		setConfig({ groupByProject: false });
		const { AgentStatusTreeProvider } = await import(
			"../../src/providers/agent-status-tree-provider.js"
		);
		const provider = new AgentStatusTreeProvider();
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

	test("OpenClaw tasks appear inline in flat mode", async () => {
		const provider = await createProvider([createTask()]);
		const root = provider.getChildren();
		expect(root.some((node) => node.type === "openclawTask")).toBe(true);
	});

	test("Codex Runs container appears and expands to projected details", async () => {
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
					prompt_summary: "Projected Codex run",
				},
			},
		};

		const root = provider.getChildren();
		const runsNode = root.find((node) => node.type === "codexRuns");
		if (!runsNode || runsNode.type !== "codexRuns") {
			throw new Error("No Codex Runs node found");
		}

		const item = provider.getTreeItem(runsNode);
		expect(item.label).toBe("Codex Runs · 1");

		const runs = provider.getChildren(runsNode);
		const run = runs.find((node) => node.type === "codexRun");
		if (!run || run.type !== "codexRun") {
			throw new Error("No Codex run child found");
		}
		expect(run.run.source).toEqual({ kind: "openclaw-task", id: "bg-1" });
		expect(run.run.mergedFrom).toContainEqual({
			kind: "launcher",
			id: "launcher-1",
			path: "/tmp/my-app",
		});

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
					node.label === "Source status" &&
					node.value === "running",
			),
		).toBe(true);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Lifecycle owner" &&
					node.value === "openclaw-task:bg-1",
			),
		).toBe(true);
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Run ID" &&
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
					node.label === "Artifact" &&
					node.value === "/tmp/my-app/stream.jsonl",
			),
		).toBe(true);
	});

	test("Codex Runs respect the Agent Status project filter", async () => {
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

		const root = provider.getChildren();
		const runsNode = root.find((node) => node.type === "codexRuns");
		if (!runsNode || runsNode.type !== "codexRuns") {
			throw new Error("No Codex Runs node found");
		}

		expect(runsNode.runs.map((run) => run.workspacePath)).toEqual([
			"/tmp/my-app",
		]);
		expect(runsNode.runs.map((run) => run.taskId)).toEqual(["bg-1"]);
	});

	test("Codex Runs keep dogfood launcher-only rows distinct", async () => {
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

		const root = provider.getChildren();
		const runsNode = root.find((node) => node.type === "codexRuns");
		if (!runsNode || runsNode.type !== "codexRuns") {
			throw new Error("No Codex Runs node found");
		}

		const launcherSourceIds = runsNode.runs
			.map((run) => run.source)
			.filter((source) => source.kind === "launcher")
			.map((source) => source.id);

		expect(runsNode.runs).toHaveLength(expectedCodexLauncherCount);
		expect(new Set(launcherSourceIds).size).toBe(launcherSourceIds.length);
		expect(runsNode.runs.some((run) => run.mergedFrom.length > 1)).toBe(false);
	});

	test("dedups OpenClaw tasks that match launcher session ids", async () => {
		const provider = await createProvider([
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
		const provider = await createProvider([
			createTask({ taskId: "bg-1" }),
			createTask({ taskId: "bg-2", status: "succeeded" }),
		]);
		const root = provider.getChildren();
		const summary = root.find((node) => node.type === "summary");
		if (!summary || summary.type !== "summary") {
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

		const root = provider.getChildren();
		const flowsNode = root.find((node) => node.type === "taskflows");
		if (!flowsNode || flowsNode.type !== "taskflows") {
			throw new Error("No taskflows node found");
		}
		const groups = provider.getChildren(flowsNode);
		const group = groups.find((node) => node.type === "taskFlowGroup");
		if (!group || group.type !== "taskFlowGroup") {
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

		const root = provider.getChildren();
		const flowsNode = root.find((node) => node.type === "taskflows");
		if (!flowsNode || flowsNode.type !== "taskflows") {
			throw new Error("No taskflows node found");
		}
		const groups = provider.getChildren(flowsNode);
		const group = groups.find((node) => node.type === "taskFlowGroup");
		if (!group || group.type !== "taskFlowGroup") {
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
});
