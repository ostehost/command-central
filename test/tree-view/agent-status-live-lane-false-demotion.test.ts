/**
 * Live-lane false-demotion regressions
 *
 * Ways a *working* launcher lane was reported as finished — the first three
 * observed together on a single Symphony lane whose Ghostty/tmux pane was
 * visibly alive while Agent Status showed "Stale — no completion signal" /
 * "Agent process ended":
 *
 *  1. Pane-completion evidence matched the agent's OWN transcript prose
 *     (`exit 0`, `20/20 passed`, `✓`) and demoted a mid-turn lane.
 *  2. A pane probe inside the spawn handshake (row written 1-2s before the
 *     wrapper execs the CLI) read a bash-only process tree as "dead".
 *  3. The auto-refresh timer was gated on DISPLAY status, so the demotion
 *     switched off the very re-probe that would have corrected it.
 *
 * The rest guard the CORRECTION from overshooting: the turn cue must not
 * swallow a real completion boundary, outrank a visible input prompt, or leave
 * the aggregate stuck surfaces disagreeing with the row.
 *
 * Owns its own `tmux-pane-health` module mock: Bun's `mock.module` is
 * process-global, so a suite that relies on the real module is at the mercy of
 * whichever sibling file registered a shadow last.
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

const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");

// Keep real node:fs — a nonexistent stream_file must miss naturally so the
// lane reads as "no stream activity" exactly like the reported one.
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

// ── tmux-pane-health, driven per-test ────────────────────────────────────────
// The pure classifiers stay REAL: what is under test is how the provider
// combines pane evidence with a snippet, not the regexes themselves (those are
// covered in test/utils/agent-status-sections.test.ts).
const realPaneHealth =
	require("../../src/utils/tmux-pane-health.js") as typeof import("../../src/utils/tmux-pane-health.js");
let paneEvidence: "alive" | "dead" | "unknown" = "unknown";
let paneSnippet: string | null = null;
const mockInspectTmuxPaneById = mock(() => paneEvidence);
const mockInspectTmuxPaneAgent = mock(() => paneEvidence);
mock.module("../../src/utils/tmux-pane-health.js", () => ({
	...realPaneHealth,
	isTmuxPaneAgentAlive: mock(() => paneEvidence !== "dead"),
	inspectTmuxPaneAgent: mockInspectTmuxPaneAgent,
	inspectTmuxPaneById: mockInspectTmuxPaneById,
	capturePaneSnippet: mock(() => paneSnippet),
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
import type { TtlCache } from "../../src/utils/ttl-cache.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

AgentStatusTreeProvider.prototype.readRegistry = () => ({
	version: 2,
	tasks: {},
});

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

/**
 * A launcher lane shaped like the reported one: tmux-backed, pane-addressed,
 * and with NO stream JSONL — the condition that makes `isAgentStuck` true on
 * elapsed time alone once past the threshold.
 */
function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "live-lane",
		status: "running",
		project_dir: "/tmp/project",
		project_name: "project",
		session_id: "agent-project",
		tmux_session: "agent-project",
		tmux_window_id: "@5",
		tmux_pane_id: "%5",
		terminal_backend: "tmux",
		bundle_path: "",
		prompt_file: "",
		stream_file: null,
		started_at: new Date(Date.now() - 60 * 60_000).toISOString(),
		attempts: 1,
		max_attempts: 3,
		...overrides,
	};
}

const REPL_FOOTER =
	"  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent";

/** A mid-turn Claude pane that quotes exit codes, pass counts and checkmarks. */
const WORKING_TRANSCRIPT = [
	"⏺ Both suites pass through the symlinked checkout — 11/11 and 20/20.",
	"  [[ $rc -eq 1 ]] && exit 0   # fail-closed refusal",
	"  ✓ 4 passed, 0 failed · build complete · done in 2.1s",
	"✳ Manifesting… (16m 32s · ↓ 73.9k tokens)",
	"  (esc to interrupt)",
	"❯ ",
	REPL_FOOTER,
].join("\n");

describe("live-lane false-demotion regressions", () => {
	let provider: AgentStatusTreeProvider;

	beforeEach(() => {
		paneEvidence = "unknown";
		paneSnippet = null;
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[] | undefined];
			// Session AND window alive: the lane's terminal is up, so every
			// demotion below is attributable to the process/pane layer only.
			if (cmd === "tmux" && args?.includes("has-session")) return "";
			if (cmd === "tmux" && args?.includes("list-windows")) return "@5\n";
			// No commits since start → the last-resort tier lands on `stopped`
			// rather than `completed_dirty`.
			if (
				cmd === "git" &&
				args?.includes("rev-list") &&
				args?.includes("--count")
			) {
				return "0\n";
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
			get: mock((key: string, defaultValue?: unknown) => {
				if (key === "agentStatus.groupByProject") return false;
				if (key === "discovery.enabled") return false;
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

		provider = new AgentStatusTreeProvider({
			getIconForProject: mock(() => "🧩"),
			setCustomIcon: mock(() => Promise.resolve()),
		} as unknown as ConstructorParameters<typeof AgentStatusTreeProvider>[0]);
		provider.setReviewTracker(
			new InMemoryReviewTracker() as unknown as ReviewTracker,
		);
	});

	// `mock.restore()` does NOT undo `mock.module`, and the registration is
	// process-global, so leaving the shadow installed would let this suite decide
	// what every later provider file sees — with `paneEvidence` frozen at
	// whatever the last test set. Re-pin the real module on the way out.
	afterAll(() => {
		mock.module("../../src/utils/tmux-pane-health.js", () => realPaneHealth);
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

	function load(task: AgentTask): void {
		const registry: TaskRegistry = { version: 2, tasks: { [task.id]: task } };
		provider.readRegistry = () => registry;
		provider.getDiffSummary = () => null;
		provider.reload();
	}

	function seedSessionAlive(task: AgentTask): void {
		(
			provider as unknown as {
				tmuxLiveness: { sessionHealthCache: TtlCache<boolean> };
			}
		).tmuxLiveness.sessionHealthCache.set(
			`${task.tmux_socket ?? "__default__"}::${task.session_id}`,
			true,
		);
	}

	test("a working agent's own transcript prose does not demote the lane", () => {
		// The reported bug: past the 15-minute stuck threshold (no stream file),
		// a scrollback containing `exit 0` / `20/20` / `✓` matched the pane
		// completion heuristic and the live lane rendered
		// "Stale — no completion signal" while claude was mid-turn.
		const task = makeTask({ id: "lane-quoting-exit-codes" });
		paneEvidence = "alive";
		paneSnippet = WORKING_TRANSCRIPT;
		seedSessionAlive(task);
		load(task);

		expect(provider.getTasks()[0]?.status).toBe("running");
	});

	test("an idle REPL parked at its /exit prompt is still recognized as complete", () => {
		// The mid-turn veto must not swallow the real signal: a claude that
		// emitted READY_FOR_REVIEW keeps its process alive at the prompt, so
		// "alive" evidence alone cannot mean "still working".
		const task = makeTask({ id: "lane-parked-at-exit-prompt" });
		paneEvidence = "alive";
		paneSnippet = [
			"⏺ READY_FOR_REVIEW — handoff written.",
			"❯ ",
			REPL_FOOTER,
		].join("\n");
		seedSessionAlive(task);
		load(task);

		expect(provider.getTasks()[0]?.status).toBe("completed_stale");
	});

	test("a just-spawned lane whose wrapper has not exec'd the agent yet stays running", () => {
		// The launcher writes the running row ~1-2s before the wrapper execs the
		// CLI (and CC's watcher fires at 150ms). A probe inside that window walks
		// a bash-only tree and reports "dead", which flipped brand-new lanes to
		// "Agent process ended" on their very first render.
		const task = makeTask({
			id: "lane-mid-spawn",
			started_at: new Date(Date.now() - 2_000).toISOString(),
		});
		paneEvidence = "dead";
		seedSessionAlive(task);
		load(task);

		expect(provider.getTasks()[0]?.status).toBe("running");
	});

	test("past the spawn grace window, a pane with no agent is still reported stopped", () => {
		// Control: the grace window delays the verdict, it never suppresses it.
		const task = makeTask({
			id: "lane-genuinely-dead",
			started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
		});
		paneEvidence = "dead";
		seedSessionAlive(task);
		load(task);

		expect(provider.getTasks()[0]?.status).toBe("stopped");
	});

	test("a lane mid-turn is not badged as waiting on the human", () => {
		// The inverse of the stale-lane bug. This lane writes no stream JSONL, so
		// `isAgentStuck` fires purely on elapsed time — and because its pane
		// process is alive, the row was badged "(interactive)", i.e. waiting for
		// you to type. It was 22 minutes into an extended-thinking turn, with no
		// terminal window to type into.
		const task = makeTask({ id: "lane-mid-turn" });
		paneEvidence = "alive";
		paneSnippet = [
			"✻ Philosophising… (22m 41s · ↓ 100.6k tokens · thinking with xhigh effort)",
			"────────────────────────────────────────────",
			"❯ ",
			REPL_FOOTER,
		].join("\n");
		seedSessionAlive(task);
		load(task);

		const displayed = provider.getTasks()[0];
		expect(displayed?.status).toBe("running");
		if (!displayed) throw new Error("expected a displayed task");
		const description = String(
			provider.getTreeItem({ type: "task", task: displayed }).description ?? "",
		);
		expect(description).not.toContain("(interactive)");
		expect(description).not.toContain("(possibly stuck)");
	});

	test("a lane parked at an empty prompt keeps the honest (interactive) hint", () => {
		// Control: peeling out the mid-turn case must not erase the badge for a
		// lane that really is waiting.
		const task = makeTask({ id: "lane-parked" });
		paneEvidence = "alive";
		paneSnippet = ["⏺ Done — what next?", "❯ ", REPL_FOOTER].join("\n");
		seedSessionAlive(task);
		load(task);

		const displayed = provider.getTasks()[0];
		if (!displayed) throw new Error("expected a displayed task");
		expect(
			String(
				provider.getTreeItem({ type: "task", task: displayed }).description ??
					"",
			),
		).toContain("(interactive)");
	});

	test("a non-Claude lane's READY_FOR_REVIEW is not swallowed by the mid-turn veto", () => {
		// The veto must key on POSITIVE turn evidence, never on "alive but not a
		// provably idle REPL". Idle-REPL proof reads Claude's status footer, so
		// every non-Claude lane fails it by construction — vetoing on that would
		// discard a literal boundary marker for as long as the process lived,
		// stranding finished lanes in Live forever.
		const task = makeTask({ id: "lane-non-claude-review-ready" });
		paneEvidence = "alive";
		paneSnippet = [
			"codex> wrote the handoff and pushed the fix.",
			"READY_FOR_REVIEW",
			"user@host project %",
		].join("\n");
		seedSessionAlive(task);
		load(task);

		expect(provider.getTasks()[0]?.status).toBe("completed_stale");
	});

	test("a retained spinner with no positive liveness never claims work", async () => {
		// The row badge gates on stuck+alive, so the detail must too. With pane
		// inspection "unknown", a spinner left in the scrollback is not evidence
		// of a turn — reporting "Working" there contradicted the same row's
		// "(possibly stuck)" badge.
		const task = makeTask({ id: "lane-spinner-no-liveness" });
		paneEvidence = "unknown";
		paneSnippet = [
			"✻ Philosophising… (22m 41s · ↓ 100.6k tokens)",
			"❯ ",
			REPL_FOOTER,
		].join("\n");
		seedSessionAlive(task);
		load(task);

		const displayed = provider.getTasks()[0];
		if (!displayed) throw new Error("expected a displayed task");
		const labels = (
			await provider.getChildren({ type: "task", task: displayed })
		).map((node) => (node as { label?: string }).label ?? "");
		expect(labels).not.toContain("Working — turn in progress");
		expect(
			String(
				provider.getTreeItem({ type: "task", task: displayed }).description ??
					"",
			),
		).toContain("(possibly stuck)");
	});

	test("a spinner remnant does not veto a completion marker that came after it", () => {
		// The veto is decided by RECENCY, not by distance: a finished turn can
		// leave its spinner directly above its own READY_FOR_REVIEW. A tail
		// window would have vetoed here and stranded the lane in Live; only the
		// ordering of the two signals settles it.
		const task = makeTask({ id: "lane-spinner-then-marker" });
		paneEvidence = "alive";
		paneSnippet = [
			"✻ Philosophising… (1m 30s · ↓ 4.2k tokens)",
			"⏺ READY_FOR_REVIEW — handoff written.",
			"❯ ",
			REPL_FOOTER,
		].join("\n");
		seedSessionAlive(task);
		load(task);

		expect(provider.getTasks()[0]?.status).toBe("completed_stale");
	});

	test("a turn that resumed AFTER a quoted marker still vetoes the demotion", () => {
		// Control for the recency rule: the agent quoted the marker mid-turn and
		// is still working, so the later spinner must win.
		const task = makeTask({ id: "lane-marker-then-spinner" });
		paneEvidence = "alive";
		paneSnippet = [
			"⏺ Grepping for READY_FOR_REVIEW across the launcher…",
			"✻ Philosophising… (3m 12s · ↓ 9.1k tokens)",
			"❯ ",
			REPL_FOOTER,
		].join("\n");
		seedSessionAlive(task);
		load(task);

		expect(provider.getTasks()[0]?.status).toBe("running");
	});

	test("a visible permission prompt outranks a spinner still on screen", async () => {
		// `classifyPaneAttention` puts awaiting-user-input FIRST on purpose.
		// Reading the turn cue directly bypassed that: a lane blocked on a
		// question, with the spinner from the turn that ASKED it still rendered,
		// was reported as working and lost its awaiting-input surface — the
		// inverse of the bug this predicate exists to fix.
		const task = makeTask({ id: "lane-blocked-on-question" });
		paneEvidence = "alive";
		paneSnippet = [
			"✻ Philosophising… (2m 8s · ↓ 12.1k tokens)",
			"Do you want to proceed?",
			"❯ 1. Yes",
			"  2. No, keep the current approach",
			REPL_FOOTER,
		].join("\n");
		seedSessionAlive(task);
		load(task);

		const displayed = provider.getTasks()[0];
		if (!displayed) throw new Error("expected a displayed task");
		const labels = (
			await provider.getChildren({ type: "task", task: displayed })
		).map((node) => (node as { label?: string }).label ?? "");
		expect(labels).not.toContain("Working — turn in progress");
	});

	test("a mid-turn lane is not counted as stuck by the aggregate surfaces", () => {
		// The row said "Working — turn in progress" while the summary tooltip
		// still said "1 possibly stuck" and the dock could bounce. Every stuck
		// surface has to subtract the same lanes.
		const task = makeTask({ id: "lane-mid-turn-aggregate" });
		paneEvidence = "alive";
		paneSnippet = [
			"✻ Philosophising… (22m 41s · ↓ 100.6k tokens)",
			"❯ ",
			REPL_FOOTER,
		].join("\n");
		seedSessionAlive(task);
		load(task);

		const stuck = (
			provider as unknown as {
				getStuckRunningCount(tasks: AgentTask[]): number;
			}
		).getStuckRunningCount(provider.getTasks());
		expect(stuck).toBe(0);
	});

	test("spawn grace does not make a dead paused lane look parked", () => {
		// The grace models the running-row pre-exec handshake only. Paused lanes
		// share the death probe, and a paused-only registry keeps no refresh
		// timer, so leaking the grace could pin "parked" until an unrelated
		// refresh.
		const task = makeTask({
			id: "lane-paused-dead",
			status: "paused",
			started_at: new Date(Date.now() - 2_000).toISOString(),
		});
		paneEvidence = "dead";
		seedSessionAlive(task);
		load(task);

		const displayed = provider.getTasks()[0];
		if (!displayed) throw new Error("expected a displayed task");
		const description = String(
			provider.getTreeItem({ type: "task", task: displayed }).description ?? "",
		);
		expect(description).not.toContain("parked");
	});

	test("the auto-refresh timer survives a lane the overlay demoted", () => {
		// Gating the timer on DISPLAY status let one bad verdict switch off its
		// own correction: the only running lane was overlaid to stopped, the
		// timer was cleared, and the wrong state froze until the registry file
		// changed. The registry still says running, so re-probing must continue.
		const task = makeTask({
			id: "demoted-but-registry-running",
			started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
		});
		paneEvidence = "dead";
		seedSessionAlive(task);
		load(task);

		expect(provider.getTasks()[0]?.status).toBe("stopped");
		expect(
			(provider as unknown as { autoRefreshTimer: unknown }).autoRefreshTimer,
		).not.toBeNull();
	});
});
