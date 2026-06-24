/**
 * CCSYNC-03 (PAR-228): live-pane attention classifier — provider wiring.
 *
 * A terminal-status lane whose only "liveness" evidence is the launcher's
 * recorded `session_live` (no agent process confirmed by the pane probe) used to
 * be promoted unconditionally into the badge-counted Action Required group as a
 * "live · lifecycle conflict". But the launcher's session is alive only because
 * the LOGIN SHELL is alive — the agent may be gone, leaving a benign pane:
 *
 *   - a finished command/test run sitting at its shell prompt, OR
 *   - a bare / idle shell with nothing meaningful in it.
 *
 * Those panes are not work and must NOT inflate the activity-bar action badge.
 * This suite asserts the provider now suppresses the attention promotion for a
 * benign live pane (routing it to its normal terminal bucket) while still
 * surfacing a genuine "awaiting-user-input" pane as attention.
 *
 * Regression contract: BEFORE the classifier wiring, a completed_dirty lane with
 * session_live:true grouped as `attention` regardless of the pane's content (see
 * agent-status-live-terminal-state.test.ts). AFTER, a benign captured pane demotes
 * it out of `attention`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");
const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof import("node:fs");

mock.module("node:fs", () => realFs);

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

// ── tmux-pane-health: pane probe + snippet capture are controlled per-test,
//    but the PURE classifier + benign predicate run for real (the unit under
//    test on the wiring side). ──────────────────────────────────────────────
const real = (await import(
	"../../src/utils/tmux-pane-health.js"
)) as typeof import("../../src/utils/tmux-pane-health.js");

const mockInspectTmuxPaneAgent = mock(
	(_sessionId: string, _socket?: string | null) =>
		"unknown" as "alive" | "dead" | "unknown",
);
const mockInspectTmuxPaneById = mock(
	() => "unknown" as "alive" | "dead" | "unknown",
);
// Default: a benign "completed at prompt" snippet — the finished-test-pane case.
let nextSnippet: string | null = "459 pass\n0 fail\nuser@host project %";
const mockCapturePaneSnippet = mock(
	(_target: string, _socket?: string | null) => nextSnippet,
);
mock.module("../../src/utils/tmux-pane-health.js", () => ({
	isTmuxPaneAgentAlive: mock(
		(sessionId: string, socket?: string | null) =>
			mockInspectTmuxPaneAgent(sessionId, socket) !== "dead",
	),
	inspectTmuxPaneAgent: mockInspectTmuxPaneAgent,
	inspectTmuxPaneById: mockInspectTmuxPaneById,
	capturePaneSnippet: mockCapturePaneSnippet,
	// Real pure functions — the classifier behaviour we are wiring in.
	classifyPaneAttention: real.classifyPaneAttention,
	isBenignLivePane: real.isBenignLivePane,
	AGENT_PROCESS_NAMES: real.AGENT_PROCESS_NAMES,
	PANE_ID_RE: real.PANE_ID_RE,
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

function makeTerminalTmuxTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "live-pane-lane",
		status: "contract_failure",
		project_dir: "/tmp/p",
		project_name: "p",
		session_id: "agent-symphony-daemon",
		tmux_session: "agent-symphony-daemon",
		tmux_socket: "/tmp/sock/symphony-daemon.sock",
		tmux_window_id: "@85",
		tmux_pane_id: "%93",
		bundle_path: "(tmux-mode)",
		prompt_file: "",
		started_at: new Date(Date.now() - 60_000).toISOString(),
		completed_at: new Date(Date.now() - 30_000).toISOString(),
		attempts: 1,
		max_attempts: 3,
		terminal_backend: "tmux",
		exec_mode: "hub",
		exec_host: "Mike’s MacBook Pro",
		session_key: "owner-bound",
		stream_file: null,
		handoff_file: null,
		model: null,
		role: "developer",
		...overrides,
	} as AgentTask;
}

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

function rowDescription(
	provider: AgentStatusTreeProvider,
	task: AgentTask,
): string {
	const item = provider.getTreeItem({ type: "task", task });
	return String(item.description ?? "");
}

describe("CCSYNC-03 — live-pane attention suppression (provider wiring)", () => {
	let provider: AgentStatusTreeProvider;

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
			getIconForProject: mock(() => "🎭"),
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

		execFileSyncMock.mockReset();
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[] | undefined];
			if (cmd === "tmux") return "";
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
		// Inconclusive pane probe → liveness rides session_live, never "alive".
		mockInspectTmuxPaneById.mockImplementation(() => "unknown");
		mockCapturePaneSnippet.mockReset();
		mockCapturePaneSnippet.mockImplementation(() => nextSnippet);
		nextSnippet = "459 pass\n0 fail\nuser@host project %";

		provider = freshProvider();
		__setCurrentMachineHostOverrideForTests("Mike’s MacBook Pro");
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

	/**
	 * Warm the render-path caches (liveness + pane-attention) the way a real
	 * refresh does, then read the cache-only grouping — exactly the two-phase
	 * lifecycle getNodeStatusGroup relies on.
	 */
	function groupAfterRender(task: AgentTask): AgentStatusGroup {
		rowDescription(provider, task); // warms the attention cache via capture
		return groupOf(provider, task);
	}

	test("REGRESSION: completed_dirty + session_live:true + benign completed-at-prompt pane → NOT attention", () => {
		// Pre-CCSYNC-03 this lane grouped as `attention` (live lifecycle conflict)
		// regardless of pane content. The pane is a finished test run sitting at the
		// prompt — benign — so it must fall through to its terminal bucket (limbo),
		// keeping it OUT of the activity-bar action badge.
		nextSnippet =
			"459 pass\n0 fail\nRan 459 tests [1.20s]\nuser@host project %";
		const task = makeTerminalTmuxTask({
			status: "completed_dirty",
			session_live: true,
		});
		expect(groupAfterRender(task)).toBe("limbo");
		expect(rowDescription(provider, task)).toContain(
			"live shell · completed at prompt",
		);
		expect(rowDescription(provider, task)).not.toContain(
			"⚠ live · lifecycle conflict",
		);
	});

	test("benign empty/idle shell pane also suppresses the attention promotion", () => {
		nextSnippet = "user@host project % ";
		const task = makeTerminalTmuxTask({
			status: "completed_dirty",
			session_live: true,
		});
		expect(groupAfterRender(task)).toBe("limbo");
		expect(rowDescription(provider, task)).toContain("live shell · idle");
	});

	test("PRESERVED: an awaiting-user-input pane is still attention (genuine block)", () => {
		nextSnippet = "Apply this change?\nProceed with edit? (y/N) ";
		const task = makeTerminalTmuxTask({
			status: "completed_dirty",
			session_live: true,
		});
		expect(groupAfterRender(task)).toBe("attention");
		expect(rowDescription(provider, task)).toContain(
			"⚠ live · lifecycle conflict",
		);
	});

	test("PRESERVED: an unknown pane (capture failed) is still attention — fail-open", () => {
		nextSnippet = null; // capture-pane returned nothing
		const task = makeTerminalTmuxTask({
			status: "completed_dirty",
			session_live: true,
		});
		expect(groupAfterRender(task)).toBe("attention");
	});

	test("PRESERVED: a confirmed-alive agent pane is attention even with a quiet snippet", () => {
		// The pane probe positively confirms an agent process. That is genuine live
		// work and must never be demoted to benign by a snippet that looks idle.
		mockInspectTmuxPaneById.mockImplementation(() => "alive");
		nextSnippet = "user@host project % "; // would look benign in isolation
		const task = makeTerminalTmuxTask({
			status: "contract_failure",
			session_live: true,
		});
		expect(groupAfterRender(task)).toBe("attention");
		expect(rowDescription(provider, task)).toContain(
			"⚠ live · lifecycle conflict",
		);
	});

	test("benign completed-at-prompt with contract_failure status stays attention via dead-failure routing", () => {
		// Suppressing the lifecycle-conflict promotion only removes the LIVE-conflict
		// reason. A genuinely terminal failure status (contract_failure) is still
		// action work on its own merits (DEAD_FAILURE) — the benign pane must not
		// hide a real failure. Routing falls through to the status-based attention.
		nextSnippet = "459 pass\n0 fail\nuser@host project %";
		const task = makeTerminalTmuxTask({
			status: "contract_failure",
			session_live: true,
		});
		// contract_failure with no review/handoff signals → final attention fallthrough.
		expect(groupAfterRender(task)).toBe("attention");
		// But the badge no longer claims a LIVE conflict — the pane is benign.
		expect(rowDescription(provider, task)).not.toContain(
			"⚠ live · lifecycle conflict",
		);
		expect(rowDescription(provider, task)).toContain(
			"live shell · completed at prompt",
		);
	});
});
