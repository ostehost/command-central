/**
 * Regression tests: completed tmux tasks must not misclassify as Running.
 *
 * Ground truth (verified 2026-06-12):
 *   review-symphony-orchestrator-http-decision-client-20260612
 *     status: completed, completed_at: 2026-06-12T18:19:58Z,
 *     terminal_backend: tmux, review_state: no_review_expected,
 *     exec_mode: hub, exec_host: Mike's MacBook Pro.
 *   The session lives on a custom tmux socket; `tmux list-sessions` (default
 *   server) shows NO matching session, but the socket IS alive.  The task is
 *   correctly completed in tasks.json; when the registry is read fresh the
 *   task should land in the "done" group with no fresh-attach chip and
 *   "View Changes" as the primary action.
 *
 * Bug scenario (FAILING — awaits fix by Implementer, task #3):
 *   When tasks.json still carries status="running" but completed_at is set
 *   (partial-write race), AND the tmux window is alive on the custom socket,
 *   AND the pane-agent inspector returns "unknown" (fail-open), the task
 *   stays classified as Running indefinitely because isRunningTaskHealthy()
 *   returns true.  The fix must check completed_at BEFORE the pane-liveness
 *   fallback so the completion evidence in tasks.json wins.
 *
 * Regression guards (PASSING — prevent future breakage):
 *   • status=completed + dead session           → group "done"
 *   • status=completed + alive session/dead pane → group "done"
 *   • status=completed                           → no "fresh attach" chip
 *   • status=completed                           → command title "View Changes"
 *   • status=completed + review_state=no_review_expected → group "done"
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Freeze real node built-ins before any mock.module() ─────────────────────
const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");
const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof import("node:fs");

// Use real fs — tests don't need to intercept filesystem calls.
mock.module("node:fs", () => realFs);

// ── child_process: intercept tmux commands ───────────────────────────────────
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

// ── tmux-pane-health: controlled per-test ────────────────────────────────────
// Default: "unknown" (fail-open).  Tests override per scenario.
const mockInspectTmuxPaneAgent = mock(
	(_sessionId: string, _socket?: string | null) =>
		"unknown" as "alive" | "dead" | "unknown",
);
const mockInspectTmuxPaneById = mock(
	() => "unknown" as "alive" | "dead" | "unknown",
);
mock.module("../../src/utils/tmux-pane-health.js", () => ({
	isTmuxPaneAgentAlive: mock(
		(sessionId: string, socket?: string | null) =>
			mockInspectTmuxPaneAgent(sessionId, socket) !== "dead",
	),
	inspectTmuxPaneAgent: mockInspectTmuxPaneAgent,
	inspectTmuxPaneById: mockInspectTmuxPaneById,
	// CCSYNC-03 (PAR-228): provider also imports the live-pane attention
	// classifier. Behavior-neutral stubs (never benign) preserve prior grouping.
	capturePaneSnippet: mock((_target: string, _socket?: string | null) => null),
	classifyPaneAttention: mock(() => "unknown" as const),
	isBenignLivePane: mock((_state: string) => false),
	AGENT_PROCESS_NAMES: ["codex", "claude"],
	PANE_ID_RE: /^%\d+$/,
}));

// ── port-detector: no real lsof calls ───────────────────────────────────────
mock.module("../../src/utils/port-detector.js", () => ({
	detectListeningPorts: mock(() => []),
	detectListeningPortsAsync: mock(async () => []),
}));

// ── Imports (after mock.module) ──────────────────────────────────────────────
import {
	__setCurrentMachineHostOverrideForTests,
	type AgentStatusGroup,
	AgentStatusTreeProvider,
	type AgentTask,
	type TaskRegistry,
} from "../../src/providers/agent-status-tree-provider.js";
import type { ReviewTracker } from "../../src/services/review-tracker.js";
import type { TtlCache } from "../../src/utils/ttl-cache.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// ── Prevent readRegistry from hitting real disk ──────────────────────────────
(globalThis as Record<string, unknown>)["__realAgentStatusReadRegistry"] ??=
	AgentStatusTreeProvider.prototype.readRegistry;
AgentStatusTreeProvider.prototype.readRegistry = () => makeRegistry({});

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/** Minimal completed-tmux task factory. */
function makeCompletedTmuxTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "completed-tmux-regression",
		status: "completed",
		project_dir: "/tmp/symphony-test-project",
		project_name: "symphony-test",
		session_id:
			"agent-symphony-daemon-worksystem-lease-20260611-symphony-orchestrator-http-decision-client-20260612-review",
		tmux_session:
			"agent-symphony-daemon-worksystem-lease-20260611-symphony-orchestrator-http-decision-client-20260612-review",
		tmux_socket:
			"/Users/ostehost/.local/state/ghostty-launcher/tmux/symphony-daemon-worksystem-lease-3699459906.sock",
		tmux_window_id: "@1",
		tmux_pane_id: "%1",
		bundle_path: "(tmux-mode)",
		prompt_file: "",
		started_at: "2026-06-12T18:15:52Z",
		completed_at: "2026-06-12T18:19:58Z",
		attempts: 1,
		max_attempts: 3,
		terminal_backend: "tmux",
		exit_code: 0,
		review_state: "no_review_expected",
		exec_mode: "hub",
		exec_host: "Mike’s MacBook Pro",
		pending_review_path: null,
		handoff_file: null,
		role: "reviewer",
		...overrides,
	};
}

/** Invoke the private getNodeStatusGroup for a task node. */
function groupOf(
	provider: AgentStatusTreeProvider,
	task: AgentTask,
): AgentStatusGroup {
	const fn = (
		provider as unknown as {
			getNodeStatusGroup(node: {
				type: "task";
				task: AgentTask;
			}): AgentStatusGroup;
		}
	).getNodeStatusGroup.bind(provider);
	return fn({ type: "task", task });
}

/** Seed the tmux liveness checker's session-health cache with a canned alive/dead result. */
function seedSessionCache(
	provider: AgentStatusTreeProvider,
	task: AgentTask,
	alive: boolean,
): void {
	const key = `${task.tmux_socket ?? "__default__"}::${task.session_id}`;
	(
		provider as unknown as {
			tmuxLiveness: { sessionHealthCache: TtlCache<boolean> };
		}
	).tmuxLiveness.sessionHealthCache.set(key, alive);
}

/** Seed the tmux liveness checker's session-health cache for the window-level check. */
function seedWindowCache(
	provider: AgentStatusTreeProvider,
	task: AgentTask,
	alive: boolean,
): void {
	const key = `${task.tmux_socket ?? "__default__"}::${task.session_id}::${task.tmux_window_id}`;
	(
		provider as unknown as {
			tmuxLiveness: { sessionHealthCache: TtlCache<boolean> };
		}
	).tmuxLiveness.sessionHealthCache.set(key, alive);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("completed-tmux regression", () => {
	let provider: AgentStatusTreeProvider;

	beforeEach(() => {
		// Re-apply mocks after global mock.restore()
		mock.module("node:fs", () => realFs);
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFileSync: execFileSyncMock,
		}));
		mock.module("../../src/utils/port-detector.js", () => ({
			detectListeningPorts: mock(() => []),
			detectListeningPortsAsync: mock(async () => []),
		}));

		execFileSyncMock.mockReset();
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[] | undefined];
			if (cmd === "tmux" && args?.includes("has-session")) return "";
			if (cmd === "tmux" && args?.includes("list-windows")) return "";
			if (
				cmd === "openclaw" &&
				args?.[0] === "tasks" &&
				args[1] === "audit" &&
				args[2] === "--json"
			) {
				return JSON.stringify({
					summary: { total: 0, warnings: 0, errors: 0, byCode: {} },
					findings: [],
				});
			}
			return realChildProcess.execFileSync(
				cmd,
				args,
				fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
			);
		});

		mockInspectTmuxPaneAgent.mockReset();
		mockInspectTmuxPaneAgent.mockImplementation(() => "unknown");
		mockInspectTmuxPaneById.mockReset();
		mockInspectTmuxPaneById.mockImplementation(() => "unknown");

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

		provider = new AgentStatusTreeProvider({
			getIconForProject: mock(() => "🎭"),
			setCustomIcon: mock(() => Promise.resolve()),
		} as unknown as ConstructorParameters<typeof AgentStatusTreeProvider>[0]);
		provider.setReviewTracker(
			new InMemoryReviewTracker() as unknown as ReviewTracker,
		);
		provider.readRegistry = () => makeRegistry({});
		provider.reload();
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

	// ── Regression guard: completed task + dead session → done ───────────────

	test("regression: completed+completed_at+tmux+dead session → group is done (not running)", () => {
		// Verify that a task that tasks.json reports as completed lands in the
		// "done" group even when its tmux session is dead (common post-completion
		// steady state).
		const task = makeCompletedTmuxTask();
		seedSessionCache(provider, task, false);
		seedWindowCache(provider, task, false);
		mockInspectTmuxPaneById.mockImplementation(() => "dead");

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		expect(groupOf(provider, task)).toBe("done");
		expect(provider.getTasks()[0]?.status).toBe("completed");
	});

	test("regression: completed+completed_at+tmux+alive session+dead pane → group is done (not running)", () => {
		// A completed task whose tmux session is still open (window alive) but
		// whose agent process has exited (pane dead) must land in "done", not
		// "running". Lifecycle conflict only fires for "alive" pane evidence.
		const task = makeCompletedTmuxTask();
		seedSessionCache(provider, task, true);
		seedWindowCache(provider, task, true);
		mockInspectTmuxPaneById.mockImplementation(() => "dead");

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		expect(groupOf(provider, task)).toBe("done");
		expect(provider.getTasks()[0]?.status).toBe("completed");
	});

	test("resurrection guard: completed+alive window+unknown pane → still done (no promotion to running)", () => {
		// The real on-disk task (review-symphony-orchestrator-http-decision-client-20260612)
		// has status=completed, completed_at set, and the tmux session is STILL ALIVE on the
		// custom socket (/Users/ostehost/.local/state/ghostty-launcher/tmux/symphony-daemon-*).
		// "tmux list-sessions" (default server) shows no match, but the session IS live on
		// the socket.  Pane evidence is "unknown" (fail-open — no confirmed agent comm).
		//
		// This is the STRONGEST form of Mike's requirement #1: completed records must not
		// be re-routed to Running just because tmux metadata exists or the session is alive.
		// A code path that calls isRunningTaskHealthy() for status=completed tasks would
		// silently promote this task to Running on every render.
		const task = makeCompletedTmuxTask();
		// Session and window both alive on custom socket.
		seedSessionCache(provider, task, true);
		seedWindowCache(provider, task, true);
		// Pane evidence unknown (fail-open): no confirmed dead or alive agent.
		mockInspectTmuxPaneById.mockImplementation(() => "unknown");
		mockInspectTmuxPaneAgent.mockImplementation(() => "unknown");

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();
		provider.getDiffSummary = () => null;

		// Must stay completed — never promoted to running by liveness signals.
		expect(groupOf(provider, task)).toBe("done");
		expect(provider.getTasks()[0]?.status).toBe("completed");
		// No fresh-attach chip on a completed task.
		const item = provider.getTreeItem({ type: "task", task });
		expect(String(item.description ?? "")).not.toContain("fresh attach");
	});

	test("regression: completed+review_state=no_review_expected+tmux+dead session → group is done", () => {
		// The symphony-orchestrator task has review_state=no_review_expected.
		// This is a terminal review state — isReviewLifecycleResolved() returns
		// true — so no pending-review chip appears and the group is "done".
		const task = makeCompletedTmuxTask({ review_state: "no_review_expected" });
		seedSessionCache(provider, task, false);
		seedWindowCache(provider, task, false);

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		expect(groupOf(provider, task)).toBe("done");
	});

	// ── Regression guard: completed task description has no fresh-attach chip ─

	test("regression: completed+tmux task → description has no fresh-attach chip", () => {
		// The "tmux · fresh attach" chip must NEVER appear for completed tasks.
		// It is only meaningful for running tasks where the click will route to
		// a live terminal.  For done tasks the click opens a QuickPick (diff/review),
		// not a terminal focus — see agent-status-tree-provider-rendering.test.ts:1021.
		const task = makeCompletedTmuxTask();
		seedSessionCache(provider, task, false);

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();
		provider.getDiffSummary = () => null;

		const item = provider.getTreeItem({ type: "task", task });
		expect(String(item.description ?? "")).not.toContain("fresh attach");
	});

	// ── First-class terminal focus: completed terminal rows stay focusable ─────

	test("completed+tmux task → primary command title is 'Focus Terminal'", () => {
		// Terminal focus is now the primary action whenever the row has
		// authoritative terminal metadata. The focus command owns the liveness
		// resolution/fallback path instead of hiding Focus behind another picker.
		const task = makeCompletedTmuxTask();
		seedSessionCache(provider, task, false);

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();
		provider.getDiffSummary = () => null;

		const item = provider.getTreeItem({ type: "task", task });
		expect(item.command?.title).toBe("Focus Terminal");
	});

	// ── FAILING TEST — awaits fix in task #3 ─────────────────────────────────
	//
	// Scenario: tasks.json write-lag race — the launcher wrote completed_at
	// (and possibly exit_code=0) before writing status=completed.  The extension
	// reads the partial record: status="running", completed_at=set, window alive,
	// pane evidence "unknown" (fail-open).  Because isRunningTaskHealthy() sees
	// an alive window + non-dead pane and returns true, Tier 4 (which checks
	// completed_at) is never reached.  The task stays classified as "running"
	// and shows the "tmux · fresh attach" chip; clicking opens a Ghostty attach
	// to the review session, but the agent is already done — a dead-end action.
	//
	// Fix required: check completed_at earlier in toDisplayTask() so that a
	// "running" record with completed_at set is treated as completed regardless
	// of tmux liveness signals.

	test("regression: running+completed_at+alive window+unknown pane → reclassified as completed (not running)", () => {
		// tasks.json still says "running" (partial write), but completed_at is
		// set and the tmux window is alive with unknown pane evidence (fail-open).
		// Expected AFTER FIX: reclassified to completed.
		// CURRENTLY FAILS: stays running (completed_at ignored when liveness is healthy).
		const task = makeCompletedTmuxTask({
			status: "running",
			exit_code: null,
			// completed_at remains set (from makeCompletedTmuxTask default)
		});

		// Session and window alive — simulates the custom-socket scenario.
		seedSessionCache(provider, task, true);
		seedWindowCache(provider, task, true);
		// Pane evidence unknown (fail-open) — no confirmed dead/alive agent.
		mockInspectTmuxPaneById.mockImplementation(() => "unknown");
		mockInspectTmuxPaneAgent.mockImplementation(() => "unknown");

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		// The task should be reclassified to completed because completed_at is set.
		expect(provider.getTasks()[0]?.status).toBe("completed");
	});

	test("regression: running+exit_code=0+alive window+unknown pane → reclassified as completed (not running)", () => {
		// Variant: exit_code=0 is set (another partial-write signal).
		// Expected AFTER FIX: reclassified to completed.
		// CURRENTLY FAILS: stays running (exit_code=0 ignored when liveness is healthy).
		const task = makeCompletedTmuxTask({
			status: "running",
			exit_code: 0,
			completed_at: null, // only exit_code is set, not completed_at
		});

		seedSessionCache(provider, task, true);
		seedWindowCache(provider, task, true);
		mockInspectTmuxPaneById.mockImplementation(() => "unknown");
		mockInspectTmuxPaneAgent.mockImplementation(() => "unknown");

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		expect(provider.getTasks()[0]?.status).toBe("completed");
	});
});
