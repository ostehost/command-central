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

	function getSingleTaskFlowChildren(provider: {
		getChildren: (element?: AgentNode) => AgentNode[];
	}): AgentNode[] {
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
		return provider.getChildren(group);
	}

	function getCodexRunsNode(provider: {
		getChildren: (element?: AgentNode) => AgentNode[];
	}): Extract<AgentNode, { type: "codexRuns" }> {
		const root = provider.getChildren();
		const runsNode = root.find((node) => node.type === "codexRuns");
		if (!runsNode || runsNode.type !== "codexRuns") {
			throw new Error("No Symphony Run Attempts node found");
		}
		return runsNode;
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
		const provider = await createProvider([createTask()]);
		const root = provider.getChildren();
		expect(root.some((node) => node.type === "openclawTask")).toBe(true);
	});

	test("Symphony Run Attempts container remains visible when empty", async () => {
		const provider = await createProvider([]);
		const root = provider.getChildren();
		const runsNode = root.find((node) => node.type === "codexRuns");
		if (!runsNode || runsNode.type !== "codexRuns") {
			throw new Error("No Symphony / Run Attempts node found");
		}

		const item = provider.getTreeItem(runsNode);
		expect(item.label).toBe("Symphony / Run Attempts · 0");
		expect(item.description).toBe("no projected runs");

		const children = provider.getChildren(runsNode);
		expect(children).toContainEqual({
			type: "state",
			label: "No projected run attempts",
			description: "OpenClaw, TaskFlow, or launcher rows will appear here",
			icon: "circle-slash",
		});
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

		const root = provider.getChildren();
		const runsNode = root.find((node) => node.type === "codexRuns");
		if (!runsNode || runsNode.type !== "codexRuns") {
			throw new Error("No Symphony Run Attempts node found");
		}

		const item = provider.getTreeItem(runsNode);
		expect(item.label).toBe("Symphony / Run Attempts · 1");
		expect(item.description).toBe("1 working");
		expect((item.tooltip as { value: string }).value).toContain(
			"read-only projected run attempt",
		);
		expect((item.tooltip as { value: string }).value).toContain(
			"Lifecycle ownership stays with the source owner",
		);

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

		const root = provider.getChildren();
		const runsNode = root.find((node) => node.type === "codexRuns");
		if (!runsNode || runsNode.type !== "codexRuns") {
			throw new Error("No Symphony Run Attempts node found");
		}

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

		const root = provider.getChildren();
		const runsNode = root.find((node) => node.type === "codexRuns");
		if (!runsNode || runsNode.type !== "codexRuns") {
			throw new Error("No Symphony Run Attempts node found");
		}

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
		const provider = await createProvider([]);
		const launcherTask = createLauncherTask({
			id: "codex-looking-claude-row",
			agent_backend: "claude",
			session_id: "codex-looking-session",
			prompt_summary: "codex-looking prompt",
		});
		setLauncherTasks(provider, [launcherTask]);

		const root = provider.getChildren();
		expect(
			root.some(
				(node) =>
					node.type === "task" && node.task.id === "codex-looking-claude-row",
			),
		).toBe(true);
		expect(getCodexRunNodes(provider)).toHaveLength(0);
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
		const root = provider.getChildren();
		const flowsNode = root.find((node) => node.type === "taskflows");
		if (!flowsNode || flowsNode.type !== "taskflows") {
			throw new Error("No Symphony Workstreams node found");
		}

		assertTreeSnapshot(
			"workstream_conductor",
			renderTreeSnapshot(provider, flowsNode),
		);
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
			const provider = await createProvider([openclaw]);
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
		const provider = await createProvider([
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
		const provider = await createProvider([
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
