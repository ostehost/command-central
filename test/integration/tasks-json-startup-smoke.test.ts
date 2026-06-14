import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNode } from "../../src/providers/agent-status-tree-provider.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

type ProviderModule =
	typeof import("../../src/providers/agent-status-tree-provider.js");
type ProviderInstance = InstanceType<ProviderModule["AgentStatusTreeProvider"]>;

const alphaBetaFixturePath = path.join(
	process.cwd(),
	"test",
	"fixtures",
	"agent-status",
	"alpha-beta-12.json",
);

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

function expectedEmptyAgentStatusChildren(
	options: { legacyDiagnostics?: boolean } = {},
): AgentNode[] {
	return [
		// The deprecated legacy escape hatch pins a warning row first so a
		// diagnostics session is always visibly marked.
		...(options.legacyDiagnostics
			? [
					{
						type: "state" as const,
						label: "Legacy launcher diagnostics (deprecated)",
						description:
							"commandCentral.legacyLauncherTasks.enabled ingests stale launcher rows — diagnostics only",
						icon: "warning",
					},
				]
			: []),
		{
			type: "summary",
			kind: "sources" as const,
			label: "Sources",
			tooltip:
				"Sources — read-only provenance feed. Symphony workstreams and run attempts contribute to Agent Status as a source; they do not compete as a separate status denominator. Open the Symphony view for the read-only Operations Dashboard, Running Sessions, Retry Queue, and Workstreams.",
		},
		{
			type: "state",
			label: "Waiting for agents...",
			description: "Start Claude Code, Codex, or Gemini in any terminal",
			icon: "search",
		},
	];
}

describe("tasks.json startup smoke", () => {
	let tmpDir = "";
	let provider: ProviderInstance | null = null;
	let originalNodeEnv = "";
	let originalTasksFileEnv: string | undefined;

	beforeEach(() => {
		mock.restore();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tasks-smoke-"));
		originalNodeEnv = process.env["NODE_ENV"] ?? "";
		originalTasksFileEnv = process.env["TASKS_FILE"];
		process.env["NODE_ENV"] = "test";
	});

	afterEach(() => {
		provider?.dispose();
		provider = null;
		process.env["NODE_ENV"] = originalNodeEnv;
		if (originalTasksFileEnv === undefined) {
			delete process.env["TASKS_FILE"];
		} else {
			process.env["TASKS_FILE"] = originalTasksFileEnv;
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	async function createProvider(
		tasksFile: string,
		options: {
			legacyLauncherEnabled?: boolean;
			workspaceFolders?: Array<{
				uri: { fsPath: string };
				name: string;
				index: number;
			}>;
		} = {},
	): Promise<ProviderInstance> {
		const vscodeMock = setupVSCodeMock();
		if (options.workspaceFolders) {
			vscodeMock.workspace.workspaceFolders = options.workspaceFolders;
		}
		vscodeMock.workspace.getConfiguration = mock((_section?: string) => ({
			get: mock((key: string, defaultValue?: unknown) => {
				if (key === "agentTasksFile") {
					return tasksFile;
				}
				if (key === "legacyLauncherTasks.enabled") {
					return options.legacyLauncherEnabled ?? false;
				}
				if (key === "discovery.enabled") {
					return false;
				}
				// Keep the default lane registries (real $HOME paths) out of this
				// hermetic smoke; the zero-config default is proven in
				// lane-registry-projection.test.ts under a sandboxed $HOME.
				if (key === "laneRegistry.files") {
					return [];
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

	/** Write a launcher-format registry with a single poisoned stale task. */
	function writeStaleRegistry(registryPath: string): void {
		fs.mkdirSync(path.dirname(registryPath), { recursive: true });
		fs.writeFileSync(
			registryPath,
			JSON.stringify({
				version: 2,
				tasks: {
					"stale-launcher-task": createTask("stale-launcher-task"),
				},
			}),
		);
	}

	test("starts with missing tasks.json without crashing", async () => {
		const tasksFile = path.join(tmpDir, "tasks.json");
		const treeProvider = await createProvider(tasksFile, {
			legacyLauncherEnabled: true,
		});

		expect(treeProvider.getTasks()).toEqual([]);
		expect(treeProvider.getChildren()).toEqual(
			expectedEmptyAgentStatusChildren({ legacyDiagnostics: true }),
		);
	});

	test("starts with empty tasks.json without crashing", async () => {
		const tasksFile = path.join(tmpDir, "tasks.json");
		fs.writeFileSync(tasksFile, "");

		const treeProvider = await createProvider(tasksFile, {
			legacyLauncherEnabled: true,
		});

		expect(treeProvider.getTasks()).toEqual([]);
		expect(treeProvider.getChildren()).toEqual(
			expectedEmptyAgentStatusChildren({ legacyDiagnostics: true }),
		);
	});

	test("starts with malformed JSON, logs a warning, and shows no agents", async () => {
		const tasksFile = path.join(tmpDir, "tasks.json");
		fs.writeFileSync(tasksFile, "{not-json");

		const originalWarn = console.warn;
		const warnMock = mock(() => {});
		console.warn = warnMock;

		try {
			const treeProvider = await createProvider(tasksFile, {
				legacyLauncherEnabled: true,
			});
			expect(treeProvider.getTasks()).toEqual([]);
			expect(treeProvider.getChildren()).toEqual(
				expectedEmptyAgentStatusChildren({ legacyDiagnostics: true }),
			);
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

		const treeProvider = await createProvider(tasksFile, {
			legacyLauncherEnabled: true,
		});

		expect(treeProvider.getTasks()).toHaveLength(1);
		expect(treeProvider.getTasks()[0]?.id).toBe("task-1");
	});

	test("starts with TASKS_FILE override and displays agents", async () => {
		process.env["TASKS_FILE"] = alphaBetaFixturePath;

		const treeProvider = await createProvider("");

		expect(treeProvider.getTasks()).toHaveLength(12);
		expect(treeProvider.getTasks().map((task) => task.id)).toContain("alpha-1");
		expect(treeProvider.getTasks().map((task) => task.id)).toContain("beta-6");
		expect(
			Array.from(
				new Set(treeProvider.getTasks().map((task) => task.project_name)),
			),
		).toEqual(["Alpha", "Beta"]);
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

		const treeProvider = await createProvider(tasksFile, {
			legacyLauncherEnabled: true,
		});

		expect(treeProvider.getTasks()).toHaveLength(1);
		expect(treeProvider.getTasks()[0]?.id).toBe("legacy-task");
	});

	// ── Launcher quarantine (legacy default OFF) ─────────────────────────
	// Regression guard for the contamination class where a test (or default
	// dogfood session) silently ingested the operator's real global
	// ~/.config/ghostty-launcher/tasks.json registry.

	test("does NOT ingest explicit agentTasksFile when legacy launcher ingestion is off (default)", async () => {
		const tasksFile = path.join(tmpDir, "tasks.json");
		writeStaleRegistry(tasksFile);

		const treeProvider = await createProvider(tasksFile);

		expect(treeProvider.getTasks()).toEqual([]);
		expect(treeProvider.getChildren()).toEqual(
			expectedEmptyAgentStatusChildren(),
		);
	});

	test("does NOT ingest global or workspace launcher registries by default", async () => {
		// Workspace folder with an implicit .ghostty-launcher/tasks.json. On a
		// dev machine the operator's real global ~/.config/ghostty-launcher
		// registry may exist too; with legacy off, the resolver must return no
		// paths at all, so neither source can leak into Agent Status.
		const workspaceDir = path.join(tmpDir, "workspace");
		writeStaleRegistry(
			path.join(workspaceDir, ".ghostty-launcher", "tasks.json"),
		);

		const treeProvider = await createProvider("", {
			workspaceFolders: [
				{ uri: { fsPath: workspaceDir }, name: "workspace", index: 0 },
			],
		});

		expect(treeProvider.filePaths).toEqual([]);
		expect(treeProvider.getTasks()).toEqual([]);
		expect(treeProvider.getChildren()).toEqual(
			expectedEmptyAgentStatusChildren(),
		);
	});

	test("ambient TASKS_FILE is sanitized by the global preload", () => {
		// Launcher-spawned shells export TASKS_FILE pointing at the operator's
		// real registry, and the resolver honors it unconditionally. The
		// global preload (test/setup/global-test-cleanup.ts) must delete it so
		// only tests that set it explicitly can resolve an env tasks file —
		// otherwise every empty-registry expectation in the suite ingests live
		// operator tasks and fails non-deterministically.
		expect(process.env["TASKS_FILE"]).toBeUndefined();
	});

	test("legacy escape hatch re-enables implicit workspace registry ingestion", async () => {
		const workspaceDir = path.join(tmpDir, "workspace");
		writeStaleRegistry(
			path.join(workspaceDir, ".ghostty-launcher", "tasks.json"),
		);

		const treeProvider = await createProvider("", {
			legacyLauncherEnabled: true,
			workspaceFolders: [
				{ uri: { fsPath: workspaceDir }, name: "workspace", index: 0 },
			],
		});

		expect(treeProvider.getTasks()).toHaveLength(1);
		expect(treeProvider.getTasks()[0]?.id).toBe("stale-launcher-task");
	});
});
