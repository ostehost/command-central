/**
 * Current/Live surface + detached-classification tests
 * (cc-current-running-surface-fix-20260613)
 *
 * Doctrine (Agent Status V2): a registry-`running` lane must appear in the
 * Live/Current surface — never in "Failed & Stopped" — when its session is
 * still alive or its liveness simply cannot be confirmed. "detached" (no
 * session_key / callback_url) is a *visibility* badge, not a lifecycle state,
 * and must not move a running lane out of the live surface. History is always
 * preserved: completed / failed / stale lanes stay visible and grouped.
 *
 * These tests pin the classification layer that V2 builds on:
 *   • running + detached + live session → status stays `running`, groups under
 *     "running" (Current · Live), and completion routing reports "detached"
 *   • node-origin running lane whose host can't be verified locally → never
 *     demoted by a local probe (host-authority gate)
 *   • a session POSITIVELY confirmed dead still demotes (the gate does not
 *     keep zombie lanes alive)
 *   • completed / failed history remains visible and correctly grouped
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");

// Keep node:fs real so missing stream files fail-open naturally.
const fs = require("node:fs") as typeof import("node:fs");
mock.module("node:fs", () => fs);

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

// Tri-state pane inspector. Default "unknown" (fail-open) — the lane's liveness
// is unconfirmable, which is exactly the detached case under test.
const mockIsTmuxPaneAgentAlive = mock(() => true);
const mockInspectTmuxPaneAgent = mock(
	() => "unknown" as "alive" | "dead" | "unknown",
);
mock.module("../../src/utils/tmux-pane-health.js", () => ({
	isTmuxPaneAgentAlive: mockIsTmuxPaneAgentAlive,
	inspectTmuxPaneAgent: mockInspectTmuxPaneAgent,
	// CCSYNC-03 (PAR-228): behavior-neutral stubs for the live-pane classifier
	// the provider now imports (never benign → no grouping change here).
	capturePaneSnippet: mock((_target: string, _socket?: string | null) => null),
	classifyPaneAttention: mock(() => "unknown" as const),
	isBenignLivePane: mock((_state: string) => false),
}));

mock.module("../../src/utils/port-detector.js", () => ({
	detectListeningPorts: mock(() => []),
	detectListeningPortsAsync: mock(async () => []),
}));

import {
	type AgentNode,
	type AgentStatusGroup,
	AgentStatusTreeProvider,
	type AgentTask,
	classifyCompletionRouting,
	isLivenessUnobservableRunningLane,
	type TaskRegistry,
} from "../../src/providers/agent-status-tree-provider.js";
import { __setCurrentMachineHostOverrideForTests } from "../../src/providers/agent-task-classification.js";
import type { ReviewTracker } from "../../src/services/review-tracker.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

AgentStatusTreeProvider.prototype.readRegistry = () => makeRegistry({});

function makeRegistry(tasks: Record<string, AgentTask> = {}): TaskRegistry {
	return { version: 2, tasks };
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "surface-test-task",
		status: "running",
		project_dir: "/tmp/project",
		project_name: "project",
		session_id: "agent-surface-test",
		tmux_session: "agent-surface-test",
		bundle_path: "",
		prompt_file: "",
		started_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
		attempts: 1,
		max_attempts: 3,
		terminal_backend: "tmux",
		...overrides,
	};
}

function sessionCacheKey(
	task: Pick<AgentTask, "session_id" | "tmux_socket">,
): string {
	return `${task.tmux_socket ?? "__default__"}::${task.session_id}`;
}

function seedSession(
	provider: AgentStatusTreeProvider,
	task: AgentTask,
	alive: boolean,
): void {
	(
		provider as unknown as {
			_tmuxSessionHealthCache: Map<
				string,
				{ alive: boolean; checkedAt: number }
			>;
		}
	)._tmuxSessionHealthCache.set(sessionCacheKey(task), {
		alive,
		checkedAt: Date.now(),
	});
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

function displayTask(
	provider: AgentStatusTreeProvider,
	id: string,
): AgentTask | undefined {
	return provider.getTasks().find((task) => task.id === id);
}

function taskItemFor(
	provider: AgentStatusTreeProvider,
	id: string,
): import("vscode").TreeItem {
	const node = provider
		.getChildren()
		.find(
			(child): child is Extract<AgentNode, { type: "task" }> =>
				child.type === "task" && child.task.id === id,
		);
	if (!node) throw new Error(`task node ${id} not found in getChildren()`);
	return provider.getTreeItem(node);
}

function iconIdOf(item: import("vscode").TreeItem): string | undefined {
	return (item.iconPath as { id?: string } | undefined)?.id;
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

describe("Agent Status — Current/Live surface & detached classification", () => {
	let provider: AgentStatusTreeProvider;

	beforeEach(() => {
		mock.restore();
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[] | undefined];
			if (cmd === "tmux" && args?.includes("has-session")) return "";
			if (cmd === "git") return "";
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
		mockIsTmuxPaneAgentAlive.mockImplementation(() => true);
		mockInspectTmuxPaneAgent.mockImplementation(() => "unknown");

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
		mockInspectTmuxPaneAgent.mockImplementation(() => "unknown");
		mockIsTmuxPaneAgentAlive.mockImplementation(() => true);
	});

	test("running + detached lane with a live session stays in Current/Live, not Failed & Stopped", () => {
		// The screenshot regression: a launcher lane reported `running` with a live
		// tmux session but no session_key/callback_url ("detached") was landing in
		// "Failed & Stopped". It must instead stay `running` and group under the
		// Live/Current surface; "detached" is only a visibility badge.
		const task = makeTask({ id: "running-detached" });
		seedSession(provider, task, true);
		mockInspectTmuxPaneAgent.mockImplementation(() => "unknown");

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		const displayed = displayTask(provider, task.id);
		expect(displayed?.status).toBe("running");
		expect(groupOf(provider, displayed as AgentTask)).toBe("running");
		// "detached" is a completion-routing/visibility classification, not a
		// lifecycle state — it must coexist with a `running` status.
		expect(classifyCompletionRouting(displayed as AgentTask).kind).toBe(
			"detached",
		);
	});

	test("node-origin running lane whose host can't be verified is never demoted by a local probe", () => {
		// A node/spoke lane carries node-execution metadata but no resolvable
		// exec_host. A local tmux probe that cannot see the session here is NOT
		// evidence the lane died on the machine that ran it — host-authority keeps
		// it in the live surface (mirrors isLocalFileProbeAuthoritative).
		const task = makeTask({
			id: "node-origin-running",
			exec_mode: "spoke",
		});
		// Local session probe reports dead — but it is not authoritative for a
		// node-origin task.
		seedSession(provider, task, false);

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		const displayed = displayTask(provider, task.id);
		expect(displayed?.status).toBe("running");
		expect(groupOf(provider, displayed as AgentTask)).toBe("running");
	});

	test("a session positively confirmed dead still demotes out of Current/Live", () => {
		// Guard against the gate over-keeping zombie lanes: a plain local lane whose
		// tmux session is confirmed dead must leave the running surface.
		const task = makeTask({
			id: "confirmed-dead",
			// Recent start so the stuck/stale timer does not pre-empt with a
			// completed_stale overlay — we want the synchronous stopped demotion.
			started_at: new Date(Date.now() - 60_000).toISOString(),
		});
		seedSession(provider, task, false);

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		const displayed = displayTask(provider, task.id);
		expect(displayed?.status).not.toBe("running");
		expect(groupOf(provider, displayed as AgentTask)).not.toBe("running");
	});

	test("completed and failed history stays visible and correctly grouped", () => {
		// Doctrine: never hide/drop history. A live lane plus completed/failed
		// history must all remain present and land in their respective groups.
		const live = makeTask({ id: "hist-live", status: "running" });
		seedSession(provider, live, true);
		const done = makeTask({
			id: "hist-completed",
			status: "completed",
			session_id: "agent-done",
			tmux_session: "agent-done",
			exit_code: 0,
			completed_at: new Date(Date.now() - 30 * 60_000).toISOString(),
		});
		const failed = makeTask({
			id: "hist-failed",
			status: "failed",
			session_id: "agent-failed",
			tmux_session: "agent-failed",
			exit_code: 1,
			completed_at: new Date(Date.now() - 45 * 60_000).toISOString(),
		});

		provider.readRegistry = () =>
			makeRegistry({
				[live.id]: live,
				[done.id]: done,
				[failed.id]: failed,
			});
		provider.reload();

		const ids = new Set(provider.getTasks().map((task) => task.id));
		expect(ids.has("hist-live")).toBe(true);
		expect(ids.has("hist-completed")).toBe(true);
		expect(ids.has("hist-failed")).toBe(true);

		expect(
			groupOf(provider, displayTask(provider, "hist-live") as AgentTask),
		).toBe("running");
		expect(
			groupOf(provider, displayTask(provider, "hist-completed") as AgentTask),
		).toBe("done");
		expect(
			groupOf(provider, displayTask(provider, "hist-failed") as AgentTask),
		).toBe("attention");
	});
});

/**
 * Liveness-unobservable running lanes (cc-installed-vsix-dogfood-proof-20260614).
 *
 * A `running` lane CC cannot prove is doing live work must NOT render the
 * animated `sync~spin` spinner. Two truth sources feed
 * {@link isLivenessUnobservableRunningLane}: explicit launcher attach/visibility
 * evidence projected on the `lane_ref_update` envelope (task 3 — CC consuming
 * the launcher's own probe), and the structural fallback of a session-less
 * Work System projection row with nothing to probe (task 2 — local truth).
 * "Detached" here is a visibility badge, not a lifecycle state: status stays
 * `running`. Remote-node lanes are deliberately fail-open (never flipped).
 */
describe("isLivenessUnobservableRunningLane (pure classifier)", () => {
	afterEach(() => {
		__setCurrentMachineHostOverrideForTests(null);
	});

	test("session-less Work System projection running lane → unobservable", () => {
		expect(
			isLivenessUnobservableRunningLane(
				makeTask({
					lane_projection: true,
					// laneRefUpdateToTaskRecord falls a session-less envelope back to
					// `launcher:<task_id>`, which fails isValidSessionId by construction.
					session_id: "launcher:proj-task",
				}),
			),
		).toBe(true);
	});

	test("launcher attach.available === false → unobservable (no attachable terminal)", () => {
		expect(
			isLivenessUnobservableRunningLane(
				makeTask({
					session_id: "agent-valid-session",
					launcher_attach_available: false,
					launcher_attach_reason: "tmux-session-not-found",
				}),
			),
		).toBe(true);
	});

	test("launcher visibility.degraded === true → unobservable (visible lane failed verification)", () => {
		expect(
			isLivenessUnobservableRunningLane(
				makeTask({
					session_id: "agent-valid-session",
					launcher_visibility_degraded: true,
					launcher_visibility_reason:
						"ax_error_osascript_is_not_allowed_assistive_access",
				}),
			),
		).toBe(true);
	});

	test("ordinary session-backed running lane → observable (keeps spinner)", () => {
		expect(
			isLivenessUnobservableRunningLane(
				makeTask({ session_id: "agent-valid-session" }),
			),
		).toBe(false);
	});

	test("projection lane WITH a real session → observable (there is a channel to probe)", () => {
		expect(
			isLivenessUnobservableRunningLane(
				makeTask({
					lane_projection: true,
					session_id: "agent-real-session",
				}),
			),
		).toBe(false);
	});

	test("confirmed-remote session-less projection lane → observable (remote fail-open)", () => {
		__setCurrentMachineHostOverrideForTests("hub-machine");
		expect(
			isLivenessUnobservableRunningLane(
				makeTask({
					lane_projection: true,
					session_id: "launcher:remote-proj",
					exec_mode: "node",
					exec_host: "some-other-node",
				}),
			),
		).toBe(false);
	});

	test("non-running status is never unobservable", () => {
		expect(
			isLivenessUnobservableRunningLane(
				makeTask({
					status: "completed",
					lane_projection: true,
					session_id: "launcher:proj-task",
				}),
			),
		).toBe(false);
	});
});

describe("Agent Status — liveness-unobservable rendering", () => {
	let provider: AgentStatusTreeProvider;

	beforeEach(() => {
		mock.restore();
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[] | undefined];
			if (cmd === "tmux" && args?.includes("has-session")) return "";
			if (cmd === "git") return "";
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
		mockIsTmuxPaneAgentAlive.mockImplementation(() => true);
		// "unknown" pane evidence: CC cannot positively confirm liveness, which is
		// exactly when the structural/launcher signals must decide the visual.
		mockInspectTmuxPaneAgent.mockImplementation(() => "unknown");

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
		mockInspectTmuxPaneAgent.mockImplementation(() => "unknown");
		mockIsTmuxPaneAgentAlive.mockImplementation(() => true);
	});

	test("session-less projection running lane renders debug-disconnect, not the spinner", () => {
		const task = makeTask({
			id: "render-projection-sessionless",
			lane_projection: true,
			session_id: "launcher:render-projection-sessionless",
			// Recent start so the stale/stuck timer does not pre-empt with a
			// completed_stale overlay — we want the live `running` render path.
			started_at: new Date().toISOString(),
		});
		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		expect(displayTask(provider, task.id)?.status).toBe("running");
		const item = taskItemFor(provider, task.id);
		expect(iconIdOf(item)).toBe("debug-disconnect");
		expect(iconIdOf(item)).not.toBe("sync~spin");
		expect(String(item.description ?? "")).toContain("(detached)");
	});

	test("launcher-projected attach.available === false flips the spinner to detached", () => {
		const task = makeTask({
			id: "render-attach-unavailable",
			lane_projection: true,
			session_id: "agent-render-attach-unavailable",
			tmux_session: "agent-render-attach-unavailable",
			launcher_attach_available: false,
			launcher_attach_reason: "tmux-session-not-found",
			started_at: new Date().toISOString(),
		});
		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		expect(displayTask(provider, task.id)?.status).toBe("running");
		const item = taskItemFor(provider, task.id);
		expect(iconIdOf(item)).toBe("debug-disconnect");
		expect(String(item.description ?? "")).toContain("(detached)");
	});

	test("ordinary running lane with unknown pane evidence keeps the spinner (no regression)", () => {
		const task = makeTask({
			id: "render-ordinary-running",
			session_id: "agent-render-ordinary-running",
			tmux_session: "agent-render-ordinary-running",
			started_at: new Date().toISOString(),
		});
		seedSession(provider, task, true);
		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		expect(displayTask(provider, task.id)?.status).toBe("running");
		const item = taskItemFor(provider, task.id);
		expect(iconIdOf(item)).toBe("sync~spin");
		expect(String(item.description ?? "")).not.toContain("(detached)");
	});
});
