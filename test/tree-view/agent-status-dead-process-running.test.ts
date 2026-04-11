/**
 * Dead-process-running detection tests (slice 2)
 *
 * Verifies that when a tmux session is alive but no pane has a live agent
 * process, the task is displayed as `stopped` (not `running`), and the
 * running count is NOT inflated by the ghost lane.
 *
 * Regression guard (see research/DEV-NOTES-cc-agent-status-slice1-v1.md):
 * "Stream file presence is not a reliable liveness signal for team-mode runs."
 * A task with a missing stream file but a live tmux session with a live pane
 * MUST still display as `running`. Tests 3 and 4 guard this explicitly.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";

// ── Keep real node:fs so missing stream files throw naturally ────────────────
// The provider's getStreamTerminalState wraps readFileSync in a try/catch, so
// a nonexistent stream_file path returns null without leaking into test results.
const fs = require("node:fs") as typeof import("node:fs");
mock.module("node:fs", () => fs);

// ── Mock child_process ───────────────────────────────────────────────────────
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

// ── Mock tmux-pane-health — controlled per-test ───────────────────────────────
// Default: alive (fail-open). Per-test: mockImplementation(() => false) for dead.
const mockIsTmuxPaneAgentAlive = mock(() => true);
mock.module("../../src/utils/tmux-pane-health.js", () => ({
	isTmuxPaneAgentAlive: mockIsTmuxPaneAgentAlive,
}));

// ── Mock port-detector to avoid real lsof calls ─────────────────────────────
mock.module("../../src/utils/port-detector.js", () => ({
	detectListeningPorts: mock(() => []),
	detectListeningPortsAsync: mock(async () => []),
}));

// ── Imports after mock module setup ──────────────────────────────────────────
import {
	AgentStatusTreeProvider,
	type AgentTask,
	type TaskRegistry,
} from "../../src/providers/agent-status-tree-provider.js";
import { ReviewTracker } from "../../src/services/review-tracker.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// ── Test infrastructure ───────────────────────────────────────────────────────

// Prevent the provider constructor from reading the real tasks.json on disk.
AgentStatusTreeProvider.prototype.readRegistry = () => makeRegistry({});

function makeRegistry(tasks: Record<string, AgentTask> = {}): TaskRegistry {
	return { version: 2, tasks };
}

/**
 * Minimal task factory. Terminal backend defaults to tmux so the pane-health
 * check is exercised. Do NOT set start_commit by default so the `completed_dirty`
 * fallback path doesn't trigger when testing the dead-process-running case.
 */
function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "dead-test-task",
		status: "running",
		project_dir: "/tmp/project",
		project_name: "project",
		session_id: "agent-my-project",
		tmux_session: "agent-my-project",
		bundle_path: "",
		prompt_file: "",
		started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
		attempts: 1,
		max_attempts: 3,
		terminal_backend: "tmux",
		...overrides,
	};
}

/** Cache key used by both _tmuxSessionHealthCache and _tmuxPaneAgentCache. */
function healthCacheKey(task: Pick<AgentTask, "session_id" | "tmux_socket">): string {
	return `${task.tmux_socket ?? "__default__"}::${task.session_id}`;
}

/** Seed _tmuxSessionHealthCache so the session-level alive check passes. */
function seedSessionAlive(
	provider: AgentStatusTreeProvider,
	task: AgentTask,
): void {
	(
		provider as unknown as {
			_tmuxSessionHealthCache: Map<string, { alive: boolean; checkedAt: number }>;
		}
	)._tmuxSessionHealthCache.set(healthCacheKey(task), {
		alive: true,
		checkedAt: Date.now(),
	});
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

/** Extract the summary node from provider.getChildren() root. */
function getSummaryLabel(provider: AgentStatusTreeProvider): string {
	const summary = provider.getChildren().find((n) => n.type === "summary");
	if (!summary || summary.type !== "summary")
		throw new Error("No summary node found");
	return String(summary.label);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("dead-process-running detection (slice 2)", () => {
	let provider: AgentStatusTreeProvider;

	beforeEach(() => {
		mock.restore();
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
		// Default mock behaviour: tmux has-session succeeds (session alive),
		// openclaw audit returns clean state. Real execFileSync for everything else.
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
		// Default pane check: alive (fail-open).
		mockIsTmuxPaneAgentAlive.mockImplementation(() => true);

		const vscodeMock = setupVSCodeMock();
		const getConfigurationMock = mock((_section?: string) => ({
			update: mock(),
			get: mock((_key: string, defaultValue?: unknown) => {
				// Disable project grouping so getChildren() emits a summary node.
				if (_key === "agentStatus.groupByProject") return false;
				// Disable process discovery to avoid real pgrep/ps scans in tests.
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
		vscodeMock.window.showInformationMessage = mock(() => Promise.resolve(undefined));
		vscodeMock.window.showWarningMessage = mock(() => Promise.resolve(undefined));

		provider = new AgentStatusTreeProvider(
			{ getIconForProject: mock(() => "🧩"), setCustomIcon: mock(() => Promise.resolve()) } as unknown as ConstructorParameters<
				typeof AgentStatusTreeProvider
			>[0],
		);
		provider.setReviewTracker(
			new InMemoryReviewTracker() as unknown as ReviewTracker,
		);
		provider.readRegistry = () => makeRegistry({});
		provider.reload();
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

	// ── Test 1: dead process, session alive → stopped ─────────────────────────

	test("dead agent process in alive session → task displays as stopped", () => {
		// The tmux session exists (windowAlive=true) but no pane has a live agent.
		// Expected: dead-process-running overlay → `stopped`.
		// Do NOT set start_commit so the completed_dirty fallback doesn't fire.
		const task = makeTask({ id: "dead-agent-1" });
		seedSessionAlive(provider, task);
		// Pane check: no agent found → false (the "dead-process-running" signal).
		mockIsTmuxPaneAgentAlive.mockImplementation(() => false);

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		expect(provider.getTasks()[0]?.status).toBe("stopped");
	});

	// ── Test 2: live process, session alive → running ─────────────────────────

	test("live agent process in alive session → task stays running", () => {
		const task = makeTask({ id: "live-agent-1" });
		seedSessionAlive(provider, task);
		// Pane check returns true → alive
		mockIsTmuxPaneAgentAlive.mockImplementation(() => true);

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		expect(provider.getTasks()[0]?.status).toBe("running");
	});

	// ── Test 3: missing stream file + live pane → running (regression guard) ──

	test("missing stream file + live tmux pane → task stays running (regression guard)", () => {
		// Regression guard: stream file presence must NOT be used as a liveness
		// signal. Slice 1 dev notes (DEV-NOTES-cc-agent-status-slice1-v1.md) warn
		// explicitly that team-mode runs lack a stream file yet are still alive.
		// Even with a nonexistent stream_file path, a live pane → running.
		const task = makeTask({
			id: "no-stream-live-pane",
			stream_file: "/nonexistent/path/to/stream.jsonl",
		});
		seedSessionAlive(provider, task);
		mockIsTmuxPaneAgentAlive.mockImplementation(() => true);

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		// stream_file is missing on disk → getStreamTerminalState returns null.
		// The pane check then determines liveness. Pane is alive → running.
		expect(provider.getTasks()[0]?.status).toBe("running");
	});

	// ── Test 4: live team lane (explicit regression-guard variant) ────────────

	test("live team lane with claude pane (no stream file) → stays running", () => {
		// Explicit variant of test 3 to guard the team-mode regression:
		// In team mode (e.g. cc-review-whats-new-version with agent-command-central
		// session), there is NO stream file. The lane must stay running as long as
		// a pane with a known agent CLI is active. This mirrors the slice 1 warning
		// in DEV-NOTES-cc-agent-status-slice1-v1.md.
		const task = makeTask({
			id: "team-lane-claude-pane",
			// No stream_file — typical for team-mode launches
		});
		seedSessionAlive(provider, task);
		mockIsTmuxPaneAgentAlive.mockImplementation(() => true);

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		expect(provider.getTasks()[0]?.status).toBe("running");
	});

	// ── Test 5: fail-open — helper returns true by default ───────────────────

	test("fail-open: isTmuxPaneAgentAlive returns true (conservative default) → running", () => {
		// Contract: isTmuxPaneAgentAlive is fail-open. On any error (tmux not on
		// PATH, invalid session id, timeout, malformed output) it returns true.
		// The tree provider must honour this: true → alive → task stays running.
		const task = makeTask({ id: "fail-open-task" });
		seedSessionAlive(provider, task);
		// Explicitly use default: true (same as fail-open case).
		mockIsTmuxPaneAgentAlive.mockImplementation(() => true);

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		expect(provider.getTasks()[0]?.status).toBe("running");
	});

	// ── Test 6: count truthfulness ────────────────────────────────────────────

	test("dead-process-running: NOT counted as working in summary", () => {
		// When the pane check detects a dead agent, the task is overlaid to
		// `stopped` and routes to the attention group. The summary label must
		// reflect this: NOT "1 working", but "1 ⏹" (attention).
		const task = makeTask({ id: "count-test-dead" });
		seedSessionAlive(provider, task);
		mockIsTmuxPaneAgentAlive.mockImplementation(() => false);

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		const label = getSummaryLabel(provider);
		expect(label).not.toContain("working");
		expect(label).toContain("⏹");
	});

	test("live process: counted as working in summary", () => {
		// Counterpart to the count test above: live agent → 1 working.
		const task = makeTask({ id: "count-test-live" });
		seedSessionAlive(provider, task);
		mockIsTmuxPaneAgentAlive.mockImplementation(() => true);

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		const label = getSummaryLabel(provider);
		expect(label).toContain("working");
		expect(label).not.toContain("⏹");
	});
});
