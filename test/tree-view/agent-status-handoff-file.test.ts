/**
 * Handoff-file routing tests (slice 4)
 *
 * Verifies that `AgentStatusTreeProvider.getNodeStatusGroup` routes tasks
 * correctly based on the declared-handoff truthfulness signal:
 *
 *   clean completed + handoff present  → done
 *   clean completed + handoff missing  → limbo
 *   clean completed + handoff_file null → done (signal absent)
 *   completed_dirty (any handoff state) → limbo  (slice 1/2 no-regression)
 *   running + handoff missing           → running (unaffected)
 *   completed + review_status=pending + missing handoff → attention
 *     (review_status wins over handoff — slice 1 ordering)
 *
 * Plus: the 5s TTL cache on `_handoffFileCache` must collapse two back-to-back
 * lookups for the same (project_dir, handoff_file) pair into a single
 * `fs.statSync` call.
 *
 * Setup mirrors `test/tree-view/agent-status-dead-process-running.test.ts`.
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
import * as realChildProcess from "node:child_process";
import type * as _fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Real node:fs (via preload cache) ─────────────────────────────────────────
// We need real fs for tmp dir creation AND for the provider/helper to stat
// handoff files. A mockable statSync wrapper gives us per-test call counting
// for the cache-behavior assertion.
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

// ── Mock child_process (same pattern as dead-process-running test) ───────────
const execFileSyncMock = mock((...fnArgs: unknown[]) =>
	realChildProcess.execFileSync(
		fnArgs[0] as string,
		fnArgs[1] as string[] | undefined,
		fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
	),
);
let openclawAuditJson = JSON.stringify({
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
mock.module("node:child_process", () => ({
	...realChildProcess,
	execFileSync: execFileSyncMock,
}));

// ── Mock port-detector to avoid real lsof calls ─────────────────────────────
mock.module("../../src/utils/port-detector.js", () => ({
	detectListeningPorts: mock(() => []),
	detectListeningPortsAsync: mock(async () => []),
}));

// ── Imports after mock module setup ──────────────────────────────────────────
import {
	type AgentStatusGroup,
	AgentStatusTreeProvider,
	type AgentTask,
	type TaskRegistry,
} from "../../src/providers/agent-status-tree-provider.js";
import type { ReviewTracker } from "../../src/services/review-tracker.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// Prevent the provider constructor from reading real tasks.json on disk.
AgentStatusTreeProvider.prototype.readRegistry = () => makeRegistry({});

function makeRegistry(tasks: Record<string, AgentTask> = {}): TaskRegistry {
	return { version: 2, tasks };
}

// ── Tmp dir bookkeeping ──────────────────────────────────────────────────────
const tmpDirs: string[] = [];
function makeTmp(): string {
	const dir = realFs.mkdtempSync(path.join(os.tmpdir(), "handoff-route-"));
	tmpDirs.push(dir);
	return dir;
}

/**
 * Minimal task factory. Defaults terminal backend to tmux but leaves
 * start_commit/start_sha unset so the completed_dirty fallback does not fire
 * on clean `completed` tasks (matching the dead-process-running test pattern).
 */
function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "handoff-test-task",
		status: "completed",
		project_dir: "/tmp/project",
		project_name: "project",
		session_id: "agent-handoff",
		tmux_session: "agent-handoff",
		bundle_path: "",
		prompt_file: "",
		started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
		attempts: 1,
		max_attempts: 3,
		terminal_backend: "tmux",
		handoff_file: null,
		...overrides,
	};
}

/** Lightweight in-memory ReviewTracker — avoids filesystem I/O in tests. */
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

/** Call the private getNodeStatusGroup routing method directly on a task. */
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

/** Clear the provider's handoff-file TTL cache between assertions. */
function clearHandoffCache(provider: AgentStatusTreeProvider): void {
	(
		provider as unknown as {
			_handoffFileCache: Map<string, unknown>;
		}
	)._handoffFileCache.clear();
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("handoff-file routing (slice 4)", () => {
	let provider: AgentStatusTreeProvider;

	beforeEach(() => {
		// Re-register fs + child_process mocks (global afterEach → mock.restore()).
		mock.module("node:fs", () => ({
			...realFs,
			statSync: statSyncMock,
		}));
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFileSync: execFileSyncMock,
		}));
		// Reset statSync to real pass-through and clear call history.
		statSyncMock.mockReset();
		statSyncMock.mockImplementation((...args: unknown[]) =>
			(realFs.statSync as unknown as (...a: unknown[]) => unknown)(...args),
		);

		openclawAuditJson = JSON.stringify({
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
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[] | undefined];
			if (cmd === "tmux" && args?.includes("has-session")) return "";
			if (
				cmd === "openclaw" &&
				args?.[0] === "tasks" &&
				args[1] === "audit" &&
				args[2] === "--json"
			) {
				return openclawAuditJson;
			}
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
		vscodeMock.window.showInformationMessage = mock(() =>
			Promise.resolve(undefined),
		);
		vscodeMock.window.showWarningMessage = mock(() =>
			Promise.resolve(undefined),
		);

		provider = new AgentStatusTreeProvider({
			getIconForProject: mock(() => "🧩"),
			setCustomIcon: mock(() => Promise.resolve()),
		} as unknown as ConstructorParameters<typeof AgentStatusTreeProvider>[0]);
		provider.setReviewTracker(
			new InMemoryReviewTracker() as unknown as ReviewTracker,
		);
		provider.readRegistry = () => makeRegistry({});
	});

	afterEach(() => {
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
		for (const dir of tmpDirs) {
			try {
				realFs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
	});

	// ── 1. clean completed + handoff present → done ───────────────────────────
	test("clean completed + declared handoff present on disk → done", () => {
		const dir = makeTmp();
		realFs.writeFileSync(path.join(dir, "HANDOFF.md"), "# report\n");
		const task = makeTask({
			id: "clean-present",
			status: "completed",
			project_dir: dir,
			handoff_file: "HANDOFF.md",
		});
		expect(groupOf(provider, task)).toBe("done");
	});

	// ── 2. clean completed + handoff missing → limbo ─────────────────────────
	test("clean completed + declared handoff MISSING on disk → limbo", () => {
		const dir = makeTmp();
		// File deliberately not created.
		const task = makeTask({
			id: "clean-missing",
			status: "completed",
			project_dir: dir,
			handoff_file: "MISSING.md",
		});
		expect(groupOf(provider, task)).toBe("limbo");
	});

	// ── 3. clean completed + no declared handoff → done (signal absent) ──────
	test("clean completed + handoff_file=null → done (unaffected)", () => {
		const dir = makeTmp();
		const task = makeTask({
			id: "clean-null-handoff",
			status: "completed",
			project_dir: dir,
			handoff_file: null,
		});
		expect(groupOf(provider, task)).toBe("done");
	});

	// ── 4. completed_dirty stays in limbo regardless of handoff ──────────────
	// SLICE 1 / SLICE 2 NO-REGRESSION GUARD.
	// `completed_dirty` routes to limbo via the dedicated branch in
	// getNodeStatusGroup; the handoff check must not override or short-circuit
	// it in either direction. Present handoff must not promote it to done;
	// missing handoff must not do anything beyond "limbo" either.
	test("completed_dirty stays in limbo regardless of handoff present/missing", () => {
		const dirWithHandoff = makeTmp();
		realFs.writeFileSync(path.join(dirWithHandoff, "HANDOFF.md"), "present");

		const dirtyWithPresent = makeTask({
			id: "dirty-with-present",
			status: "completed_dirty",
			project_dir: dirWithHandoff,
			handoff_file: "HANDOFF.md",
		});
		expect(groupOf(provider, dirtyWithPresent)).toBe("limbo");

		const dirWithoutHandoff = makeTmp();
		const dirtyWithMissing = makeTask({
			id: "dirty-with-missing",
			status: "completed_dirty",
			project_dir: dirWithoutHandoff,
			handoff_file: "MISSING.md",
		});
		expect(groupOf(provider, dirtyWithMissing)).toBe("limbo");

		const dirtyNoHandoff = makeTask({
			id: "dirty-no-handoff",
			status: "completed_dirty",
			project_dir: dirWithoutHandoff,
			handoff_file: null,
		});
		expect(groupOf(provider, dirtyNoHandoff)).toBe("limbo");
	});

	// ── 5. running + missing handoff → running (unaffected) ──────────────────
	test("running task with declared handoff missing → stays in running", () => {
		const dir = makeTmp();
		const task = makeTask({
			id: "running-missing-handoff",
			status: "running",
			project_dir: dir,
			handoff_file: "NOT-YET.md",
		});
		expect(groupOf(provider, task)).toBe("running");
	});

	// ── 6. review_status=pending wins over missing handoff → attention ───────
	// SLICE 1 ORDERING GUARD.
	// When a completed task has `review_status="pending"` AND the declared
	// handoff is missing, review_status takes precedence — the task routes
	// to attention, not limbo. This preserves the slice 1 review-status
	// ordering: attention > limbo for the "completed" branch.
	test("completed + review_status=pending + missing handoff → attention (review_status wins)", () => {
		const dir = makeTmp();
		const task = makeTask({
			id: "pending-review-missing-handoff",
			status: "completed",
			project_dir: dir,
			handoff_file: "MISSING.md",
			review_status: "pending",
		});
		expect(groupOf(provider, task)).toBe("attention");
	});

	test("completed + review_status=changes_requested + missing handoff → attention", () => {
		const dir = makeTmp();
		const task = makeTask({
			id: "changes-requested-missing-handoff",
			status: "completed",
			project_dir: dir,
			handoff_file: "MISSING.md",
			review_status: "changes_requested",
		});
		expect(groupOf(provider, task)).toBe("attention");
	});

	// ── 7. cache behavior: two back-to-back lookups → single statSync call ───
	test("two back-to-back lookups for the same task hit the handoff cache", () => {
		const dir = makeTmp();
		realFs.writeFileSync(path.join(dir, "H.md"), "x");
		const task = makeTask({
			id: "cache-test",
			status: "completed",
			project_dir: dir,
			handoff_file: "H.md",
		});

		// Fresh provider, fresh cache. Count statSync invocations for this file.
		clearHandoffCache(provider);
		const before = statSyncMock.mock.calls.length;

		expect(groupOf(provider, task)).toBe("done");
		const afterFirst = statSyncMock.mock.calls.length;
		expect(groupOf(provider, task)).toBe("done");
		const afterSecond = statSyncMock.mock.calls.length;

		// First call → exactly one stat for the handoff file.
		// Second call → cache hit, no additional stat.
		expect(afterFirst - before).toBe(1);
		expect(afterSecond - afterFirst).toBe(0);
	});
});
