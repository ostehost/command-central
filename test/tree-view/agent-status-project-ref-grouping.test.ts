/**
 * Work Registry project_ref grouping (cc-project-ref-consumer-fixup).
 *
 * Group identity precedence: embedded `project_ref.id` → launcher
 * `project_id` → injectable resolver adapter. Directories claimed by an
 * identity lane (project_dir, canonical_project_dir, execution_dir,
 * exec_cwd) route legacy records and discovered agents in the same checkout
 * into the canonical group. Records with no identity and no explicit
 * launcher name collapse under the UNREGISTERED PROJECTS bucket, which is
 * pinned after real project groups.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UNREGISTERED_PROJECT_GROUP_NAME } from "../../src/providers/agent-status-tree-provider.js";
import {
	type AgentNode,
	type AgentTask,
	createMockRegistry,
	createMockTask,
	createProviderHarness,
	disposeHarness,
	type ProviderHarness,
	setAgentStatusConfig,
} from "./_helpers/agent-status-tree-provider-test-base.js";

type ProjectGroupNode = Extract<AgentNode, { type: "projectGroup" }>;

const MAIN_DIR = "/Users/test/projects/command-central";
const WORKTREE_DIR = "/Users/test/projects/command-central-lane-fixup";

function getProjectGroups(children: AgentNode[]): ProjectGroupNode[] {
	return children.filter(
		(node): node is ProjectGroupNode => node.type === "projectGroup",
	);
}

function createLaneRefTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return createMockTask({
		id: "lane-ref-task",
		status: "running",
		project_dir: MAIN_DIR,
		project_name: "Command Central",
		project_ref: {
			id: "command-central",
			displayName: "Command Central",
			registry_status: "active",
		},
		lane_kind: "implementation",
		canonical_project_dir: MAIN_DIR,
		execution_dir: MAIN_DIR,
		session_id: "agent-lane-ref",
		tmux_session: "agent-lane-ref",
		...overrides,
	});
}

describe("AgentStatusTreeProvider — project_ref grouping", () => {
	let h: ProviderHarness;

	beforeEach(() => {
		h = createProviderHarness();
		setAgentStatusConfig(h.vscodeMock, { groupByProject: true });
	});

	afterEach(() => {
		disposeHarness(h);
	});

	test("project_ref.id is preferred over project_id for group identity", () => {
		const laneA = createLaneRefTask({
			id: "lane-a",
			project_id: "stale-id-a",
			session_id: "agent-lane-a",
			tmux_session: "agent-lane-a",
		});
		const laneB = createLaneRefTask({
			id: "lane-b",
			project_id: "stale-id-b",
			project_dir: WORKTREE_DIR,
			execution_dir: WORKTREE_DIR,
			visible_project_name: "command central lane fixup",
			session_id: "agent-lane-b",
			tmux_session: "agent-lane-b",
		});
		h.provider.readRegistry = () =>
			createMockRegistry({ [laneA.id]: laneA, [laneB.id]: laneB });
		h.provider.reload();

		const groups = getProjectGroups(h.provider.getChildren());
		expect(groups).toHaveLength(1);
		expect(groups[0]?.projectName).toBe("Command Central");
		expect(groups[0]?.tasks.map((t) => t.id).sort()).toEqual([
			"lane-a",
			"lane-b",
		]);
	});

	test("execution_dir claimed by a LaneRef lane routes legacy records into the group", () => {
		const lane = createLaneRefTask({ execution_dir: WORKTREE_DIR });
		const legacy = createMockTask({
			id: "legacy-in-worktree",
			status: "completed",
			project_dir: WORKTREE_DIR,
			project_id: null,
			project_name: "command-central-lane-fixup",
			session_id: "agent-legacy",
			tmux_session: "agent-legacy",
		});
		h.provider.readRegistry = () =>
			createMockRegistry({ [lane.id]: lane, [legacy.id]: legacy });
		h.provider.reload();

		const groups = getProjectGroups(h.provider.getChildren());
		expect(groups).toHaveLength(1);
		expect(groups[0]?.projectName).toBe("Command Central");
		expect(groups[0]?.tasks.map((t) => t.id).sort()).toEqual([
			"lane-ref-task",
			"legacy-in-worktree",
		]);
	});

	test("group dir prefers the canonical project dir over a worktree lane dir", () => {
		const worktreeOnly = createLaneRefTask({
			project_dir: WORKTREE_DIR,
			execution_dir: WORKTREE_DIR,
			visible_project_name: "command central lane fixup",
		});
		h.provider.readRegistry = () =>
			createMockRegistry({ [worktreeOnly.id]: worktreeOnly });
		h.provider.reload();

		const groups = getProjectGroups(h.provider.getChildren());
		expect(groups).toHaveLength(1);
		expect(groups[0]?.projectDir).toBe(MAIN_DIR);
	});

	test("unregistered bucket is pinned last even when its tasks are running", () => {
		const lane = createLaneRefTask({ status: "completed" });
		const orphan = createMockTask({
			id: "orphan-task",
			status: "running",
			project_dir: "/Users/test/projects/mystery-worktree",
			project_name: "mystery-worktree",
			project_name_derived: true,
			session_id: "agent-orphan",
			tmux_session: "agent-orphan",
		});
		h.provider.readRegistry = () =>
			createMockRegistry({ [lane.id]: lane, [orphan.id]: orphan });
		h.provider.reload();

		const groups = getProjectGroups(h.provider.getChildren());
		expect(groups.map((g) => g.projectName)).toEqual([
			"Command Central",
			UNREGISTERED_PROJECT_GROUP_NAME,
		]);
		expect(groups[1]?.unregistered).toBe(true);
		expect(groups.map((g) => g.projectName)).not.toContain("mystery-worktree");
	});

	test("derived-name records never form a basename group; explicit names still do", () => {
		const explicitLegacy = createMockTask({
			id: "explicit-legacy",
			status: "completed",
			project_dir: "/Users/test/projects/alpha",
			project_name: "Alpha",
			session_id: "agent-alpha",
			tmux_session: "agent-alpha",
		});
		const derivedLegacy = createMockTask({
			id: "derived-legacy",
			status: "completed",
			project_dir: "/Users/test/projects/beta",
			project_name: "beta",
			project_name_derived: true,
			session_id: "agent-beta",
			tmux_session: "agent-beta",
		});
		h.provider.readRegistry = () =>
			createMockRegistry({
				[explicitLegacy.id]: explicitLegacy,
				[derivedLegacy.id]: derivedLegacy,
			});
		h.provider.reload();

		const groups = getProjectGroups(h.provider.getChildren());
		expect(groups.map((g) => g.projectName).sort()).toEqual([
			"Alpha",
			UNREGISTERED_PROJECT_GROUP_NAME,
		]);
	});

	test("identity groups with no project_dir get distinct TreeItem ids", () => {
		// Registry-backed lanes that carry a distinct project_ref.id but no
		// project_dir, canonical_project_dir, or exec dirs. normalizeTask derives
		// project_name "(unknown project)" for such rows, which buildProjectNodes
		// then stores as the group's projectDir — a NON-blank shared placeholder.
		// A projectDir-based id key collapses every such group onto the same
		// `project:(unknown project)` TreeItem id even though they are separate
		// groups keyed by project_ref.id; VS Code then loses correct
		// refresh/reveal/expanded-state for all but one. The id must come from the
		// authoritative grouping key, not the display dir/name.
		const dirlessA = createMockTask({
			id: "dirless-a",
			project_dir: "",
			project_name: "(unknown project)",
			canonical_project_dir: undefined,
			execution_dir: undefined,
			exec_cwd: undefined,
			project_ref: { id: "proj-a", displayName: "Project A" },
			session_id: "agent-proj-a",
			tmux_session: "agent-proj-a",
		});
		const dirlessB = createMockTask({
			id: "dirless-b",
			project_dir: "",
			project_name: "(unknown project)",
			canonical_project_dir: undefined,
			execution_dir: undefined,
			exec_cwd: undefined,
			project_ref: { id: "proj-b", displayName: "Project B" },
			session_id: "agent-proj-b",
			tmux_session: "agent-proj-b",
		});
		h.provider.readRegistry = () =>
			createMockRegistry({
				[dirlessA.id]: dirlessA,
				[dirlessB.id]: dirlessB,
			});
		h.provider.reload();

		const groups = getProjectGroups(h.provider.getChildren());
		expect(groups).toHaveLength(2);
		const ids = groups.map(
			(group) => (h.provider.getTreeItem(group) as { id?: string }).id,
		);
		expect(ids.every((id): id is string => Boolean(id))).toBe(true);
		expect(new Set(ids).size).toBe(2);
	});
});
