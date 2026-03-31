import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

type ProviderModule =
	typeof import("../../src/providers/agent-status-tree-provider.js");
type ProviderInstance = InstanceType<ProviderModule["AgentStatusTreeProvider"]>;

function createTask(id: string) {
	return {
		id,
		status: "running" as const,
		project_dir: "/tmp/demo-project",
		project_name: "Demo Project",
		session_id: `agent-${id}`,
		bundle_path: "/Applications/Demo Project.app",
		prompt_file: "/tmp/prompt.md",
		started_at: "2026-03-31T10:00:00.000Z",
		attempts: 1,
		max_attempts: 3,
	};
}

describe("tasks.json startup smoke", () => {
	let tmpDir = "";
	let provider: ProviderInstance | null = null;
	let originalNodeEnv = "";

	beforeEach(() => {
		mock.restore();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tasks-smoke-"));
		originalNodeEnv = process.env["NODE_ENV"] ?? "";
		process.env["NODE_ENV"] = "test";
	});

	afterEach(() => {
		provider?.dispose();
		provider = null;
		process.env["NODE_ENV"] = originalNodeEnv;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	async function createProvider(tasksFile: string): Promise<ProviderInstance> {
		const vscodeMock = setupVSCodeMock();
		vscodeMock.workspace.getConfiguration = mock((_section?: string) => ({
			get: mock((key: string, defaultValue?: unknown) => {
				if (key === "agentTasksFile") {
					return tasksFile;
				}
				if (key === "discovery.enabled") {
					return false;
				}
				return defaultValue;
			}),
			update: mock(() => Promise.resolve()),
			inspect: mock(() => undefined),
		}));

		const { AgentStatusTreeProvider } = await import(
			"../../src/providers/agent-status-tree-provider.js"
		);
		provider = new AgentStatusTreeProvider();
		return provider;
	}

	test("starts with missing tasks.json without crashing", async () => {
		const tasksFile = path.join(tmpDir, "tasks.json");
		const treeProvider = await createProvider(tasksFile);

		expect(treeProvider.getTasks()).toEqual([]);
		expect(treeProvider.getChildren()).toEqual([
			{
				type: "state",
				label: "No agents tracked yet",
				description: "Start an agent task to populate this view.",
				icon: "info",
			},
		]);
	});

	test("starts with empty tasks.json without crashing", async () => {
		const tasksFile = path.join(tmpDir, "tasks.json");
		fs.writeFileSync(tasksFile, "");

		const treeProvider = await createProvider(tasksFile);

		expect(treeProvider.getTasks()).toEqual([]);
		expect(treeProvider.getChildren()).toEqual([
			{
				type: "state",
				label: "No agents tracked yet",
				description: "Start an agent task to populate this view.",
				icon: "info",
			},
		]);
	});

	test("starts with malformed JSON, logs a warning, and shows no agents", async () => {
		const tasksFile = path.join(tmpDir, "tasks.json");
		fs.writeFileSync(tasksFile, "{not-json");

		const originalWarn = console.warn;
		const warnMock = mock(() => {});
		console.warn = warnMock;

		try {
			const treeProvider = await createProvider(tasksFile);
			expect(treeProvider.getTasks()).toEqual([]);
			expect(treeProvider.getChildren()).toEqual([
				{
					type: "state",
					label: "No agents tracked yet",
					description: "Start an agent task to populate this view.",
					icon: "info",
				},
			]);
			expect(warnMock).toHaveBeenCalledTimes(1);
			expect(
				String((warnMock.mock.calls as unknown[][])[0]?.[0] ?? ""),
			).toContain("Falling back to an empty tasks registry");
		} finally {
			console.warn = originalWarn;
		}
	});

	test("starts with valid tasks.json and displays agents", async () => {
		const tasksFile = path.join(tmpDir, "tasks.json");
		fs.writeFileSync(
			tasksFile,
			JSON.stringify({
				version: 2,
				tasks: {
					"task-1": createTask("task-1"),
				},
			}),
		);

		const treeProvider = await createProvider(tasksFile);

		expect(treeProvider.getTasks()).toHaveLength(1);
		expect(treeProvider.getTasks()[0]?.id).toBe("task-1");
	});

	test("starts with legacy tasks array and handles it gracefully", async () => {
		const tasksFile = path.join(tmpDir, "tasks.json");
		fs.writeFileSync(
			tasksFile,
			JSON.stringify({
				version: 2,
				tasks: [createTask("legacy-task")],
			}),
		);

		const treeProvider = await createProvider(tasksFile);

		expect(treeProvider.getTasks()).toHaveLength(1);
		expect(treeProvider.getTasks()[0]?.id).toBe("legacy-task");
	});
});
