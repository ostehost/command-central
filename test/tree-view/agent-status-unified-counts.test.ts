/**
 * getUnifiedAgentCounts — the tree-engine counts the status bar consumes.
 *
 * Regression for the "3 attention · 278 done" status bar sitting beside a tree
 * showing 13 Action Required lanes: the bar used to recount raw `task.status`
 * via `countAgentStatuses`, which cannot see signal-based classification
 * (lifecycle conflicts, GC reconciliation, receipt state). The provider now
 * exposes counts classified through `getNodeStatusGroup` — the same engine the
 * rendered groups use — and the bar must consume those.
 *
 * The GC-reconciled fixture is the cheapest deterministic divergence: a raw
 * `failed` status that the tree files under Needs Review (limbo) because an
 * authoritative lane-projection GC pass reconciled the row out.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");
const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof import("node:fs");

mock.module("node:fs", () => realFs);

const execFileSyncMock = mock((...fnArgs: unknown[]) => {
	const [cmd, args] = fnArgs as [string, string[] | undefined];
	if (cmd === "tmux") return "";
	if (cmd === "openclaw") return JSON.stringify({});
	return realChildProcess.execFileSync(
		cmd,
		args,
		fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
	);
});
mock.module("node:child_process", () => ({
	...realChildProcess,
	execFileSync: execFileSyncMock,
}));

mock.module("../../src/utils/port-detector.js", () => ({
	detectListeningPorts: mock(() => []),
	detectListeningPortsAsync: mock(async () => []),
}));

import {
	AgentStatusTreeProvider,
	type AgentTask,
	type TaskRegistry,
} from "../../src/providers/agent-status-tree-provider.js";
import type { ReviewTracker } from "../../src/services/review-tracker.js";
import { countAgentStatuses } from "../../src/utils/agent-counts.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

(globalThis as Record<string, unknown>)["__realAgentStatusReadRegistry"] ??=
	AgentStatusTreeProvider.prototype.readRegistry;
AgentStatusTreeProvider.prototype.readRegistry = () => makeRegistry({});

function makeRegistry(tasks: Record<string, AgentTask> = {}): TaskRegistry {
	return { version: 2, tasks };
}

class InMemoryReviewTracker {
	private reviewed = new Set<string>();
	markReviewed(id: string) {
		this.reviewed.add(id);
	}
	isReviewed(id: string) {
		return this.reviewed.has(id);
	}
	getReviewedIds() {
		return new Set(this.reviewed);
	}
	save() {}
}

function makeLane(
	overrides: Partial<AgentTask> & { id: string; status: AgentTask["status"] },
): AgentTask {
	return {
		project_dir: "/tmp/unified-counts-fixture",
		project_name: "unified-counts-fixture",
		session_id: `sess-${overrides.id}`,
		bundle_path: "(test-mode)",
		prompt_file: "",
		started_at: new Date(Date.now() - 60_000).toISOString(),
		completed_at: null,
		attempts: 1,
		max_attempts: 3,
		stream_file: null,
		handoff_file: null,
		model: null,
		role: "developer",
		...overrides,
	} as AgentTask;
}

function freshProvider(): AgentStatusTreeProvider {
	const vscodeMock = setupVSCodeMock();
	const getConfigurationMock = mock((_section?: string) => ({
		update: mock(),
		get: mock((_key: string, defaultValue?: unknown) => {
			if (_key === "agentStatus.groupByProject") return false;
			if (_key === "discovery.enabled") return false;
			if (_key === "laneRegistry.files") return [];
			return defaultValue;
		}),
		inspect: mock((_key: string) => undefined),
		has: mock((_key: string) => true),
	}));
	vscodeMock.workspace.getConfiguration =
		getConfigurationMock as unknown as typeof vscodeMock.workspace.getConfiguration;
	(require("vscode") as typeof import("vscode")).workspace.getConfiguration =
		getConfigurationMock as unknown as typeof import("vscode").workspace.getConfiguration;

	const p = new AgentStatusTreeProvider({
		getIconForProject: mock(() => "🎛️"),
		setCustomIcon: mock(() => Promise.resolve()),
	} as unknown as ConstructorParameters<typeof AgentStatusTreeProvider>[0]);
	p.setReviewTracker(new InMemoryReviewTracker() as unknown as ReviewTracker);
	p.readRegistry = () => makeRegistry({});
	p.getDiffSummary = () => null;
	p.reload();
	return p;
}

beforeEach(() => {
	mock.module("node:fs", () => realFs);
	mock.module("node:child_process", () => ({
		...realChildProcess,
		execFileSync: execFileSyncMock,
	}));
	mock.module("../../src/utils/port-detector.js", () => ({
		detectListeningPorts: mock(() => []),
		detectListeningPortsAsync: mock(async () => []),
	}));
});

describe("getUnifiedAgentCounts — tree-engine truth for the status bar", () => {
	test("classifies through getNodeStatusGroup, not raw task status", () => {
		const provider = freshProvider();
		const running = makeLane({ id: "uc-running", status: "running" });
		const failed = makeLane({
			id: "uc-failed",
			status: "failed",
			completed_at: new Date(Date.now() - 30_000).toISOString(),
		});
		const gcReconciled = makeLane({
			id: "uc-gc-reconciled",
			status: "failed",
			completed_at: new Date(Date.now() - 30_000).toISOString(),
			gc_reconcile: "archived",
			gc_reconcile_reason: "lane-projection GC archived this row",
		});
		provider.readRegistry = () =>
			makeRegistry({
				[running.id]: running,
				[failed.id]: failed,
				[gcReconciled.id]: gcReconciled,
			});
		provider.reload();

		const unified = provider.getUnifiedAgentCounts();
		expect(unified.total).toBe(3);
		expect(unified.working).toBe(1);
		// Plain failed lane: genuine attention in both engines.
		expect(unified.attention).toBe(1);
		// GC-reconciled lane: the tree files it under Needs Review (limbo) —
		// reconciliation backlog, never badge-counted attention.
		expect(unified.limbo).toBe(1);

		// Pin the divergence this method exists to close: the raw-status engine
		// cannot see the GC receipt and calls BOTH failed lanes attention. If
		// these ever agree on this fixture, the naive path gained signal
		// awareness and this contract should be revisited.
		const naive = countAgentStatuses([running, failed, gcReconciled]);
		expect(naive.attention).toBe(2);
		expect(unified.attention).toBeLessThan(naive.attention);
	});

	test("agrees with the rendered group buckets for the same lanes", () => {
		const provider = freshProvider();
		const lanes = [
			makeLane({ id: "uc-a", status: "running" }),
			makeLane({
				id: "uc-b",
				status: "failed",
				completed_at: new Date().toISOString(),
			}),
			makeLane({
				id: "uc-c",
				status: "failed",
				completed_at: new Date().toISOString(),
				gc_reconcile: "removed",
			}),
			makeLane({ id: "uc-d", status: "paused" }),
		];
		provider.readRegistry = () =>
			makeRegistry(Object.fromEntries(lanes.map((lane) => [lane.id, lane])));
		provider.reload();

		const unified = provider.getUnifiedAgentCounts();
		expect(unified).toEqual({
			working: 1,
			attention: 1,
			limbo: 2, // GC-reconciled + paused
			done: 0,
			total: 4,
		});
	});
});
