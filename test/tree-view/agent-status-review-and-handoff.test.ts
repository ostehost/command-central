/**
 * Joint regression: review_status × missing-handoff routing precedence.
 *
 * Proves the priority order in `AgentStatusTreeProvider.getNodeStatusGroup`
 * for the "completed" arm, specifically where a review_status signal and a
 * missing declared handoff_file signal are BOTH present on the same task:
 *
 *   completed + review_status pending         + missing handoff → attention
 *   completed + review_status changes_requested + missing handoff → attention
 *   completed + review_status approved        + missing handoff → limbo
 *
 * The first two cases prove review_status wins over handoff. The third case
 * proves handoff still acts as a fallback when review_status is clean —
 * handoff precedence is the reviewer's WARN-4.2 scenario (REVIEW memo §4.1).
 *
 * Also asserts `countAgentStatuses` routes case 1 to the `attention` badge
 * bucket so the badge-count path stays in sync with the tree provider for the
 * review-wins case.
 *
 * Setup mirrors `test/tree-view/agent-status-handoff-file.test.ts`.
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

// ── Mock child_process (same pattern as handoff-file test) ───────────────────
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

// ── Mock port-detector to avoid real lsof calls ──────────────────────────────
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
import { countAgentStatuses } from "../../src/utils/agent-counts.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// Save the real method to globalThis BEFORE clobbering so extracted readRegistry
// tests can recover it. See agent-status-tree-provider-read-registry.test.ts.
(globalThis as Record<string, unknown>)["__realAgentStatusReadRegistry"] ??=
	AgentStatusTreeProvider.prototype.readRegistry;
AgentStatusTreeProvider.prototype.readRegistry = () => makeRegistry({});

function makeRegistry(tasks: Record<string, AgentTask> = {}): TaskRegistry {
	return { version: 2, tasks };
}

// ── Tmp dir bookkeeping ──────────────────────────────────────────────────────
const tmpDirs: string[] = [];
function makeTmp(): string {
	const dir = realFs.mkdtempSync(path.join(os.tmpdir(), "review-handoff-"));
	tmpDirs.push(dir);
	return dir;
}

/**
 * Minimal task factory. Mirrors `agent-status-handoff-file.test.ts`: tmux
 * backend, no start_commit/start_sha so the completed_dirty fallback does not
 * fire on clean `completed` tasks.
 */
function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "review-handoff-task",
		status: "completed",
		project_dir: "/tmp/project",
		project_name: "project",
		session_id: "agent-review-handoff",
		tmux_session: "agent-review-handoff",
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

// ── Suite ────────────────────────────────────────────────────────────────────

describe("review_status × missing-handoff routing precedence", () => {
	let provider: AgentStatusTreeProvider;

	beforeEach(() => {
		mock.module("node:fs", () => ({
			...realFs,
			statSync: statSyncMock,
		}));
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFileSync: execFileSyncMock,
		}));
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

	// ── Case 1: review pending + missing handoff → attention ───────────────────
	// Review wins. Also assert that the badge-count path (countAgentStatuses)
	// routes the same task to `attention`, so the tree provider and the badge
	// agree on this scenario.
	test("completed + review_status=pending + missing handoff → attention (review wins, badge agrees)", () => {
		const dir = makeTmp();
		const task = makeTask({
			id: "pending-missing",
			status: "completed",
			project_dir: dir,
			handoff_file: "MISSING.md",
			review_status: "pending",
		});

		expect(groupOf(provider, task)).toBe("attention");

		const counts = countAgentStatuses([task]);
		expect(counts.attention).toBe(1);
		expect(counts.limbo).toBe(0);
		expect(counts.done).toBe(0);
	});

	// ── Case 2: review changes_requested + missing handoff → attention ─────────
	test("completed + review_status=changes_requested + missing handoff → attention (review wins)", () => {
		const dir = makeTmp();
		const task = makeTask({
			id: "changes-requested-missing",
			status: "completed",
			project_dir: dir,
			handoff_file: "MISSING.md",
			review_status: "changes_requested",
		});

		expect(groupOf(provider, task)).toBe("attention");
	});

	// ── Case 3: review approved + missing handoff → limbo ──────────────────────
	// With a clean review, the missing-handoff signal takes over and demotes
	// the task to limbo. This is the WARN-4.2 fallback scenario: a task that
	// passed review but never materialized its declared report file must not
	// silently land in `done`.
	test("completed + review_status=approved + missing handoff → limbo (handoff precedence)", () => {
		const dir = makeTmp();
		const task = makeTask({
			id: "approved-missing",
			status: "completed",
			project_dir: dir,
			handoff_file: "MISSING.md",
			review_status: "approved",
		});

		expect(groupOf(provider, task)).toBe("limbo");
	});

	// ── Control: review approved + handoff present → done ─────────────────────
	// Anchor the matrix: with both signals clean, the task lands in `done`.
	// Without this case a regression that routes every approved task to limbo
	// could masquerade as "correct" against case 3.
	test("completed + review_status=approved + handoff present → done", () => {
		const dir = makeTmp();
		realFs.writeFileSync(path.join(dir, "HANDOFF.md"), "# done\n");
		const task = makeTask({
			id: "approved-present",
			status: "completed",
			project_dir: dir,
			handoff_file: "HANDOFF.md",
			review_status: "approved",
		});

		expect(groupOf(provider, task)).toBe("done");
	});
});
