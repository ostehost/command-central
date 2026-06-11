/**
 * Activity bar badge truth + canonical project grouping (CC-002).
 *
 * VS Code sums every view badge inside an activity bar container. Agent
 * Status and Symphony are two AgentStatusTreeProvider instances over the
 * same data, so exactly one of them may write badges — otherwise the
 * container icon shows 2× the running count (dogfood: 1 running showed
 * "2", 2 running showed "4").
 *
 * Grouping: launcher lanes running in detached worktrees share the
 * project's `project_id` and must group under the canonical project group,
 * not under a path-derived worktree name.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type AgentNode,
	AgentStatusTreeProvider,
	type AgentTask,
	createDiscoveredAgent,
	createMockRegistry,
	createMockTask,
	createProviderHarness,
	disposeHarness,
	InMemoryReviewTracker,
	type ProviderHarness,
	setAgentStatusConfig,
	setDiscoveredAgents,
} from "./_helpers/agent-status-tree-provider-test-base.js";

type ViewBadge = { value: number; tooltip: string };
type MockTreeView = { badge?: ViewBadge };
type ProjectGroupNode = Extract<AgentNode, { type: "projectGroup" }>;

function attachTreeView(provider: AgentStatusTreeProvider): MockTreeView {
	const view: MockTreeView = { badge: undefined };
	provider.setTreeView(view as unknown as import("vscode").TreeView<AgentNode>);
	return view;
}

function getProjectGroups(children: AgentNode[]): ProjectGroupNode[] {
	return children.filter(
		(node): node is ProjectGroupNode => node.type === "projectGroup",
	);
}

const MAIN_DIR = "/Users/test/projects/command-central";
const WORKTREE_DIR =
	"/Users/test/projects/command-central-cc-002-activity-badge-20260611";

function createCanonicalLane(overrides: Partial<AgentTask> = {}): AgentTask {
	return createMockTask({
		id: "cc-001-health-followup",
		status: "running",
		project_dir: MAIN_DIR,
		project_id: "command-central",
		project_name: "Command Central",
		visible_project_name: null,
		session_id: "agent-cc-001",
		tmux_session: "agent-cc-001",
		...overrides,
	});
}

function createWorktreeLane(overrides: Partial<AgentTask> = {}): AgentTask {
	return createMockTask({
		id: "cc-002-activity-badge",
		status: "running",
		project_dir: WORKTREE_DIR,
		project_id: "command-central",
		project_name: "command-central",
		visible_project_name: "command-central cc 002 activity badge 20260611",
		session_id: "agent-cc-002",
		tmux_session: "agent-cc-002",
		...overrides,
	});
}

describe("AgentStatusTreeProvider — activity badge single source", () => {
	let h: ProviderHarness;

	beforeEach(() => {
		h = createProviderHarness();
	});

	afterEach(() => {
		disposeHarness(h);
	});

	test("running + completed → badge counts only the running task", () => {
		const view = attachTreeView(h.provider);
		h.provider.readRegistry = () =>
			createMockRegistry({
				running: createMockTask({ id: "running", status: "running" }),
				completed: createMockTask({
					id: "completed",
					status: "completed",
					session_id: "agent-completed",
					tmux_session: "agent-completed",
				}),
			});
		h.provider.reload();

		expect(view.badge?.value).toBe(1);
		expect(view.badge?.tooltip).toBe("1 working agent");
	});

	test("all completed → badge clears after the last task finishes", () => {
		const view = attachTreeView(h.provider);
		h.provider.readRegistry = () =>
			createMockRegistry({
				running: createMockTask({ id: "running", status: "running" }),
			});
		h.provider.reload();
		expect(view.badge?.value).toBe(1);

		h.provider.readRegistry = () =>
			createMockRegistry({
				running: createMockTask({ id: "running", status: "completed" }),
			});
		h.provider.reload();
		expect(view.badge).toBeUndefined();
	});

	test("multiple running → badge N", () => {
		const view = attachTreeView(h.provider);
		h.provider.readRegistry = () =>
			createMockRegistry({
				a: createMockTask({
					id: "a",
					status: "running",
					session_id: "agent-a",
					tmux_session: "agent-a",
				}),
				b: createMockTask({
					id: "b",
					status: "running",
					session_id: "agent-b",
					tmux_session: "agent-b",
				}),
				c: createMockTask({
					id: "c",
					status: "running",
					session_id: "agent-c",
					tmux_session: "agent-c",
				}),
			});
		h.provider.reload();

		expect(view.badge?.value).toBe(3);
		expect(view.badge?.tooltip).toBe("3 working agents");
	});

	test("failed task needs attention but does not inflate the working badge", () => {
		const view = attachTreeView(h.provider);
		h.provider.readRegistry = () =>
			createMockRegistry({
				running: createMockTask({ id: "running", status: "running" }),
				failed: createMockTask({
					id: "failed",
					status: "failed",
					session_id: "agent-failed",
					tmux_session: "agent-failed",
				}),
			});
		h.provider.reload();

		expect(view.badge?.value).toBe(1);
	});

	test("symphony provider never writes a view badge (flat or grouped)", () => {
		const symphony = new AgentStatusTreeProvider(
			h.projectIconManagerMock as unknown as ConstructorParameters<
				typeof AgentStatusTreeProvider
			>[0],
			undefined,
			{ viewMode: "symphony" },
		);
		try {
			symphony.setReviewTracker(
				new InMemoryReviewTracker() as unknown as Parameters<
					typeof symphony.setReviewTracker
				>[0],
			);
			const view = attachTreeView(symphony);
			symphony.readRegistry = () =>
				createMockRegistry({
					running: createMockTask({ id: "running", status: "running" }),
				});
			symphony.reload();
			symphony.getChildren();
			expect(view.badge).toBeUndefined();

			setAgentStatusConfig(h.vscodeMock, { groupByProject: true });
			symphony.getChildren();
			expect(view.badge).toBeUndefined();
		} finally {
			symphony.dispose();
		}
	});

	test("grouped and flat modes report the same badge for the same registry", () => {
		const view = attachTreeView(h.provider);
		h.provider.readRegistry = () =>
			createMockRegistry({
				running: createMockTask({ id: "running", status: "running" }),
				completed: createMockTask({
					id: "completed",
					status: "completed",
					session_id: "agent-completed",
					tmux_session: "agent-completed",
				}),
			});
		h.provider.reload();
		h.provider.getChildren();
		const flatBadge = view.badge?.value;

		setAgentStatusConfig(h.vscodeMock, { groupByProject: true });
		h.provider.getChildren();
		expect(view.badge?.value).toBe(1);
		expect(flatBadge).toBe(1);
	});
});

describe("AgentStatusTreeProvider — canonical worktree grouping", () => {
	let h: ProviderHarness;

	beforeEach(() => {
		h = createProviderHarness();
		setAgentStatusConfig(h.vscodeMock, { groupByProject: true });
	});

	afterEach(() => {
		disposeHarness(h);
	});

	test("worktree lane groups under the canonical project group", () => {
		const canonical = createCanonicalLane();
		const worktree = createWorktreeLane();
		h.provider.readRegistry = () =>
			createMockRegistry({
				[canonical.id]: canonical,
				[worktree.id]: worktree,
			});
		h.provider.reload();

		const groups = getProjectGroups(h.provider.getChildren());
		expect(groups).toHaveLength(1);
		const group = groups[0];
		if (!group) throw new Error("expected project group");
		expect(group.projectName).toBe("Command Central");
		expect(group.projectDir).toBe(MAIN_DIR);

		const childIds = h.provider
			.getChildren(group)
			.filter(
				(node): node is Extract<AgentNode, { type: "task" }> =>
					node.type === "task",
			)
			.map((node) => node.task.id);
		expect(childIds).toContain(canonical.id);
		expect(childIds).toContain(worktree.id);
	});

	test("canonical identity wins regardless of registry order", () => {
		const canonical = createCanonicalLane();
		const worktree = createWorktreeLane();
		h.provider.readRegistry = () =>
			createMockRegistry({
				[worktree.id]: worktree,
				[canonical.id]: canonical,
			});
		h.provider.reload();

		const groups = getProjectGroups(h.provider.getChildren());
		expect(groups).toHaveLength(1);
		expect(groups[0]?.projectName).toBe("Command Central");
		expect(groups[0]?.projectDir).toBe(MAIN_DIR);
	});

	test("worktree-only group uses the project name, never the path-derived label", () => {
		const worktree = createWorktreeLane();
		h.provider.readRegistry = () =>
			createMockRegistry({ [worktree.id]: worktree });
		h.provider.reload();

		const groups = getProjectGroups(h.provider.getChildren());
		expect(groups).toHaveLength(1);
		expect(groups[0]?.projectName).toBe("command-central");
	});

	test("legacy task without project_id joins the id group via shared dir", () => {
		const canonical = createCanonicalLane();
		const legacy = createMockTask({
			id: "legacy-no-project-id",
			status: "completed",
			project_dir: MAIN_DIR,
			project_id: null,
			project_name: "Command Central",
			session_id: "agent-legacy",
			tmux_session: "agent-legacy",
		});
		h.provider.readRegistry = () =>
			createMockRegistry({
				[canonical.id]: canonical,
				[legacy.id]: legacy,
			});
		h.provider.reload();

		const groups = getProjectGroups(h.provider.getChildren());
		expect(groups).toHaveLength(1);
		expect(groups[0]?.tasks.map((t) => t.id).sort()).toEqual(
			[canonical.id, legacy.id].sort(),
		);
	});

	test("discovered agent in the worktree dir joins the canonical group", () => {
		const canonical = createCanonicalLane();
		const worktree = createWorktreeLane();
		h.provider.readRegistry = () =>
			createMockRegistry({
				[canonical.id]: canonical,
				[worktree.id]: worktree,
			});
		setDiscoveredAgents(h.provider, [
			createDiscoveredAgent({ pid: 777, projectDir: WORKTREE_DIR }),
		]);
		h.provider.reload();
		setDiscoveredAgents(h.provider, [
			createDiscoveredAgent({ pid: 777, projectDir: WORKTREE_DIR }),
		]);

		const groups = getProjectGroups(h.provider.getChildren());
		expect(groups).toHaveLength(1);
		expect(groups[0]?.discoveredAgents?.map((a) => a.pid)).toEqual([777]);
	});

	test("distinct project ids keep distinct groups", () => {
		const central = createCanonicalLane();
		const other = createMockTask({
			id: "other-project-task",
			status: "running",
			project_dir: "/Users/test/projects/other",
			project_id: "other-project",
			project_name: "Other Project",
			session_id: "agent-other",
			tmux_session: "agent-other",
		});
		h.provider.readRegistry = () =>
			createMockRegistry({ [central.id]: central, [other.id]: other });
		h.provider.reload();

		const groups = getProjectGroups(h.provider.getChildren());
		expect(groups.map((g) => g.projectName).sort()).toEqual([
			"Command Central",
			"Other Project",
		]);
	});
});
