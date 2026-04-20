/**
 * Launcher-managed interactive Claude visibility (regression guard)
 *
 * Headline regression: a launcher-managed tmux task running interactive Claude
 * (no -p flag, no JSONL stream activity) was vanishing from the running view
 * because:
 *   1. `isAgentStuck` fired on stale stream → `looksStale = true`
 *   2. `isRunningTaskHealthy` returned `!looksStale` for tmux backends, so a
 *      live-but-quiet pane got downgraded to "stopped".
 *
 * The fix introduces a tri-state pane inspector (`inspectTmuxPaneAgent`) and
 * makes positive pane evidence ("alive") authoritative for launcher-managed
 * tmux work — the lane stays visible as `running` with an honest "(interactive)"
 * hint instead of being misreported as "(possibly stuck)" or disappearing.
 *
 * These tests pin the behaviour:
 *   • positive pane evidence + stale stream → `running` with "(interactive)"
 *   • "unknown" pane evidence + stale stream → downgraded (status leaves running)
 *   • positive pane evidence + fresh stream → `running` with no hint
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");

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

// Tri-state pane inspector. Default: "unknown" (fail-open). Per-test override
// to "alive"/"dead" exercises the launcher-truth path.
const mockIsTmuxPaneAgentAlive = mock(() => true);
const mockInspectTmuxPaneAgent = mock(
	() => "unknown" as "alive" | "dead" | "unknown",
);
mock.module("../../src/utils/tmux-pane-health.js", () => ({
	isTmuxPaneAgentAlive: mockIsTmuxPaneAgentAlive,
	inspectTmuxPaneAgent: mockInspectTmuxPaneAgent,
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
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

AgentStatusTreeProvider.prototype.readRegistry = () => makeRegistry({});

function makeRegistry(tasks: Record<string, AgentTask> = {}): TaskRegistry {
	return { version: 2, tasks };
}

/**
 * Build a launcher-managed tmux task that's been running for a couple hours.
 * Stale beyond the default staleThresholdMs (60 min) so `isAgentStuck` fires.
 */
function makeLauncherTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "launcher-interactive-claude",
		status: "running",
		project_dir: "/tmp/project",
		project_name: "project",
		session_id: "agent-my-project",
		tmux_session: "agent-my-project",
		bundle_path: "",
		prompt_file: "",
		started_at: new Date(Date.now() - 120 * 60_000).toISOString(),
		attempts: 1,
		max_attempts: 3,
		terminal_backend: "tmux",
		...overrides,
	};
}

function healthCacheKey(
	task: Pick<AgentTask, "session_id" | "tmux_socket">,
): string {
	return `${task.tmux_socket ?? "__default__"}::${task.session_id}`;
}

function seedSessionAlive(
	provider: AgentStatusTreeProvider,
	task: AgentTask,
): void {
	(
		provider as unknown as {
			_tmuxSessionHealthCache: Map<
				string,
				{ alive: boolean; checkedAt: number }
			>;
		}
	)._tmuxSessionHealthCache.set(healthCacheKey(task), {
		alive: true,
		checkedAt: Date.now(),
	});
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

describe("launcher-managed interactive Claude visibility (regression guard)", () => {
	let provider: AgentStatusTreeProvider;

	beforeEach(() => {
		mock.restore();
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[] | undefined];
			if (cmd === "tmux" && args?.includes("has-session")) return "";
			if (
				cmd === "openclaw" &&
				args?.[0] === "tasks" &&
				args[1] === "audit" &&
				args[2] === "--json"
			) {
				return JSON.stringify({
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
		// Reset module-level mocks back to safe defaults — bun:test keeps
		// `mock.module` registrations alive across files, so leaving "alive"
		// here would corrupt other test files that import tmux-pane-health.
		mockIsTmuxPaneAgentAlive.mockImplementation(() => true);
		mockInspectTmuxPaneAgent.mockImplementation(() => "unknown");
	});

	test("positive pane evidence + stale stream → stays running with (interactive) hint", () => {
		// The headline regression: an interactive Claude lane in a launcher-managed
		// tmux session gets no JSONL writes for a long REPL turn. `isAgentStuck` fires
		// on the silent stream, but positive pane evidence ("alive") proves the lane
		// is still live. Status MUST stay "running" and the description MUST surface
		// the honest "(interactive)" hint instead of "(possibly stuck)".
		const task = makeLauncherTask({
			id: "interactive-claude-alive",
			stream_file: "/nonexistent/path/to/stream.jsonl",
		});
		seedSessionAlive(provider, task);
		mockInspectTmuxPaneAgent.mockImplementation(() => "alive");

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		const displayed = provider.getTasks()[0];
		expect(displayed?.status).toBe("running");

		const taskNode = provider
			.getChildren()
			.find((n) => n.type === "task" && n.task.id === task.id);
		if (!taskNode) throw new Error("task node missing from getChildren()");
		const item = provider.getTreeItem(taskNode);
		const description = String(item.description ?? "");
		expect(description).toContain("(interactive)");
		expect(description).not.toContain("(possibly stuck)");
	});

	test("unknown pane evidence + stale stream → downgraded out of running", () => {
		// Counterpoint: with no positive evidence (e.g. tmux unavailable, malformed
		// output), the existing fail-open + staleness path still applies. Status
		// leaves "running" — proves the "alive" branch above is doing real work and
		// not just suppressing every downgrade.
		const task = makeLauncherTask({
			id: "interactive-claude-unknown",
			stream_file: "/nonexistent/path/to/stream.jsonl",
		});
		seedSessionAlive(provider, task);
		mockInspectTmuxPaneAgent.mockImplementation(() => "unknown");

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		const displayed = provider.getTasks()[0];
		expect(displayed?.status).not.toBe("running");
	});

	test("dead pane evidence → drops out of running ('dead' evidence overrides silence)", () => {
		// Sanity: positive evidence wins over silence, but explicit "dead" evidence
		// drops the task out of running. The exact terminal status depends on the
		// stale-transition path (completed_stale vs stopped) — what matters here is
		// that the task is no longer counted as running.
		const task = makeLauncherTask({
			id: "interactive-claude-dead",
			stream_file: "/nonexistent/path/to/stream.jsonl",
		});
		seedSessionAlive(provider, task);
		mockIsTmuxPaneAgentAlive.mockImplementation(() => false);
		mockInspectTmuxPaneAgent.mockImplementation(() => "dead");

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		expect(provider.getTasks()[0]?.status).not.toBe("running");
	});

	test("positive pane evidence with non-stale started_at → no (interactive) hint", () => {
		// When the lane isn't even old enough for the stuck heuristic to fire,
		// there's nothing to suppress and no honest hint to add — description stays
		// clean. Guards against accidentally tagging every healthy lane as
		// (interactive).
		const task = makeLauncherTask({
			id: "interactive-claude-fresh",
			started_at: new Date(Date.now() - 2 * 60_000).toISOString(),
			stream_file: "/nonexistent/path/to/stream.jsonl",
		});
		seedSessionAlive(provider, task);
		mockInspectTmuxPaneAgent.mockImplementation(() => "alive");

		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		expect(provider.getTasks()[0]?.status).toBe("running");
		const taskNode = provider
			.getChildren()
			.find((n) => n.type === "task" && n.task.id === task.id);
		if (!taskNode) throw new Error("task node missing from getChildren()");
		const item = provider.getTreeItem(taskNode);
		const description = String(item.description ?? "");
		expect(description).not.toContain("(interactive)");
		expect(description).not.toContain("(possibly stuck)");
	});
});
