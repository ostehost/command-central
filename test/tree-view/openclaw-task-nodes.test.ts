import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { OpenClawTaskService } from "../../src/services/openclaw-task-service.js";
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

	async function createProvider(
		openclawTasks: ReturnType<typeof createTask>[],
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
