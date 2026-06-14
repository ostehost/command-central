/**
 * Agent Status — stable TreeItem.id identity (the History "rattle" fix).
 *
 * ROOT CAUSE THIS LOCKS: project-first group nodes used to carry NO
 * `TreeItem.id`, so VS Code derived each node's handle from its parent's
 * handle + position + display label. The root project groups re-sort by
 * activity (position changes) and embed a live "(N)" count in their header
 * label (label changes), so those derived handles went stale on every
 * refresh. That orphaned deep descendants — notably the History
 * `status-group:done` rows — and made VS Code emit a storm of
 * "Failed to resolve tree node" errors with audible alert feedback whenever
 * the dense History surface was clicked or refreshed (observed live: 204
 * resolve failures across the agentStatus + symphony views on rc.61).
 *
 * CONTRACT (locked here): structural nodes carry a stable, globally-unique
 * `TreeItem.id` that does NOT depend on tree index, display label, live count,
 * or current sort position. Identical in both the `agentStatus` and `symphony`
 * views (both render through the same provider class). Nodes whose only
 * identity is a count-bearing label (`olderRuns`, transient `state`) are
 * deliberately left without an id rather than given a colliding/volatile one.
 *
 * See research/RESULT-cc-history-rattle-diagnosis-20260614.md.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type * as vscode from "vscode";
import type {
	FolderGroupNode,
	OlderRunsNode,
	ProjectGroupNode,
	StateNode,
	StatusGroupNode,
} from "../../src/providers/agent-status-tree-provider.js";
import {
	type AgentNode,
	AgentStatusTreeProvider,
	type AgentTask,
	createMockRegistry,
	createMockTask,
	createProviderHarness,
	disposeHarness,
	InMemoryReviewTracker,
	type ProviderHarness,
	setAgentStatusConfig,
} from "./_helpers/agent-status-tree-provider-test-base.js";

const PROJ_A_DIR = "/Users/test/projects/proj-a";
const PROJ_B_DIR = "/Users/test/projects/proj-b";

const projectGroupNode = (
	dir: string | undefined,
	name: string,
	tasks: AgentTask[],
	overrides: Partial<ProjectGroupNode> = {},
): ProjectGroupNode => ({
	type: "projectGroup",
	projectName: name,
	projectDir: dir,
	tasks,
	...overrides,
});

const completedTask = (id: string, dir: string, name: string): AgentTask =>
	createMockTask({
		id,
		status: "completed",
		project_dir: dir,
		project_name: name,
	});

describe("Agent Status — stable TreeItem.id identity", () => {
	let h: ProviderHarness;
	let provider: AgentStatusTreeProvider;

	beforeEach(() => {
		h = createProviderHarness();
		provider = h.provider;
		// Keep all probes hermetic and silent for render-only assertions while
		// preserving the empty-audit JSON the health path expects.
		h.execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[] | undefined];
			if (cmd === "openclaw" && args?.[0] === "tasks" && args[1] === "audit") {
				return JSON.stringify({
					summary: {
						total: 0,
						warnings: 0,
						errors: 0,
						byCode: {
							stale_queued: 0,
							stale_running: 0,
							lost: 0,
							delivery_failed: 0,
							missing_cleanup: 0,
							inconsistent_timestamps: 0,
						},
					},
					findings: [],
				});
			}
			return "";
		});
	});

	afterEach(() => {
		disposeHarness(h);
	});

	const idOf = (node: AgentNode): string | undefined =>
		provider.getTreeItem(node).id;

	// ── projectGroup: the node that previously had NO id ────────────────────

	test("projectGroup carries a stable id derived from project dir, NOT label/count", () => {
		const two = projectGroupNode(PROJ_A_DIR, "Proj A", [
			completedTask("a-1", PROJ_A_DIR, "Proj A"),
			completedTask("a-2", PROJ_A_DIR, "Proj A"),
		]);
		const itemTwo = provider.getTreeItem(two);

		// Would FAIL before the fix: project group items had `id === undefined`.
		expect(itemTwo.id).toBe(`project:${PROJ_A_DIR}`);
		// The header label embeds a live "(N)" count; the id must not.
		expect(String(itemTwo.label)).toContain("(2)");
		expect(itemTwo.id).not.toContain("(");
		expect(itemTwo.id).not.toContain("2");
	});

	test("projectGroup id is invariant across count/label changes (refresh stability)", () => {
		const small = projectGroupNode(PROJ_A_DIR, "Proj A", [
			completedTask("a-1", PROJ_A_DIR, "Proj A"),
			completedTask("a-2", PROJ_A_DIR, "Proj A"),
		]);
		const large = projectGroupNode(PROJ_A_DIR, "Proj A", [
			completedTask("a-1", PROJ_A_DIR, "Proj A"),
			completedTask("a-2", PROJ_A_DIR, "Proj A"),
			completedTask("a-3", PROJ_A_DIR, "Proj A"),
			completedTask("a-4", PROJ_A_DIR, "Proj A"),
			completedTask("a-5", PROJ_A_DIR, "Proj A"),
		]);

		// Labels differ ((2) vs (5)) but identity is anchored to the project.
		expect(String(provider.getTreeItem(small).label)).not.toBe(
			String(provider.getTreeItem(large).label),
		);
		expect(provider.getTreeItem(small).id).toBe(provider.getTreeItem(large).id);
		expect(provider.getTreeItem(small).id).toBe(`project:${PROJ_A_DIR}`);
	});

	test("projectGroup id is independent of sort position", () => {
		// getTreeItem is pure on the node, so the id never encodes index/order:
		// the same two project nodes yield the same ids regardless of which one
		// the activity sort places first.
		const a = projectGroupNode(PROJ_A_DIR, "Proj A", [
			completedTask("a-1", PROJ_A_DIR, "Proj A"),
		]);
		const b = projectGroupNode(PROJ_B_DIR, "Proj B", [
			completedTask("b-1", PROJ_B_DIR, "Proj B"),
		]);
		expect(idOf(a)).toBe(`project:${PROJ_A_DIR}`);
		expect(idOf(b)).toBe(`project:${PROJ_B_DIR}`);
		expect(idOf(a)).not.toBe(idOf(b));
	});

	test("unregistered projectGroup gets a sentinel id that cannot collide with a same-named project", () => {
		const unregistered = projectGroupNode(
			undefined,
			"Unregistered projects",
			[],
			{
				unregistered: true,
			},
		);
		// A (contrived) real project literally named "Unregistered projects".
		const named = projectGroupNode(undefined, "Unregistered projects", [
			completedTask("u-1", "", "Unregistered projects"),
		]);

		expect(idOf(unregistered)).toBe("project:__unregistered__");
		expect(idOf(named)).toBe("project:Unregistered projects");
		expect(idOf(unregistered)).not.toBe(idOf(named));
	});

	// ── History / status-group: the orphaned descendant in the live logs ────

	test("History (status-group done) id is project-qualified and count-invariant", () => {
		const two: StatusGroupNode = {
			type: "statusGroup",
			status: "done",
			nodes: [
				{ type: "task", task: completedTask("h-1", PROJ_A_DIR, "Proj A") },
				{ type: "task", task: completedTask("h-2", PROJ_A_DIR, "Proj A") },
			],
			parentProjectDir: PROJ_A_DIR,
			parentProjectName: "Proj A",
		};
		const five: StatusGroupNode = {
			...two,
			nodes: [
				...two.nodes,
				{ type: "task", task: completedTask("h-3", PROJ_A_DIR, "Proj A") },
				{ type: "task", task: completedTask("h-4", PROJ_A_DIR, "Proj A") },
				{ type: "task", task: completedTask("h-5", PROJ_A_DIR, "Proj A") },
			],
		};

		const idTwo = provider.getTreeItem(two).id;
		const idFive = provider.getTreeItem(five).id;

		expect(idTwo).toBe(`status-group:done:${PROJ_A_DIR}:`);
		// Count differs (· 2 vs · 5) but the section identity is stable.
		expect(idTwo).toBe(idFive);
		expect(idTwo).not.toContain("·");
	});

	test("the SAME History section under two different projects gets distinct ids (no cross-project collision)", () => {
		const base = (dir: string, name: string): StatusGroupNode => ({
			type: "statusGroup",
			status: "done",
			nodes: [{ type: "task", task: completedTask(`${name}-1`, dir, name) }],
			parentProjectDir: dir,
			parentProjectName: name,
		});
		const idA = provider.getTreeItem(base(PROJ_A_DIR, "Proj A")).id;
		const idB = provider.getTreeItem(base(PROJ_B_DIR, "Proj B")).id;
		expect(idA).not.toBe(idB);
	});

	// ── leaf + folder structural ids ────────────────────────────────────────

	test("task leaf carries a stable task:<id> identity", () => {
		const node: AgentNode = {
			type: "task",
			task: completedTask("leaf-1", PROJ_A_DIR, "Proj A"),
		};
		expect(provider.getTreeItem(node).id).toBe("task:leaf-1");
	});

	test("folderGroup carries a stable folder:<groupKey> identity", () => {
		const node: FolderGroupNode = {
			type: "folderGroup",
			groupKey: "manual:work",
			groupName: "Work",
			projectCount: 2,
			projects: [],
		};
		expect(provider.getTreeItem(node).id).toBe("folder:manual:work");
	});

	// ── deliberate omissions (stable-and-unique beats comprehensive) ─────────

	test("count-bearing / parent-ambiguous rows are intentionally left without a global id", () => {
		const older: OlderRunsNode = {
			type: "olderRuns",
			label: "Show 3 older completed...",
			hiddenNodes: [],
		};
		const state: StateNode = { type: "state", label: "Waiting for agents..." };
		// olderRuns label embeds a count; state labels can repeat under multiple
		// parents — neither has a safe count-free, collision-free global id, so we
		// leave VS Code's derived (parent-relative) handle in place.
		expect(provider.getTreeItem(older).id).toBeUndefined();
		expect(provider.getTreeItem(state).id).toBeUndefined();
	});

	// ── both views (agentStatus + symphony) ─────────────────────────────────

	test("symphony view yields identical stable ids (both failing views are covered)", () => {
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
			symphony.readRegistry = () => createMockRegistry({});

			const project = projectGroupNode(PROJ_A_DIR, "Proj A", [
				completedTask("a-1", PROJ_A_DIR, "Proj A"),
			]);
			const history: StatusGroupNode = {
				type: "statusGroup",
				status: "done",
				nodes: [
					{ type: "task", task: completedTask("a-1", PROJ_A_DIR, "Proj A") },
				],
				parentProjectDir: PROJ_A_DIR,
				parentProjectName: "Proj A",
			};

			expect(symphony.getTreeItem(project).id).toBe(
				provider.getTreeItem(project).id,
			);
			expect(symphony.getTreeItem(history).id).toBe(
				provider.getTreeItem(history).id,
			);
		} finally {
			(symphony as unknown as { _agentRegistry: unknown })._agentRegistry =
				null;
			symphony.dispose();
		}
	});

	// ── full-tree uniqueness guard (no duplicate id → no "already registered") ──

	test("a full grouped render assigns globally-unique ids to every structural node", () => {
		setAgentStatusConfig(h.vscodeMock, { groupByProject: true });

		// Proj A holds >5 lanes so its children sub-group by status (yielding a
		// real History `status-group:done` node); Proj B stays flat. Both shapes
		// must produce collision-free ids.
		const registry: Record<string, AgentTask> = {
			"a-run": createMockTask({
				id: "a-run",
				status: "running",
				project_dir: PROJ_A_DIR,
				project_name: "Proj A",
			}),
		};
		for (let i = 1; i <= 6; i++) {
			registry[`a-done-${i}`] = completedTask(
				`a-done-${i}`,
				PROJ_A_DIR,
				"Proj A",
			);
		}
		registry["b-done-1"] = completedTask("b-done-1", PROJ_B_DIR, "Proj B");
		registry["b-fail-1"] = createMockTask({
			id: "b-fail-1",
			status: "failed",
			exit_code: 1,
			project_dir: PROJ_B_DIR,
			project_name: "Proj B",
		});
		provider.readRegistry = () => createMockRegistry(registry);
		provider.reload();

		const seen = new Map<string, AgentNode>();
		const walk = (element?: AgentNode): void => {
			for (const child of provider.getChildren(element)) {
				const item: vscode.TreeItem = provider.getTreeItem(child);
				if (item.id !== undefined) {
					expect(seen.has(item.id)).toBe(false);
					seen.set(item.id, child);
				}
				walk(child);
			}
		};
		walk(undefined);

		// We actually exercised structural ids (not a no-op walk).
		const ids = [...seen.keys()];
		expect(ids.some((id) => id.startsWith("project:"))).toBe(true);
		expect(ids.some((id) => id.startsWith("status-group:done:"))).toBe(true);
		expect(ids.some((id) => id.startsWith("task:"))).toBe(true);
	});
});
