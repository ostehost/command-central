/**
 * Agent Status V2 — project-first section model
 * (cc-agent-status-v2-recovery-20260613)
 *
 * Pins the V2 doctrine end-to-end at the tree level:
 *   • project-first, not flat — root → project groups → sections
 *   • one count denominator everywhere: `Live N · Review N · Action N · History N`
 *   • locked section subgroup headers: `Live · N`, `Needs Review · N`,
 *     `Action Required · N`, `History · N`
 *   • running (incl. detached/unconfirmable) lands in Live, never Action
 *   • history is preserved (completed lanes stay visible + counted)
 *   • live-bearing projects sort before history-only projects
 *   • Symphony is folded into a read-only `Sources` provenance feed — no
 *     competing top-level "Symphony Status Surface" denominator
 *   • none of the forbidden naming-lock words leak into the rendered tree
 *
 * The count/label vocabulary is centralized in src/utils/agent-status-sections.ts
 * and unit-tested there; this file proves the provider renders it correctly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
type StatusGroupNode = Extract<AgentNode, { type: "statusGroup" }>;

const FORBIDDEN_WORDS = [
	"Current",
	"Live now",
	"Issues",
	"Problems",
	"Failed & Stopped",
	"Archive",
	"Diagnostics",
	"none active",
	"standalone run attempts",
];

function getProjectGroups(children: AgentNode[]): ProjectGroupNode[] {
	return children.filter(
		(node): node is ProjectGroupNode => node.type === "projectGroup",
	);
}

function getTaskNodesAt(children: AgentNode[]): AgentNode[] {
	return children.filter((node) => node.type === "task");
}

function makeProjectGroup(
	projectName: string,
	projectDir: string,
	tasks: AgentTask[],
): ProjectGroupNode {
	return { type: "projectGroup", projectName, projectDir, tasks };
}

describe("Agent Status V2 — project-first section model", () => {
	let h: ProviderHarness;

	beforeEach(() => {
		h = createProviderHarness();
		setAgentStatusConfig(h.vscodeMock, { groupByProject: true });
	});

	afterEach(() => {
		disposeHarness(h);
	});

	test("project-first: ≥2 projects render as project groups, never a flat task list", () => {
		const alpha = createMockTask({
			id: "alpha-run",
			status: "running",
			project_dir: "/Users/test/projects/alpha",
			project_name: "Alpha",
			session_id: "agent-alpha",
			tmux_session: "agent-alpha",
		});
		const beta = createMockTask({
			id: "beta-done",
			status: "completed",
			project_dir: "/Users/test/projects/beta",
			project_name: "Beta",
			session_id: "agent-beta",
			tmux_session: "agent-beta",
		});
		h.provider.readRegistry = () =>
			createMockRegistry({ [alpha.id]: alpha, [beta.id]: beta });
		h.provider.reload();

		const children = h.provider.getChildren();
		const groups = getProjectGroups(children);
		expect(groups.map((g) => g.projectName).sort()).toEqual(["Alpha", "Beta"]);
		// Project-first: tasks live under their project group, not at the root.
		expect(getTaskNodesAt(children)).toHaveLength(0);
	});

	test("live-bearing project sorts before a history-only project", () => {
		const liveTask = createMockTask({
			id: "live-task",
			status: "running",
			project_dir: "/Users/test/projects/zeta",
			project_name: "Zeta",
			session_id: "agent-zeta",
			tmux_session: "agent-zeta",
		});
		const historyTask = createMockTask({
			id: "history-task",
			status: "completed",
			project_dir: "/Users/test/projects/aardvark",
			project_name: "Aardvark",
			session_id: "agent-aardvark",
			tmux_session: "agent-aardvark",
		});
		h.provider.readRegistry = () =>
			createMockRegistry({
				[historyTask.id]: historyTask,
				[liveTask.id]: liveTask,
			});
		h.provider.reload();

		const groups = getProjectGroups(h.provider.getChildren());
		// Zeta has the live lane; it must sort before history-only Aardvark even
		// though Aardvark wins alphabetically.
		expect(groups.map((g) => g.projectName)).toEqual(["Zeta", "Aardvark"]);
	});

	test("per-project row description uses the single Live·Review·Action·History denominator", () => {
		const group = makeProjectGroup("Alpha", "/Users/test/projects/alpha", [
			createMockTask({ id: "a-run", status: "running" }),
			createMockTask({ id: "a-review", status: "completed_dirty" }),
			createMockTask({ id: "a-action", status: "failed" }),
			createMockTask({ id: "a-history", status: "completed" }),
		]);

		const item = h.provider.getTreeItem(group);
		expect(item.description).toBe("Live 1 · Review 1 · Action 1 · History 1");
		expect(String(item.description)).not.toContain("working");
	});

	test("running + detached lane counts as Live, never Action", () => {
		// createMockTask is detached by default (no session_key / callback_url) and
		// the harness cannot positively confirm its tmux session dead, so the lane
		// stays Live — detached is a visibility chip, not death.
		const detached = createMockTask({
			id: "detached-run",
			status: "running",
			project_dir: "/Users/test/projects/alpha",
			project_name: "Alpha",
			session_id: "agent-detached",
			tmux_session: "agent-detached",
		});
		h.provider.readRegistry = () =>
			createMockRegistry({ [detached.id]: detached });
		h.provider.reload();

		const group = getProjectGroups(h.provider.getChildren())[0];
		if (!group) throw new Error("expected a project group");
		const description = String(h.provider.getTreeItem(group).description);
		expect(description).toContain("Live 1");
		expect(description).toContain("Action 0");
	});

	test("history is preserved: completed lanes stay visible and counted, never hidden", () => {
		const group = makeProjectGroup("Alpha", "/Users/test/projects/alpha", [
			createMockTask({ id: "done-1", status: "completed" }),
			createMockTask({ id: "done-2", status: "completed" }),
		]);

		const item = h.provider.getTreeItem(group);
		expect(item.description).toBe("Live 0 · Review 0 · Action 0 · History 2");

		// ≤5 tasks → flat children; both completed lanes remain rendered.
		const childIds = getTaskNodesAt(h.provider.getChildren(group))
			.map((n) => (n.type === "task" ? n.task.id : ""))
			.sort();
		expect(childIds).toEqual(["done-1", "done-2"]);
	});

	test("section subgroup headers use the locked `Label · N` format", () => {
		// > 5 tasks → the project group renders status subgroups whose headers are
		// the locked V2 section labels with a bare count (no "agents" suffix).
		const group = makeProjectGroup("Alpha", "/Users/test/projects/alpha", [
			createMockTask({ id: "run-1", status: "running" }),
			createMockTask({ id: "run-2", status: "running" }),
			createMockTask({ id: "review-1", status: "completed_dirty" }),
			createMockTask({ id: "action-1", status: "failed" }),
			createMockTask({ id: "hist-1", status: "completed" }),
			createMockTask({ id: "hist-2", status: "completed" }),
		]);

		const subgroups = h.provider
			.getChildren(group)
			.filter((n): n is StatusGroupNode => n.type === "statusGroup");
		const labels = subgroups.map((n) =>
			String(h.provider.getTreeItem(n).label),
		);

		expect(labels).toContain("Live · 2");
		expect(labels).toContain("Needs Review · 1");
		expect(labels).toContain("Action Required · 1");
		expect(labels).toContain("History · 2");
		for (const label of labels) {
			expect(label).not.toContain("agent");
		}
	});

	test("Symphony is folded into a read-only Sources provenance row, not a rival denominator", () => {
		const task = createMockTask({
			id: "alpha-run",
			status: "running",
			project_dir: "/Users/test/projects/alpha",
			project_name: "Alpha",
			session_id: "agent-alpha",
			tmux_session: "agent-alpha",
		});
		h.provider.readRegistry = () => createMockRegistry({ [task.id]: task });
		h.provider.reload();

		const children = h.provider.getChildren();
		const sources = children.find(
			(node) => node.type === "summary" && node.label.startsWith("Sources"),
		);
		expect(sources).toBeDefined();
		for (const node of children) {
			if (node.type === "summary") {
				expect(node.label).not.toContain("Symphony Status Surface");
			}
		}
	});

	test("no forbidden naming-lock wording leaks into the rendered tree", () => {
		const tasks = {
			"f-run": createMockTask({
				id: "f-run",
				status: "running",
				project_dir: "/Users/test/projects/alpha",
				project_name: "Alpha",
				session_id: "agent-f-run",
				tmux_session: "agent-f-run",
			}),
			"f-fail": createMockTask({
				id: "f-fail",
				status: "failed",
				project_dir: "/Users/test/projects/beta",
				project_name: "Beta",
				session_id: "agent-f-fail",
				tmux_session: "agent-f-fail",
			}),
			"f-done": createMockTask({
				id: "f-done",
				status: "completed",
				project_dir: "/Users/test/projects/beta",
				project_name: "Beta",
				session_id: "agent-f-done",
				tmux_session: "agent-f-done",
			}),
		};
		h.provider.readRegistry = () => createMockRegistry(tasks);
		h.provider.reload();

		const children = h.provider.getChildren();
		const rendered: string[] = [];
		for (const node of children) {
			if (node.type === "summary" || node.type === "state") {
				rendered.push(node.label);
			}
			if (node.type === "projectGroup") {
				const item = h.provider.getTreeItem(node);
				rendered.push(String(item.label));
				rendered.push(String(item.description ?? ""));
			}
		}
		const haystack = rendered.join(" || ");
		for (const forbidden of FORBIDDEN_WORDS) {
			expect(haystack).not.toContain(forbidden);
		}
	});
});
