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
 * CONTRACT (locked here): nodes with a provable stable global identity carry
 * a stable, globally-unique `TreeItem.id` that does NOT depend on tree index,
 * display label, live count, or current sort position. Identical in both the
 * `agentStatus` and `symphony` views (both render through the same provider
 * class). The same canonical identity function also drives targeted refresh
 * coalescing. Ambiguous parent-relative rows (`state`) are deliberately left
 * without an id rather than given a colliding/volatile one.
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

	// ── canonical identity edge cases ─────────────────────────────────────

	test("olderRuns id is anchored to its parent (status + project) scope, NOT the count-bearing label or the hidden-node set", () => {
		const makeOlder = (
			label: string,
			hidden: AgentTask[],
			parentStatus?: "done" | "limbo",
		): OlderRunsNode => ({
			type: "olderRuns",
			label,
			parentProjectDir: PROJ_A_DIR,
			parentStatus,
			hiddenNodes: hidden.map((task) => ({ type: "task" as const, task })),
		});

		const twoMembers = makeOlder(
			"Show 2 older completed...",
			[
				completedTask("older-1", PROJ_A_DIR, "Proj A"),
				completedTask("older-2", PROJ_A_DIR, "Proj A"),
			],
			"done",
		);
		// Same parent scope, but a different label AND a wholly churned hidden-node
		// set — exactly what a refresh produces as completed lanes age in and out.
		// The bucket's identity must not move.
		const churned = makeOlder(
			"Show 99 older completed...",
			[
				completedTask("older-3", PROJ_A_DIR, "Proj A"),
				completedTask("older-4", PROJ_A_DIR, "Proj A"),
				completedTask("older-5", PROJ_A_DIR, "Proj A"),
			],
			"done",
		);

		const idTwo = idOf(twoMembers);
		expect(idOf(churned)).toBe(idTwo);
		expect(idTwo).toBe(`olderRuns:done:${PROJ_A_DIR}:`);
		// Encodes neither the live count nor any hidden member identity.
		expect(idTwo).not.toContain("99");
		expect(idTwo).not.toContain("task:");
		expect(idTwo).not.toContain("older-");
	});

	test("sibling olderRuns buckets under the same project but different status get distinct ids (no collision)", () => {
		// The previous design keyed olderRuns off the project scope PLUS a hash of
		// the hidden set. Drop the (volatile) hash and the two sibling buckets a
		// >5-lane project can emit — e.g. `done` and `limbo` — collapse to one
		// `olderRuns:<project>` id: a hard "already registered" tree crash. Status
		// in the canonical key is what keeps them apart without hashing contents.
		const bucket = (parentStatus: "done" | "limbo"): OlderRunsNode => ({
			type: "olderRuns",
			label: "Show 3 older completed...",
			parentProjectDir: PROJ_A_DIR,
			parentProjectName: "Proj A",
			parentStatus,
			hiddenNodes: [
				{
					type: "task",
					task: completedTask(`${parentStatus}-1`, PROJ_A_DIR, "Proj A"),
				},
			],
		});
		expect(idOf(bucket("done"))).toBe(`olderRuns:done:${PROJ_A_DIR}:`);
		expect(idOf(bucket("limbo"))).toBe(`olderRuns:limbo:${PROJ_A_DIR}:`);
		expect(idOf(bucket("done"))).not.toBe(idOf(bucket("limbo")));
	});

	test("the same olderRuns bucket under two different projects gets distinct ids", () => {
		const bucket = (dir: string, name: string): OlderRunsNode => ({
			type: "olderRuns",
			label: "Show 1 older completed...",
			parentProjectDir: dir,
			parentProjectName: name,
			parentStatus: "done",
			hiddenNodes: [
				{ type: "task", task: completedTask(`${name}-1`, dir, name) },
			],
		});
		expect(idOf(bucket(PROJ_A_DIR, "Proj A"))).not.toBe(
			idOf(bucket(PROJ_B_DIR, "Proj B")),
		);
	});

	test("parent-ambiguous state rows are intentionally left without a global id", () => {
		const state: StateNode = { type: "state", label: "Waiting for agents..." };
		// State labels can repeat under multiple parents, so the canonical
		// identity function intentionally leaves VS Code's derived
		// parent-relative handle in place.
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

	// ── symphony root containers (always-on symphony view) ──────────────────

	test("symphony root containers carry content-free, collision-free, render-stable ids", () => {
		const stableId = (
			provider as unknown as {
				getStableTreeItemId(n: AgentNode): string | undefined;
			}
		).getStableTreeItemId.bind(provider);

		const dashboard: AgentNode = {
			type: "symphonyDashboard",
			runs: [],
			flows: [],
		};
		const running: AgentNode = {
			type: "symphonyRunGroup",
			kind: "running",
			runs: [],
		};
		const retryQueued: AgentNode = {
			type: "symphonyRunGroup",
			kind: "retryQueued",
			runs: [],
		};
		const released: AgentNode = {
			type: "symphonyRunGroup",
			kind: "released",
			runs: [],
		};
		const taskflows: AgentNode = { type: "taskflows", flows: [] };
		const codexRuns: AgentNode = { type: "codexRuns", runs: [] };

		const ids = [
			stableId(dashboard),
			stableId(running),
			stableId(retryQueued),
			stableId(released),
			stableId(taskflows),
			stableId(codexRuns),
		];

		// Every container is identified, and all are globally unique — the
		// conditional `released` group must never collide with its siblings
		// (a duplicate id is a hard "already registered" tree crash).
		expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(
			true,
		);
		expect(new Set(ids).size).toBe(ids.length);

		// Run groups are distinguished by `kind`, not by membership or label.
		expect(stableId(running)).not.toBe(stableId(retryQueued));

		// Content-free: the id must not move with the count-bearing runs/flows
		// payload (the exact failure that re-keyed these nodes on every refresh).
		expect(
			stableId({ type: "codexRuns", runs: [{}, {}] } as unknown as AgentNode),
		).toBe(stableId(codexRuns));
		expect(
			stableId({ type: "taskflows", flows: [{}] } as unknown as AgentNode),
		).toBe(stableId(taskflows));
		expect(
			stableId({
				type: "symphonyRunGroup",
				kind: "running",
				runs: [{}],
			} as unknown as AgentNode),
		).toBe(stableId(running));

		// The provider wires the canonical id onto the rendered TreeItem.
		expect(provider.getTreeItem(codexRuns).id).toBe("symphony:codex-runs");
		expect(provider.getTreeItem(dashboard).id).toBe("symphony:dashboard");
	});

	test("codexRun keeps an undefined id (renders under two parents — a per-run id would collide)", () => {
		const stableId = (
			provider as unknown as {
				getStableTreeItemId(n: AgentNode): string | undefined;
			}
		).getStableTreeItemId.bind(provider);
		// The same run is a child of BOTH its symphonyRunGroup and the codexRuns
		// container, so a `codexRun:<id>` would be registered twice. Leaving it
		// undefined (VS Code parent-relative handle) is the correct, crash-free
		// choice and must not regress into a "stable" per-run id.
		const codexRun = {
			type: "codexRun",
			run: { id: "run-1" },
		} as unknown as AgentNode;
		expect(stableId(codexRun)).toBeUndefined();
	});

	test("getParent resolves statusGroup by canonical stable id, not status alone", () => {
		setAgentStatusConfig(h.vscodeMock, { groupByProject: true });

		const registry: Record<string, AgentTask> = {};
		for (let i = 1; i <= 6; i++) {
			registry[`a-done-${i}`] = completedTask(
				`a-done-${i}`,
				PROJ_A_DIR,
				"Proj A",
			);
			registry[`b-done-${i}`] = completedTask(
				`b-done-${i}`,
				PROJ_B_DIR,
				"Proj B",
			);
		}
		provider.readRegistry = () => createMockRegistry(registry);
		provider.reload();

		const roots = provider.getChildren();
		const projB = roots.find(
			(node): node is ProjectGroupNode =>
				node.type === "projectGroup" && node.projectDir === PROJ_B_DIR,
		);
		if (!projB) throw new Error("Expected Proj B root");
		const projBHistory = provider
			.getChildren(projB)
			.find(
				(node): node is StatusGroupNode =>
					node.type === "statusGroup" && node.status === "done",
			);
		if (!projBHistory) throw new Error("Expected Proj B History status group");

		const parent = provider.getParent(projBHistory);
		expect(parent?.type).toBe("projectGroup");
		expect((parent as ProjectGroupNode | undefined)?.projectDir).toBe(
			PROJ_B_DIR,
		);
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

	test("a grouped render with completed overflow emits one stable, content-free olderRuns id", () => {
		setAgentStatusConfig(h.vscodeMock, { groupByProject: true });

		// 12 completed lanes in one project: >5 forces status sub-grouping, and the
		// default completedTaskLimit (10) pushes the oldest 2 into a real
		// `olderRuns` bucket under `status-group:done`. This is the render path the
		// unit tests model directly.
		const registry: Record<string, AgentTask> = {};
		for (let i = 1; i <= 12; i++) {
			registry[`a-done-${i}`] = completedTask(
				`a-done-${i}`,
				PROJ_A_DIR,
				"Proj A",
			);
		}
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

		// Exactly one bucket rendered, scoped to (status, project) — the id carries
		// no hidden member and no count, so it survives the next refresh unchanged.
		const olderRunsIds = [...seen.keys()].filter((id) =>
			id.startsWith("olderRuns:"),
		);
		expect(olderRunsIds).toHaveLength(1);
		expect(olderRunsIds[0]).toStartWith(`olderRuns:done:${PROJ_A_DIR}`);
		expect(olderRunsIds[0]).not.toContain("task:");
		expect(olderRunsIds[0]).not.toContain("a-done-");
	});

	// ── flat root mode: the two summary siblings must not collide ────────────

	test("the two flat-root summary nodes get distinct ids (count vs Sources provenance)", () => {
		// Flat root mode renders BOTH the V2 count summary and the Sources
		// provenance summary as siblings. Before the discriminator both returned
		// the constant "summary" → duplicate root id → VS Code "Element with id
		// summary is already registered" hard render failure.
		const countSummary: AgentNode = { type: "summary", label: "1 running" };
		const sourcesSummary: AgentNode = {
			type: "summary",
			kind: "sources",
			label: "Sources",
		};
		expect(idOf(countSummary)).toBe("summary");
		expect(idOf(sourcesSummary)).toBe("summary:sources");
		expect(idOf(countSummary)).not.toBe(idOf(sourcesSummary));
	});

	test("a full FLAT render assigns globally-unique ids (root summaries do not collide)", () => {
		setAgentStatusConfig(h.vscodeMock, { groupByProject: false });

		// One running + one done lane: flat root = [count summary, Sources
		// provenance summary, task:t-run, task:t-done]. Runtime proof of the
		// regression was the duplicate-id list ["summary","summary",...].
		const registry: Record<string, AgentTask> = {
			"t-run": createMockTask({
				id: "t-run",
				status: "running",
				project_dir: PROJ_A_DIR,
				project_name: "Proj A",
			}),
			"t-done": completedTask("t-done", PROJ_A_DIR, "Proj A"),
		};
		provider.readRegistry = () => createMockRegistry(registry);
		provider.reload();

		const seen = new Map<string, AgentNode>();
		const walk = (element?: AgentNode): void => {
			for (const child of provider.getChildren(element)) {
				const item: vscode.TreeItem = provider.getTreeItem(child);
				if (item.id !== undefined) {
					// Would FAIL before the fix: both summaries returned "summary".
					expect(seen.has(item.id)).toBe(false);
					seen.set(item.id, child);
				}
				walk(child);
			}
		};
		walk(undefined);

		// Both root summaries rendered AND received distinct ids.
		const ids = [...seen.keys()];
		expect(ids).toContain("summary");
		expect(ids).toContain("summary:sources");
	});
});
