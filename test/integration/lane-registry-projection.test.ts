/**
 * Work Registry lane projection — screenshot-regression acceptance suite.
 *
 * Dogfood regression (2026-06-11): active launcher lanes carrying the Work
 * Registry fields (`project_ref`, `canonical_project_dir`, `execution_dir`,
 * `lane_kind`) vanished from Agent Status and Symphony after the launcher
 * tasks.json quarantine — SYMPHONY showed 0 / "no projected runs" and Agent
 * Status sat on "Waiting for agents..." while lanes were live.
 *
 * Verifies, against a temp lane registry wired through the explicit
 * `commandCentral.laneRegistry.files` setting (legacy quarantine untouched):
 *   - active LaneRef records render and count as visible lanes (non-empty
 *     root, non-zero Symphony projection);
 *   - stale launcher-era rows (no project_ref) in the same file stay hidden
 *     under default settings;
 *   - the legacy diagnostics opt-in still ingests the full file;
 *   - grouping prefers project_ref.id (worktree lanes join the canonical
 *     project group, never a basename/worktree-label group);
 *   - unresolved records collapse under UNREGISTERED PROJECTS instead of
 *     fabricating basename-derived project groups;
 *   - the injectable resolver adapter attributes legacy records by directory.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentNode,
	ProjectGroupNode,
} from "../../src/providers/agent-status-tree-provider.js";
import { UNREGISTERED_PROJECT_GROUP_NAME } from "../../src/providers/agent-status-tree-provider.js";
import { createStaticProjectRefResolver } from "../../src/utils/project-ref-resolver.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

type ProviderModule =
	typeof import("../../src/providers/agent-status-tree-provider.js");
type ProviderInstance = InstanceType<ProviderModule["AgentStatusTreeProvider"]>;

const CANONICAL_DIR = "/tmp/registry-fixture/command-central";
const WORKTREE_DIR =
	"/tmp/registry-fixture/command-central-cc-lane-fixup-20260611";

function createLaneRecord(
	id: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id,
		task_id: id,
		status: "running",
		source_authority: "launcher",
		owner_kind: "launcher",
		project_ref: {
			id: "command-central",
			displayName: "Command Central",
			status: "registered",
			registry_status: "active",
			repoOrigins: ["github.com/ostehost/command-central"],
		},
		lane_kind: "implementation",
		canonical_project_dir: CANONICAL_DIR,
		execution_dir: CANONICAL_DIR,
		project_dir: CANONICAL_DIR,
		project_name: "Command Central",
		exec_cwd: CANONICAL_DIR,
		session_id: `agent-${id}`,
		tmux_session: `agent-${id}`,
		bundle_path: "/Applications/Projects/command-central.app",
		prompt_file: "/tmp/prompt.md",
		started_at: "2026-06-11T10:00:00.000Z",
		attempts: 1,
		max_attempts: 3,
		// Remote-node lane: liveness is trusted from the exec metadata, so the
		// fixture stays `running` without probing a real tmux session here.
		exec_mode: "node",
		exec_host: "registry-fixture-node",
		exec_node: "registry-fixture-node",
		...overrides,
	};
}

/** Launcher-era row: predates the Work Registry, no project_ref. */
function createStaleLegacyRecord(id: string): Record<string, unknown> {
	return {
		id,
		status: "completed",
		project_dir: "/tmp/registry-fixture/old-checkout",
		project_name: "Old Stale Project",
		session_id: `agent-${id}`,
		bundle_path: "/Applications/Old.app",
		prompt_file: "/tmp/prompt.md",
		started_at: "2026-05-01T10:00:00.000Z",
		attempts: 1,
		max_attempts: 3,
	};
}

function getProjectGroups(children: AgentNode[]): ProjectGroupNode[] {
	return children.filter(
		(node): node is ProjectGroupNode => node.type === "projectGroup",
	);
}

function getSymphonySummaryLabel(children: AgentNode[]): string {
	const summary = children.find(
		(node): node is Extract<AgentNode, { type: "summary" }> =>
			node.type === "summary" &&
			node.label.startsWith("Symphony Status Surface:"),
	);
	if (!summary) throw new Error("No Symphony summary node found");
	return summary.label;
}

function getStateLabels(children: AgentNode[]): string[] {
	return children
		.filter(
			(node): node is Extract<AgentNode, { type: "state" }> =>
				node.type === "state",
		)
		.map((node) => node.label);
}

describe("Work Registry lane projection", () => {
	let tmpDir = "";
	let provider: ProviderInstance | null = null;
	let originalNodeEnv = "";
	let originalTasksFileEnv: string | undefined;

	beforeEach(() => {
		mock.restore();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-lane-registry-"));
		originalNodeEnv = process.env["NODE_ENV"] ?? "";
		originalTasksFileEnv = process.env["TASKS_FILE"];
		delete process.env["TASKS_FILE"];
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

	function writeRegistry(
		fileName: string,
		tasks: Record<string, Record<string, unknown>>,
	): string {
		const registryPath = path.join(tmpDir, fileName);
		fs.writeFileSync(registryPath, JSON.stringify({ version: 2, tasks }));
		return registryPath;
	}

	async function createProvider(options: {
		laneRegistryFiles?: string[];
		agentTasksFile?: string;
		legacyLauncherEnabled?: boolean;
		viewMode?: "agentStatus" | "symphony";
		projectRefResolver?: import("../../src/utils/project-ref-resolver.js").ProjectRefResolver;
	}): Promise<ProviderInstance> {
		const vscodeMock = setupVSCodeMock();
		vscodeMock.workspace.getConfiguration = mock((_section?: string) => ({
			get: mock((key: string, defaultValue?: unknown) => {
				if (key === "laneRegistry.files") {
					return options.laneRegistryFiles ?? [];
				}
				if (key === "agentTasksFile") {
					return options.agentTasksFile ?? "";
				}
				if (key === "legacyLauncherTasks.enabled") {
					return options.legacyLauncherEnabled ?? false;
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
		provider = new AgentStatusTreeProvider(undefined, undefined, {
			...(options.viewMode ? { viewMode: options.viewMode } : {}),
			...(options.projectRefResolver
				? { projectRefResolver: options.projectRefResolver }
				: {}),
		});
		return provider;
	}

	test("active LaneRef records render instead of the empty state (screenshot regression)", async () => {
		const laneFile = writeRegistry("lanes.json", {
			"lane-impl-1": createLaneRecord("lane-impl-1"),
			"lane-review-1": createLaneRecord("lane-review-1", {
				lane_kind: "review",
			}),
			"stale-old-row": createStaleLegacyRecord("stale-old-row"),
		});

		const treeProvider = await createProvider({
			laneRegistryFiles: [laneFile],
		});

		const taskIds = treeProvider.getTasks().map((task) => task.id);
		expect(taskIds.sort()).toEqual(["lane-impl-1", "lane-review-1"]);

		const children = treeProvider.getChildren();
		expect(getStateLabels(children)).toEqual([]);

		const symphonyLabel = getSymphonySummaryLabel(children);
		expect(symphonyLabel).not.toContain("no projected runs");
		expect(symphonyLabel).toContain("2 standalone run attempts");
		expect(symphonyLabel).toContain("2 running");

		const groups = getProjectGroups(children);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.projectName).toBe("Command Central");
		expect(groups[0]?.projectDir).toBe(CANONICAL_DIR);
		expect(groups[0]?.tasks.map((task) => task.lane_kind).sort()).toEqual([
			"implementation",
			"review",
		]);
	});

	test("Symphony view projects active LaneRef records as run attempts", async () => {
		const laneFile = writeRegistry("lanes.json", {
			"lane-impl-1": createLaneRecord("lane-impl-1"),
		});

		const treeProvider = await createProvider({
			laneRegistryFiles: [laneFile],
			viewMode: "symphony",
		});

		const children = treeProvider.getChildren();
		const codexRuns = children.find(
			(node): node is Extract<AgentNode, { type: "codexRuns" }> =>
				node.type === "codexRuns",
		);
		expect(codexRuns?.runs).toHaveLength(1);
		expect(codexRuns?.runs[0]?.runId).toBe("lane-impl-1");
		expect(codexRuns?.runs[0]?.status).toBe("running");
	});

	test("lane registry holding only stale legacy rows stays empty under default settings", async () => {
		const laneFile = writeRegistry("lanes.json", {
			"stale-old-row": createStaleLegacyRecord("stale-old-row"),
		});

		const treeProvider = await createProvider({
			laneRegistryFiles: [laneFile],
		});

		expect(treeProvider.getTasks()).toEqual([]);
		const children = treeProvider.getChildren();
		expect(getSymphonySummaryLabel(children)).toContain("no projected runs");
		expect(getStateLabels(children)).toEqual(["Waiting for agents..."]);
	});

	test("legacy diagnostics opt-in still ingests the full file", async () => {
		const laneFile = writeRegistry("lanes.json", {
			"lane-impl-1": createLaneRecord("lane-impl-1"),
			"stale-old-row": createStaleLegacyRecord("stale-old-row"),
		});

		const treeProvider = await createProvider({
			agentTasksFile: laneFile,
			legacyLauncherEnabled: true,
		});

		const taskIds = treeProvider.getTasks().map((task) => task.id);
		expect(taskIds.sort()).toEqual(["lane-impl-1", "stale-old-row"]);
	});

	test("worktree lanes group under project_ref.id, never a basename or worktree label", async () => {
		const laneFile = writeRegistry("lanes.json", {
			"lane-canonical": createLaneRecord("lane-canonical"),
			"lane-worktree": createLaneRecord("lane-worktree", {
				project_dir: WORKTREE_DIR,
				execution_dir: WORKTREE_DIR,
				exec_cwd: WORKTREE_DIR,
				visible_project_name: "command-central cc lane fixup 20260611",
				lane_kind: "review",
			}),
		});

		const treeProvider = await createProvider({
			laneRegistryFiles: [laneFile],
		});

		const groups = getProjectGroups(treeProvider.getChildren());
		expect(groups).toHaveLength(1);
		expect(groups[0]?.projectName).toBe("Command Central");
		expect(groups[0]?.projectDir).toBe(CANONICAL_DIR);
		expect(groups[0]?.tasks).toHaveLength(2);

		const groupNames = groups.map((group) => group.projectName);
		expect(groupNames).not.toContain(path.basename(WORKTREE_DIR));
		expect(groupNames).not.toContain("command-central cc lane fixup 20260611");
	});

	test("unresolved records collapse under UNREGISTERED PROJECTS instead of a basename group", async () => {
		// Raw record with no project_ref, no project_id, and no explicit
		// project_name: normalization derives the name from the path basename,
		// which must never become a top-level project group.
		const laneFile = writeRegistry("lanes.json", {
			"lane-impl-1": createLaneRecord("lane-impl-1"),
			"orphan-row": {
				id: "orphan-row",
				status: "completed",
				project_dir: "/tmp/registry-fixture/mystery-worktree",
				session_id: "agent-orphan-row",
				bundle_path: "/Applications/Old.app",
				prompt_file: "/tmp/prompt.md",
				started_at: "2026-05-01T10:00:00.000Z",
				attempts: 1,
				max_attempts: 3,
			},
		});

		const treeProvider = await createProvider({
			agentTasksFile: laneFile,
			legacyLauncherEnabled: true,
		});

		const groups = getProjectGroups(treeProvider.getChildren());
		const groupNames = groups.map((group) => group.projectName);
		expect(groupNames).not.toContain("mystery-worktree");
		expect(groupNames).toContain(UNREGISTERED_PROJECT_GROUP_NAME);

		const unregistered = groups.find((group) => group.unregistered === true);
		expect(unregistered?.tasks.map((task) => task.id)).toEqual(["orphan-row"]);
		// Diagnostics bucket sorts after real project groups.
		expect(groups[groups.length - 1]?.unregistered).toBe(true);

		const item = treeProvider.getTreeItem(
			unregistered as AgentNode,
		) as import("vscode").TreeItem;
		expect(String(item.label)).toContain("UNREGISTERED PROJECTS");
		expect(item.contextValue).toBe("projectGroupUnregistered");
		expect(String(item.description)).toContain("no Work Registry resolution");
	});

	test("injectable resolver adapter attributes legacy records by canonical directory", async () => {
		const laneFile = writeRegistry("lanes.json", {
			"adopted-row": {
				id: "adopted-row",
				status: "completed",
				project_dir: WORKTREE_DIR,
				session_id: "agent-adopted-row",
				bundle_path: "/Applications/Old.app",
				prompt_file: "/tmp/prompt.md",
				started_at: "2026-05-01T10:00:00.000Z",
				attempts: 1,
				max_attempts: 3,
			},
		});

		const treeProvider = await createProvider({
			agentTasksFile: laneFile,
			legacyLauncherEnabled: true,
			projectRefResolver: createStaticProjectRefResolver([
				{
					id: "command-central",
					displayName: "Command Central",
					directories: [CANONICAL_DIR, WORKTREE_DIR],
					repoOrigins: ["github.com/ostehost/command-central"],
				},
			]),
		});

		const groups = getProjectGroups(treeProvider.getChildren());
		expect(groups).toHaveLength(1);
		expect(groups[0]?.projectName).toBe("Command Central");
		expect(groups[0]?.unregistered).toBeUndefined();
		expect(groups[0]?.tasks.map((task) => task.id)).toEqual(["adopted-row"]);
	});
});
