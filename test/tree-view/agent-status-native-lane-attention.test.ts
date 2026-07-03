/**
 * PAR-323: project OpenClaw/Symphony-native visible-lane attention receipts into
 * the Agent Status row.
 *
 * symphony-daemon owns a durable receipt vocabulary for a visible lane's
 * attention state. Command Central projects it (it is never the source of truth
 * for lane lifecycle) via `AgentTask.visible_lane_attention`:
 *
 *  - "awaiting_input" → the lane is BLOCKED at a permission/input prompt a human
 *    must answer. Authoritative: the row renders "(awaiting input)" from the
 *    receipt ALONE — no local pane read, no stuck-heuristic, and it outranks the
 *    degraded-visibility "(detached)" surface.
 *  - "attention"      → the lane needs a look but is NOT a confirmed input wait
 *    (degraded on-screen visibility / stale AX or tmux capture). Renders
 *    "(needs attention)" and MUST NEVER read as an input wait by itself.
 *
 * These fixtures deliberately neutralize the local pane heuristic (pane liveness
 * "unknown", capture returns null) and use a NON-stuck lane, so the native
 * receipt is the sole driver of the badge. The PAR-322 pane-heuristic path is
 * pinned separately in agent-status-awaiting-input-wake.test.ts and must stay
 * green — a regression guard here proves degraded visibility alone never becomes
 * an input wait.
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

const real = (await import(
	"../../src/utils/tmux-pane-health.js"
)) as typeof import("../../src/utils/tmux-pane-health.js");

// Pane liveness stays "unknown" and capture returns null for every test here —
// the local heuristic can NOT manufacture a wait, so any "(awaiting input)" we
// observe is the native receipt projection, not PAR-322.
const mockInspectTmuxPaneAgent = mock(
	(_sessionId: string, _socket?: string | null) =>
		"unknown" as "alive" | "dead" | "unknown",
);
const mockInspectTmuxPaneById = mock(
	() => "unknown" as "alive" | "dead" | "unknown",
);
const mockCapturePaneSnippet = mock(
	(_target: string, _socket?: string | null): string | null => null,
);
mock.module("../../src/utils/tmux-pane-health.js", () => ({
	isTmuxPaneAgentAlive: mock(
		(sessionId: string, socket?: string | null) =>
			mockInspectTmuxPaneAgent(sessionId, socket) !== "dead",
	),
	inspectTmuxPaneAgent: mockInspectTmuxPaneAgent,
	inspectTmuxPaneById: mockInspectTmuxPaneById,
	capturePaneSnippet: mockCapturePaneSnippet,
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
 * A recently-started launcher tmux lane — NOT stuck (well within the stuck
 * threshold), so `interactiveAwaiting` is false and nothing but the native
 * receipt can drive an attention badge.
 */
function makeRunningLane(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "native-attention-lane",
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
		started_at: new Date(Date.now() - 60_000).toISOString(),
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

describe("PAR-323 — native visible-lane attention projection", () => {
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
		mockInspectTmuxPaneById.mockImplementation(() => "unknown");
		mockCapturePaneSnippet.mockReset();
		mockCapturePaneSnippet.mockImplementation(() => null);

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

	test("native awaiting_input renders (awaiting input) from the receipt alone (no pane read, not stuck)", () => {
		const task = makeRunningLane({
			visible_lane_attention: "awaiting_input",
			visible_lane_attention_reason: "permission_prompt",
		});
		const description = rowDescription(provider, task);
		expect(description).toContain("(awaiting input)");
		expect(description).not.toContain("(interactive)");
		expect(description).not.toContain("(needs attention)");
		// The local pane heuristic was never the source — capture returned null.
		expect(mockCapturePaneSnippet).not.toHaveBeenCalled();
	});

	test("a native awaiting_input wait attributes to the daemon and carries its reason", () => {
		const task = makeRunningLane({
			visible_lane_attention: "awaiting_input",
			visible_lane_attention_reason: "numbered_permission_selector",
		});
		const tooltip = rowTooltip(provider, task);
		expect(tooltip).toContain("Awaiting input");
		expect(tooltip).toContain("OpenClaw/Symphony");
		expect(tooltip).toContain("numbered_permission_selector");
	});

	test("native attention renders (needs attention) — visibility degraded, NOT an input wait", () => {
		const task = makeRunningLane({
			visible_lane_attention: "attention",
			visible_lane_attention_reason: "tmux_stream_stale",
		});
		const description = rowDescription(provider, task);
		expect(description).toContain("(needs attention)");
		expect(description).not.toContain("(awaiting input)");
		const tooltip = rowTooltip(provider, task);
		expect(tooltip).toContain("Needs attention");
		expect(tooltip).toContain("tmux_stream_stale");
		expect(tooltip).not.toContain("Awaiting input");
	});

	test("degraded visibility ALONE (no native receipt) is detached, never an input wait", () => {
		const task = makeRunningLane({
			launcher_visibility_degraded: true,
			launcher_visibility_reason: "ax_error_focus_lost",
		});
		const description = rowDescription(provider, task);
		expect(description).toContain("(detached)");
		expect(description).not.toContain("(awaiting input)");
	});

	test("a native awaiting_input receipt outranks degraded visibility (authoritative through it)", () => {
		const task = makeRunningLane({
			launcher_visibility_degraded: true,
			launcher_visibility_reason: "ax_error_focus_lost",
			visible_lane_attention: "awaiting_input",
		});
		const description = rowDescription(provider, task);
		expect(description).toContain("(awaiting input)");
		expect(description).not.toContain("(detached)");
	});

	test("no native receipt and no local evidence → no attention badge is invented", () => {
		const task = makeRunningLane();
		const description = rowDescription(provider, task);
		expect(description).not.toContain("(awaiting input)");
		expect(description).not.toContain("(needs attention)");
	});
});
