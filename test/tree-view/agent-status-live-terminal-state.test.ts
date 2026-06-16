/**
 * Live-terminal-state visibility: a launcher-recorded TERMINAL status that is
 * contradicted by a still-alive session must surface as "live attention
 * required", never silently grouped as a dead failure or aged into History.
 *
 * Incident (cc-agent-status-live-terminal-state-20260615):
 *   symphony-unmodified-openclaw-integration-20260615 had a live tmux/Claude
 *   pane (`session_live: true`, window 86 / panes 93–96) while the launcher
 *   stamped the lead task `contract_failure` / `missing_handoff` from a
 *   premature, lead-Stop-triggered contract gate. Command Central could not
 *   represent "terminal status but provably alive" anywhere the operator would
 *   see it without expanding a lane already buried in the failure bucket — and
 *   it never consumed the launcher's OWN contradicting `session_live` field.
 *
 * Doctrine preserved (truthful over pretty):
 *   - A real-time tmux probe verdict ("alive"/"dead") always wins. A confirmed-
 *     dead pane overrides a stale `session_live: true`.
 *   - `session_live` is a CHEAP, host-agnostic corroboration consulted only when
 *     the probe cannot decide (cold hot-path cache, remote-node lane).
 *   - The lane stays explicitly distinct from a genuine `running` lane: it lands
 *     in Action Required ("live attention required"), never the Live group.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Freeze real node built-ins before any mock.module() ─────────────────────
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

// ── tmux-pane-health: controlled per-test (default "unknown" / fail-open) ────
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
	AGENT_PROCESS_NAMES: ["codex", "claude"],
	PANE_ID_RE: /^%\d+$/,
}));

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
	classifyLifecycleConflict,
	isAgentTeamLead,
	isRegistryBackedLaneTask,
	isSupersededByReleaseReset,
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
 * Minimal terminal-status tmux lane. Defaults to the incident shape:
 * `contract_failure` with an owner-bound session_key (so the unrelated
 * "⚠ detached" badge is suppressed and the description stays short and
 * un-truncated). Local host by default.
 */
function makeTerminalTmuxTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "live-terminal-lane",
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
	};
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

function rowTooltip(
	provider: AgentStatusTreeProvider,
	task: AgentTask,
): string {
	const item = provider.getTreeItem({ type: "task", task });
	const tip = item.tooltip;
	return typeof tip === "string" ? tip : String(tip?.value ?? "");
}

// ── Pure classifier — session_live corroboration ────────────────────────────

describe("classifyLifecycleConflict — launcher session_live corroboration", () => {
	function task(overrides: Partial<AgentTask> = {}): AgentTask {
		return makeTerminalTmuxTask(overrides);
	}

	test("terminal + inconclusive probe + session_live:true → conflict (launcher-recorded provenance)", () => {
		const conflict = classifyLifecycleConflict(
			task({ status: "contract_failure" }),
			"not-checked",
			true,
		);
		expect(conflict.kind).toBe("live-process-conflict");
		expect(conflict.detail).toContain("contract_failure");
		expect(conflict.detail).toContain("session_live");
		expect(conflict.detail).toContain("verify on host");
		// Must NOT claim a real-time terminal observation it does not have.
		expect(conflict.detail).not.toContain("still alive in terminal");
	});

	test("real-time live probe wins → conflict worded as a live terminal observation", () => {
		const conflict = classifyLifecycleConflict(
			task({ status: "contract_failure" }),
			"alive",
			false,
		);
		expect(conflict.kind).toBe("live-process-conflict");
		expect(conflict.detail).toContain("still alive in terminal");
	});

	test("confirmed-dead pane overrides a stale session_live:true → none", () => {
		const conflict = classifyLifecycleConflict(
			task({ status: "contract_failure" }),
			"dead",
			true,
		);
		expect(conflict.kind).toBe("none");
	});

	test("terminal + inconclusive probe + no session_live → none", () => {
		expect(
			classifyLifecycleConflict(task({ status: "failed" }), "not-checked", null)
				.kind,
		).toBe("none");
		expect(
			classifyLifecycleConflict(task({ status: "failed" }), "unknown", false)
				.kind,
		).toBe("none");
	});

	test("failed/stopped/killed are all conflict-eligible via session_live", () => {
		for (const status of ["failed", "stopped", "killed"] as const) {
			const conflict = classifyLifecycleConflict(
				task({ status }),
				"unknown",
				true,
			);
			expect(conflict.kind).toBe("live-process-conflict");
			expect(conflict.detail).toContain(status);
		}
	});

	test("running is never a lifecycle conflict even with session_live:true", () => {
		expect(
			classifyLifecycleConflict(
				task({ status: "running" }),
				"not-checked",
				true,
			).kind,
		).toBe("none");
	});
});

// ── Pure predicates — ingestion admittance + team lead ──────────────────────

describe("isRegistryBackedLaneTask — terminal status does not gate admittance", () => {
	test("contract_failure row WITH project_ref.id is registry-backed (admitted)", () => {
		const task = makeTerminalTmuxTask({
			status: "contract_failure",
			project_ref: { id: "symphony-daemon" },
		});
		expect(isRegistryBackedLaneTask(task)).toBe(true);
	});

	test("row WITHOUT project_ref.id is not registry-backed (quarantined)", () => {
		expect(isRegistryBackedLaneTask(makeTerminalTmuxTask())).toBe(false);
		expect(
			isRegistryBackedLaneTask(
				makeTerminalTmuxTask({ project_ref: { id: " " } }),
			),
		).toBe(false);
	});
});

describe("isAgentTeamLead", () => {
	test("team_requested:true → lead", () => {
		expect(
			isAgentTeamLead(makeTerminalTmuxTask({ team_requested: true })),
		).toBe(true);
	});
	test("team_template present → lead", () => {
		expect(
			isAgentTeamLead(makeTerminalTmuxTask({ team_template: "full" })),
		).toBe(true);
	});
	test("solo lane → not a lead", () => {
		expect(isAgentTeamLead(makeTerminalTmuxTask())).toBe(false);
		expect(
			isAgentTeamLead(
				makeTerminalTmuxTask({ team_requested: false, team_template: "  " }),
			),
		).toBe(false);
	});
});

// ── Provider integration — grouping + row badge ─────────────────────────────

describe("live-terminal-state — provider grouping + row badge", () => {
	let provider: AgentStatusTreeProvider;

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
		provider.getDiffSummary = () => null;
		provider.reload();
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

	test("PRIMARY: contract_failure + session_live:true + cold cache → row shows 'live · lifecycle conflict'", () => {
		// The incident shape exactly: launcher stamped contract_failure but its own
		// record carries session_live:true and the stream file was never created.
		// The hot-path liveness cache is cold and the pane probe is inconclusive
		// ("unknown"), so detection MUST come from the launcher's session_live.
		const task = makeTerminalTmuxTask({
			status: "contract_failure",
			session_live: true,
			stream_file: null,
		});
		mockInspectTmuxPaneById.mockImplementation(() => "unknown");

		expect(rowDescription(provider, task)).toContain(
			"⚠ live · lifecycle conflict",
		);
		// Distinct from a genuine running lane: Action Required, never Live.
		expect(groupOf(provider, task)).toBe("attention");
		// Provenance-honest tooltip — recorded, not a live observation.
		expect(rowTooltip(provider, task)).toContain("session_live");
	});

	test("real-time live pane wins: contract_failure + alive pane → conflict worded as live terminal", () => {
		const task = makeTerminalTmuxTask({ status: "contract_failure" });
		mockInspectTmuxPaneById.mockImplementation(() => "alive");

		expect(rowDescription(provider, task)).toContain(
			"⚠ live · lifecycle conflict",
		);
		expect(rowTooltip(provider, task)).toContain("still alive in terminal");
		expect(groupOf(provider, task)).toBe("attention");
	});

	test("truthful: confirmed-dead pane overrides stale session_live:true → no conflict badge", () => {
		const task = makeTerminalTmuxTask({
			status: "contract_failure",
			session_live: true,
		});
		mockInspectTmuxPaneById.mockImplementation(() => "dead");

		expect(rowDescription(provider, task)).not.toContain("lifecycle conflict");
	});

	test("grouping: completed_dirty + session_live:true (cold cache) → attention, not limbo", () => {
		// Without the launcher corroboration a completed_dirty lane sits in limbo
		// (Needs Review). session_live:true means it is still alive → Action Required.
		const live = makeTerminalTmuxTask({
			status: "completed_dirty",
			session_live: true,
		});
		const control = makeTerminalTmuxTask({
			status: "completed_dirty",
			session_live: null,
		});
		expect(groupOf(provider, live)).toBe("attention");
		expect(groupOf(provider, control)).toBe("limbo");
	});

	test("node registry source: remote-node contract_failure + session_live:true → badge from launcher record", () => {
		// A node-origin lane (different exec_host) cannot be tmux-probed locally, so
		// the live probe is "not-checked". The node registry IS the source of truth
		// for this lane, and its session_live:true must still surface the conflict.
		__setCurrentMachineHostOverrideForTests("Hub Mac");
		const task = makeTerminalTmuxTask({
			status: "contract_failure",
			exec_mode: "node",
			exec_host: "Node Mac",
			session_live: true,
		});
		// Even if a local probe WOULD say alive, remote lanes are never locally
		// probed — detection rides the launcher record alone.
		mockInspectTmuxPaneById.mockImplementation(() => "alive");

		expect(rowDescription(provider, task)).toContain(
			"⚠ live · lifecycle conflict",
		);
		expect(rowTooltip(provider, task)).toContain("session_live");
		expect(groupOf(provider, task)).toBe("attention");
	});

	test("Agent Team lead badge surfaces the otherwise-invisible fan-out", () => {
		const full = makeTerminalTmuxTask({
			status: "contract_failure",
			session_live: true,
			team_requested: true,
			team_template: "full",
		});
		expect(rowDescription(provider, full)).toContain("team: full");

		const bare = makeTerminalTmuxTask({
			id: "team-bare",
			status: "contract_failure",
			team_requested: true,
			team_template: null,
		});
		expect(rowDescription(provider, bare)).toContain("team");

		const solo = makeTerminalTmuxTask({
			id: "solo",
			status: "contract_failure",
		});
		expect(rowDescription(provider, solo)).not.toContain("team");
	});

	test("missing stream file is no obstacle: session_live drives detection without a stream", () => {
		// stream_status:"missing" in the incident — CC never reads a stream here;
		// the launcher's session_live alone proves the lane is alive.
		const task = makeTerminalTmuxTask({
			status: "contract_failure",
			session_live: true,
			stream_file: null,
		});
		expect(rowDescription(provider, task)).toContain(
			"⚠ live · lifecycle conflict",
		);
	});

	test("clean terminal lane (no session_live, dead pane) stays a plain failure — no false 'live'", () => {
		const task = makeTerminalTmuxTask({
			status: "contract_failure",
			session_live: null,
		});
		mockInspectTmuxPaneById.mockImplementation(() => "dead");
		expect(rowDescription(provider, task)).not.toContain("lifecycle conflict");
		expect(groupOf(provider, task)).toBe("attention");
	});
});

// ── Pure predicate — release-reset supersession ─────────────────────────────

describe("isSupersededByReleaseReset", () => {
	const gen = (release_generation: string | null) =>
		makeTerminalTmuxTask({ release_generation });

	test("known different generations → superseded", () => {
		expect(isSupersededByReleaseReset(gen("rc.64"), "rc.65")).toBe(true);
	});
	test("matching generation → not superseded", () => {
		expect(isSupersededByReleaseReset(gen("rc.65"), "rc.65")).toBe(false);
	});
	test("unknown on either side → not judged (no behavior change)", () => {
		expect(isSupersededByReleaseReset(gen(null), "rc.65")).toBe(false);
		expect(isSupersededByReleaseReset(gen("rc.64"), null)).toBe(false);
		expect(isSupersededByReleaseReset(gen(null), null)).toBe(false);
		expect(isSupersededByReleaseReset(gen("  "), "rc.65")).toBe(false);
		expect(isSupersededByReleaseReset(gen("rc.64"), "  ")).toBe(false);
	});
});

// ── Release hygiene: pre-reset stale vs post-release recreated terminals ─────

describe("release hygiene — stale pre-reset terminals vs recreated terminals", () => {
	let provider: AgentStatusTreeProvider;

	function setCurrentGeneration(
		provider: AgentStatusTreeProvider,
		gen: string,
	) {
		(
			provider as unknown as {
				_currentReleaseGenerationOverride: string | null;
			}
		)._currentReleaseGenerationOverride = gen;
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
		provider.getDiffSummary = () => null;
		provider.reload();
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

	test("pre-reset stale pane: session_live:true is NOT mistaken for a current live agent", () => {
		setCurrentGeneration(provider, "rc.65");
		const stale = makeTerminalTmuxTask({
			status: "contract_failure",
			session_live: true,
			release_generation: "rc.64", // recreated by a later reset
		});
		const desc = rowDescription(provider, stale);
		expect(desc).toContain("stale (pre-release)");
		expect(desc).not.toContain("⚠ live · lifecycle conflict");
	});

	test("even a still-alive orphan pane (live probe) from a prior generation reads as stale, not live", () => {
		setCurrentGeneration(provider, "rc.65");
		const stale = makeTerminalTmuxTask({
			status: "contract_failure",
			release_generation: "rc.64",
		});
		mockInspectTmuxPaneById.mockImplementation(() => "alive");
		const desc = rowDescription(provider, stale);
		expect(desc).toContain("stale (pre-release)");
		expect(desc).not.toContain("lifecycle conflict");
	});

	test("post-release recreated terminal (current generation) keeps the live-attention badge", () => {
		setCurrentGeneration(provider, "rc.65");
		const current = makeTerminalTmuxTask({
			status: "contract_failure",
			session_live: true,
			release_generation: "rc.65",
		});
		const desc = rowDescription(provider, current);
		expect(desc).toContain("⚠ live · lifecycle conflict");
		expect(desc).not.toContain("stale (pre-release)");
	});

	test("grouping: superseded completed_dirty + session_live:true → limbo, not promoted to attention", () => {
		setCurrentGeneration(provider, "rc.65");
		const stale = makeTerminalTmuxTask({
			status: "completed_dirty",
			session_live: true,
			release_generation: "rc.64",
		});
		// Without supersession this would be promoted to attention (live conflict);
		// a pre-reset leftover must keep its plain terminal bucket instead.
		expect(groupOf(provider, stale)).toBe("limbo");
	});

	test("backward-compatible: no current generation known → nothing judged stale (pre-steer behavior)", () => {
		// Default override is null — the guard is inert and the lane behaves exactly
		// as it did before release hygiene was added.
		const task = makeTerminalTmuxTask({
			status: "contract_failure",
			session_live: true,
			release_generation: "rc.64",
		});
		const desc = rowDescription(provider, task);
		expect(desc).not.toContain("stale (pre-release)");
		expect(desc).toContain("⚠ live · lifecycle conflict");
	});
});
