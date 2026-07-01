/**
 * CCSYNC-02 (PAR-227) — Command Central consumes the lane-projection GC receipt.
 *
 * When the launcher's lane-projection GC pass (scripts/oste-lanes-gc.sh)
 * classifies a projection row as no longer live attention work
 * (downgraded/archived/removed), Command Central must route that row to Needs
 * Review (limbo) — reconciliation backlog — so it never counts in the
 * activity-bar action badge or masquerades as a live "running" lane, even when
 * the projection's own status/review fields still say running/pending.
 *
 * These assertions fail on pre-PAR-227 code: without the GC-receipt consumption
 * a downgraded `running` projection row stays in "running" and a downgraded
 * pending-review row that has no live evidence is judged solely by the per-render
 * heuristic, never by the authoritative receipt verdict.
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import type * as _fs from "node:fs";

const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");
const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof _fs;

const statSyncMock = mock((...args: unknown[]) =>
	(realFs.statSync as unknown as (...a: unknown[]) => unknown)(...args),
);
mock.module("node:fs", () => ({
	...realFs,
	statSync: statSyncMock,
}));

const execFileSyncMock = mock((...fnArgs: unknown[]) =>
	realChildProcess.execFileSync(
		fnArgs[0] as string,
		fnArgs[1] as string[] | undefined,
		fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
	),
);
mock.module("node:child_process", () => ({
	...realChildProcess,
	execFileSync: execFileSyncMock,
}));

mock.module("../../src/utils/port-detector.js", () => ({
	detectListeningPorts: mock(() => []),
	detectListeningPortsAsync: mock(async () => []),
}));

import {
	__setCurrentMachineHostOverrideForTests,
	type AgentStatusGroup,
	AgentStatusTreeProvider,
	type AgentTask,
	type TaskRegistry,
} from "../../src/providers/agent-status-tree-provider.js";
import type { ReviewTracker } from "../../src/services/review-tracker.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

(globalThis as Record<string, unknown>)["__realAgentStatusReadRegistry"] ??=
	AgentStatusTreeProvider.prototype.readRegistry;
AgentStatusTreeProvider.prototype.readRegistry = () => makeRegistry({});

function makeRegistry(tasks: Record<string, AgentTask> = {}): TaskRegistry {
	return { version: 2, tasks };
}

function makeProjectionTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "lane-gc-task",
		status: "completed",
		project_dir: "/tmp/project",
		project_name: "project",
		session_id: "agent-lane-gc",
		tmux_session: "agent-lane-gc",
		bundle_path: "",
		prompt_file: "",
		started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
		attempts: 1,
		max_attempts: 3,
		terminal_backend: "tmux",
		handoff_file: null,
		pending_review_path: null,
		lane_projection: true,
		provenance: { source_ref: "launcher:lane-gc-task" },
		...overrides,
	};
}

class InMemoryReviewTracker {
	private reviewed = new Set<string>();
	markReviewed(id: string): void {
		this.reviewed.add(id);
	}
	isReviewed(id: string): boolean {
		return this.reviewed.has(id);
	}
	getReviewedIds(): Set<string> {
		return new Set(this.reviewed);
	}
	save(): void {}
}

function groupOf(
	provider: AgentStatusTreeProvider,
	task: AgentTask,
): AgentStatusGroup {
	const fn = (
		provider as unknown as {
			getNodeStatusGroup: (node: {
				type: "task";
				task: AgentTask;
			}) => AgentStatusGroup;
		}
	).getNodeStatusGroup.bind(provider);
	return fn({ type: "task", task });
}

describe("lane-projection GC receipt consumption", () => {
	let provider: AgentStatusTreeProvider;

	beforeEach(() => {
		statSyncMock.mockReset();
		statSyncMock.mockImplementation((...args: unknown[]) =>
			(realFs.statSync as unknown as (...a: unknown[]) => unknown)(...args),
		);
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[] | undefined];
			if (cmd === "tmux" && args?.includes("has-session")) return "";
			if (cmd === "git") return "";
			return realChildProcess.execFileSync(
				cmd,
				args,
				fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
			);
		});

		const vscodeMock = setupVSCodeMock();
		const getConfigurationMock = mock((_section?: string) => ({
			update: mock(),
			get: mock((_key: string, defaultValue?: unknown) => {
				if (_key === "agentStatus.groupByProject") return false;
				if (_key === "discovery.enabled") return false;
				return defaultValue;
			}),
			inspect: mock((_key: string) => undefined),
			has: mock((_key: string) => true),
		}));
		vscodeMock.workspace.getConfiguration =
			getConfigurationMock as unknown as typeof vscodeMock.workspace.getConfiguration;
		const runtimeVscode = require("vscode") as typeof import("vscode");
		runtimeVscode.workspace.getConfiguration =
			getConfigurationMock as unknown as typeof runtimeVscode.workspace.getConfiguration;

		provider = new AgentStatusTreeProvider({
			getIconForProject: mock(() => "P"),
			setCustomIcon: mock(() => Promise.resolve()),
		} as unknown as ConstructorParameters<typeof AgentStatusTreeProvider>[0]);
		provider.setReviewTracker(
			new InMemoryReviewTracker() as unknown as ReviewTracker,
		);
		provider.readRegistry = () => makeRegistry({});
	});

	afterEach(() => {
		__setCurrentMachineHostOverrideForTests(null);
		const p = provider as unknown as { _agentRegistry: unknown };
		if (
			p._agentRegistry &&
			typeof (p._agentRegistry as { dispose?: unknown }).dispose !== "function"
		) {
			p._agentRegistry = null;
		}
		provider.dispose();
	});

	afterAll(() => {
		__setCurrentMachineHostOverrideForTests(null);
	});

	// A GC-downgraded row that still PROJECTS pending review must land in Needs
	// Review (limbo), not the attention/action badge.
	test("a GC-downgraded pending-review projection row routes to limbo, not attention", () => {
		const task = makeProjectionTask({
			id: "gc-downgraded",
			status: "completed",
			review_status: "pending",
			gc_reconcile: "downgraded",
			gc_reconcile_reason: "review-pending-receipt-missing",
		});
		expect(groupOf(provider, task)).toBe("limbo");
	});

	// A GC-removed/archived row whose projected status still says "running" must
	// NOT masquerade as a live running lane — the GC pass said it has no backing
	// evidence, so it is reconciliation backlog.
	test("a GC-removed projection row with status=running routes to limbo, not running", () => {
		const task = makeProjectionTask({
			id: "gc-removed-running",
			status: "running",
			gc_reconcile: "removed",
			gc_reconcile_reason: "running-no-evidence",
		});
		expect(groupOf(provider, task)).toBe("limbo");
	});

	test("a GC-archived projection row routes to limbo", () => {
		const task = makeProjectionTask({
			id: "gc-archived",
			status: "completed",
			review_state: "reviewed",
			gc_reconcile: "archived",
		});
		expect(groupOf(provider, task)).toBe("limbo");
	});

	// Without the GC marker the same row keeps its ordinary classification — the
	// receipt only ever downgrades a row, it never invents one.
	test("an unreconciled running projection row stays running", () => {
		const task = makeProjectionTask({
			id: "gc-kept-running",
			status: "running",
		});
		expect(groupOf(provider, task)).toBe("running");
	});

	// AC4 (PAR-227): "let Command Central surface that receipt for audit." Routing
	// a reconciled row to limbo is not enough — the operator must be able to SEE
	// the GC verdict + reason on the row itself, not have it silently vanish from
	// the attention badge. The row description carries an at-a-glance badge and the
	// tooltip carries the full verdict + reason.
	describe("audit surface", () => {
		function itemOf(task: AgentTask): {
			description: string;
			tooltip: string;
		} {
			const item = provider.getTreeItem({ type: "task", task });
			return {
				description: String(item.description ?? ""),
				tooltip: (item.tooltip as { value: string } | undefined)?.value ?? "",
			};
		}

		test("a downgraded row surfaces reconcile-needed + reason for audit", () => {
			const task = makeProjectionTask({
				id: "gc-downgraded-surface",
				status: "completed",
				review_status: "pending",
				gc_reconcile: "downgraded",
				gc_reconcile_reason: "review-pending-receipt-missing",
			});
			const { description, tooltip } = itemOf(task);
			expect(description).toContain("reconcile-needed");
			expect(tooltip).toContain("Lane GC");
			expect(tooltip).toContain("reconcile-needed");
			expect(tooltip).toContain("review-pending-receipt-missing");
		});

		test("an archived/removed row surfaces its GC verdict for audit", () => {
			const archived = itemOf(
				makeProjectionTask({
					id: "gc-archived-surface",
					status: "completed",
					review_state: "reviewed",
					gc_reconcile: "archived",
				}),
			);
			expect(archived.description).toContain("archived (GC)");
			expect(archived.tooltip).toContain("archived (GC)");

			const removed = itemOf(
				makeProjectionTask({
					id: "gc-removed-surface",
					status: "running",
					gc_reconcile: "removed",
					gc_reconcile_reason: "running-no-evidence",
				}),
			);
			expect(removed.description).toContain("removed (GC)");
			expect(removed.tooltip).toContain("running-no-evidence");
		});

		test("an unreconciled row shows no GC audit surface", () => {
			const { description, tooltip } = itemOf(
				makeProjectionTask({ id: "gc-none-surface", status: "running" }),
			);
			expect(description).not.toContain("reconcile-needed");
			expect(description).not.toContain("(GC)");
			expect(tooltip).not.toContain("Lane GC");
		});
	});
});
