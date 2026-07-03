/**
 * PAR-322 [PAR297-FU-01]: detect a VISIBLE Claude permission/input wait on a
 * live interactive lane and surface it distinctly so the bound workroom can be
 * woken.
 *
 * A launcher-managed tmux lane running interactive Claude that has gone quiet
 * past the stuck threshold (positive pane liveness, stale stream) is treated as
 * `interactiveAwaiting` and badged "(interactive)". That heuristic is purely
 * time/liveness based — it cannot tell an idle REPL apart from a Claude that is
 * actually BLOCKED on a permission/input prompt a human must answer.
 *
 * This suite pins the follow-up: when the pane is read and it genuinely shows an
 * interactive prompt, the row surfaces "(awaiting input)" (and a tooltip line)
 * instead of the generic "(interactive)" — even though the agent process still
 * owns the pane. A quiet/benign snippet, or a failed capture, keeps the honest
 * "(interactive)" hint (no false wait is ever claimed).
 *
 * Regression contract: BEFORE this change `getTerminalTaskPaneAttention` forced
 * `active-agent` for any alive pane, masking the wait; the running path never
 * read the pane at all. AFTER, an unambiguous `awaiting-user-input` snippet wins
 * over `active-agent`, and the running interactive path consumes it.
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
//    but the PURE classifier + benign predicate run for real (the wiring under
//    test). ────────────────────────────────────────────────────────────────
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
// A live Claude sitting at its permission selector — the exact prompt a human
// must answer. The pure classifier matches the "❯ 1. " numbered-choice row.
let nextSnippet: string | null =
	"● Bash(rm -rf build)\n  Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently";
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

/**
 * A launcher-managed interactive Claude lane that has been running for hours
 * with no stream file — `isAgentStuck` fires (past threshold, no stream), and
 * with an "alive" pane probe it becomes `interactiveAwaiting`.
 */
function makeRunningInteractiveTask(
	overrides: Partial<AgentTask> = {},
): AgentTask {
	return {
		id: "awaiting-input-lane",
		status: "running",
		project_dir: "/tmp/p",
		project_name: "p",
		session_id: "agent-symphony-daemon",
		tmux_session: "agent-symphony-daemon",
		tmux_socket: "/tmp/sock/symphony-daemon.sock",
		tmux_window_id: "@85",
		tmux_pane_id: "%93",
		bundle_path: "(tmux-mode)",
		prompt_file: "",
		started_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
		completed_at: null,
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

function rowDescription(
	provider: AgentStatusTreeProvider,
	task: AgentTask,
): string {
	const item = provider.getTreeItem({ type: "task", task });
	return String(item.description ?? "");
}

function rowTooltip(
	provider: AgentStatusTreeProvider,
	task: AgentTask,
): string {
	const item = provider.getTreeItem({ type: "task", task });
	const tip = item.tooltip as { value?: string } | string | undefined;
	if (tip && typeof tip === "object" && typeof tip.value === "string") {
		return tip.value;
	}
	return String(tip ?? "");
}

describe("PAR-322 — visible Claude permission/input wait detection", () => {
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
		mockInspectTmuxPaneAgent.mockImplementation(() => "alive");
		mockInspectTmuxPaneById.mockReset();
		// Positive pane liveness → the lane is alive-but-quiet (interactive).
		mockInspectTmuxPaneById.mockImplementation(() => "alive");
		mockCapturePaneSnippet.mockReset();
		mockCapturePaneSnippet.mockImplementation(() => nextSnippet);
		nextSnippet =
			"● Bash(rm -rf build)\n  Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently";

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

	test("live interactive lane blocked at a permission prompt → (awaiting input)", () => {
		const task = makeRunningInteractiveTask();
		const description = rowDescription(provider, task);
		expect(description).toContain("(awaiting input)");
		expect(description).not.toContain("(interactive)");
	});

	test("the awaiting-input wait surfaces an actionable tooltip line", () => {
		const task = makeRunningInteractiveTask();
		expect(rowTooltip(provider, task)).toContain("Awaiting input");
	});

	test("a y/N confirmation prompt is also detected as a wait", () => {
		nextSnippet = "Proceed with edit? (y/N) ";
		const task = makeRunningInteractiveTask();
		expect(rowDescription(provider, task)).toContain("(awaiting input)");
	});

	test("an idle REPL (quiet snippet) keeps the honest (interactive) hint", () => {
		// Alive pane, but nothing interactive on screen — the classifier does NOT
		// invent a wait, so the row stays "(interactive)", not "(awaiting input)".
		nextSnippet = "user@host project % ";
		const task = makeRunningInteractiveTask();
		const description = rowDescription(provider, task);
		expect(description).toContain("(interactive)");
		expect(description).not.toContain("(awaiting input)");
		expect(rowTooltip(provider, task)).not.toContain("Awaiting input");
	});

	test("a failed pane capture never claims a false wait (fail-safe)", () => {
		nextSnippet = null; // capture-pane returned nothing
		const task = makeRunningInteractiveTask();
		const description = rowDescription(provider, task);
		expect(description).toContain("(interactive)");
		expect(description).not.toContain("(awaiting input)");
	});
});
