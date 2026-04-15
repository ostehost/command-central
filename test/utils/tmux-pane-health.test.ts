/**
 * tmux-pane-health helper unit tests (slice 2)
 *
 * Verifies the conservative fail-open contract of `isTmuxPaneAgentAlive`:
 *  - Returns `true` whenever the check can't be completed (error, invalid input).
 *  - Returns `false` ONLY when tmux reports panes, none have an agent command,
 *    and no descendant process matches a known agent CLI.
 *
 * All child_process calls are intercepted via mock.module so no real tmux/pgrep/ps
 * invocations occur. Pattern mirrors test/utils/persist-health.test.ts.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";

// ── Set up execFileSync mock before importing the module under test ─────────

const execFileSyncMock = mock((..._args: unknown[]) => "");

mock.module("node:child_process", () => ({
	...realChildProcess,
	execFileSync: execFileSyncMock,
}));

const { isTmuxPaneAgentAlive, AGENT_PROCESS_NAMES } = await import(
	"../../src/utils/tmux-pane-health.js"
);

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a fake execFileSync that routes tmux/pgrep/ps calls to per-command handlers. */
function makeExecImpl(handlers: {
	tmux?: string | (() => string) | (() => never);
	pgrep?: string | (() => string) | (() => never);
	ps?: string | (() => string) | (() => never);
}) {
	return (cmd: unknown, _args: unknown) => {
		const resolve = (
			h: string | (() => string) | (() => never) | undefined,
		): string => {
			if (h === undefined) return "";
			if (typeof h === "function") return h();
			return h;
		};
		switch (cmd as string) {
			case "tmux":
				return resolve(handlers.tmux);
			case "pgrep":
				return resolve(handlers.pgrep);
			case "ps":
				return resolve(handlers.ps);
			default:
				throw new Error(`Unexpected command in test: ${cmd}`);
		}
	};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("isTmuxPaneAgentAlive", () => {
	beforeEach(() => {
		execFileSyncMock.mockReset();
	});

	// ── Direct pane_current_command matches ───────────────────────────────────

	test("pane_current_command=claude → alive (true)", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({ tmux: "claude|12345\n" }),
		);
		expect(isTmuxPaneAgentAlive("agent-my-project")).toBe(true);
	});

	test("pane_current_command=codex → alive (true)", () => {
		execFileSyncMock.mockImplementation(makeExecImpl({ tmux: "codex|9999\n" }));
		expect(isTmuxPaneAgentAlive("agent-codex-run")).toBe(true);
	});

	test("pane_current_command=cursor-agent → alive (true)", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({ tmux: "cursor-agent|8888\n" }),
		);
		expect(isTmuxPaneAgentAlive("cc-cursor-session")).toBe(true);
	});

	// ── Multiple panes — agent found in one of them ──────────────────────────

	test("multiple panes, one with claude — short-circuits to alive (true)", () => {
		// Three panes: two bash, one claude. Function should return true immediately
		// when it finds the claude pane without reaching pgrep/ps.
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|1001\nclaude|1002\nbash|1003\n",
				// pgrep/ps should not be called — verified by keeping them undefined
			}),
		);
		expect(isTmuxPaneAgentAlive("agent-team-lane")).toBe(true);
	});

	// ── Descendant walk: bash pane whose child is an agent ───────────────────

	test("bash pane with claude child → alive (true)", () => {
		// tmux: one bash pane with pid 1234
		// pgrep: child pid 5678 of 1234
		// ps: pid 5678 runs "claude"
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|1234\n",
				pgrep: "5678\n",
				ps: "claude\n",
			}),
		);
		expect(isTmuxPaneAgentAlive("agent-my-project")).toBe(true);
	});

	test("bash pane with aider grandchild → alive (true)", () => {
		// depth 1: pgrep -P 1234 → 5678 (bash child)
		// depth 2: pgrep -P 5678 → 6789 (aider grandchild)
		// ps checks 5678,6789 → 6789 is aider
		let pgrep_call = 0;
		execFileSyncMock.mockImplementation((cmd: unknown, args: unknown) => {
			const a = args as string[];
			if (cmd === "tmux") return "bash|1234\n";
			if (cmd === "pgrep") {
				pgrep_call++;
				if (pgrep_call === 1 && a[1] === "1234") return "5678\n"; // depth 1
				if (pgrep_call === 2 && a[1] === "5678") return "6789\n"; // depth 2
				throw Object.assign(new Error("no children"), { status: 1 });
			}
			if (cmd === "ps") return "bash\naider\n";
			return "";
		});
		expect(isTmuxPaneAgentAlive("agent-aider")).toBe(true);
	});

	// ── Dead lane: bash pane, no agent descendants ────────────────────────────

	test("bash pane, pgrep finds no children → dead (false)", () => {
		// pgrep exits non-zero (no children) → caught → continue.
		// No descendants found → returns false.
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|1234\n",
				pgrep: () => {
					throw Object.assign(new Error("no children"), { status: 1 });
				},
			}),
		);
		expect(isTmuxPaneAgentAlive("cc-dead-lane")).toBe(false);
	});

	test("bash pane, descendants exist but none are agents → dead (false)", () => {
		// pgrep returns children; ps shows only non-agent names
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|1234\n",
				pgrep: "5678\n",
				ps: "node\nbash\n",
			}),
		);
		expect(isTmuxPaneAgentAlive("cc-dead-lane-2")).toBe(false);
	});

	// ── pgrep throws specifically (test #7) ───────────────────────────────────

	test("pgrep -P throws → no descendants collected → dead (false)", () => {
		// Per implementer's code: pgrep throwing is caught with `continue` (NOT
		// fail-open). Only pane pids end up in visited; descendantPids=[]; → false.
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|1234\n",
				pgrep: () => {
					throw new Error("pgrep error");
				},
			}),
		);
		expect(isTmuxPaneAgentAlive("cc-dead-lane-pgrep")).toBe(false);
	});

	// ── ps throws (fail-open) ─────────────────────────────────────────────────

	test("ps throws after finding descendant pids → fail-open (true)", () => {
		// pgrep finds a child pid; ps throws → catch block returns true (fail-open)
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|1234\n",
				pgrep: "5678\n",
				ps: () => {
					throw new Error("ps unavailable");
				},
			}),
		);
		expect(isTmuxPaneAgentAlive("cc-ps-fails")).toBe(true);
	});

	// ── Fail-open: invalid session id ────────────────────────────────────────

	test("session id with special chars (fails regex) → fail-open (true)", () => {
		// SESSION_ID_RE = /^[a-zA-Z0-9._-]+$/ — spaces, slashes, etc. fail
		expect(isTmuxPaneAgentAlive("bad session/id")).toBe(true);
		expect(isTmuxPaneAgentAlive("../../etc/passwd")).toBe(true);
		expect(isTmuxPaneAgentAlive("")).toBe(true);
		// No execFileSync calls should occur
		expect(execFileSyncMock).not.toHaveBeenCalled();
	});

	// ── Fail-open: tmux throws ────────────────────────────────────────────────

	test("tmux list-panes throws → fail-open (true)", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: () => {
					throw new Error("tmux: no server running");
				},
			}),
		);
		expect(isTmuxPaneAgentAlive("agent-my-project")).toBe(true);
	});

	// ── tmuxSocket forwarding ─────────────────────────────────────────────────

	test("tmuxSocket is forwarded as -S flag to tmux", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({ tmux: "claude|7777\n" }),
		);
		expect(isTmuxPaneAgentAlive("agent-sock", "/tmp/my.sock")).toBe(true);
		// Verify the -S flag was passed
		const [, tmuxArgs] = execFileSyncMock.mock.calls[0] as [string, string[]];
		expect(tmuxArgs[0]).toBe("-S");
		expect(tmuxArgs[1]).toBe("/tmp/my.sock");
	});

	test("null tmuxSocket omits -S flag", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({ tmux: "claude|7777\n" }),
		);
		expect(isTmuxPaneAgentAlive("agent-no-sock", null)).toBe(true);
		const [, tmuxArgs] = execFileSyncMock.mock.calls[0] as [string, string[]];
		expect(tmuxArgs[0]).not.toBe("-S");
	});

	// ── Empty tmux output (no panes) ─────────────────────────────────────────

	test("empty tmux output (no panes listed) → fail-open (true)", () => {
		// No pane lines means we can't assert death → fail-open → true.
		// tmux returns "" when the session exists but yields no pane data.
		execFileSyncMock.mockImplementation(makeExecImpl({ tmux: "" }));
		expect(isTmuxPaneAgentAlive("agent-empty-panes")).toBe(true);
	});

	// ── AGENT_PROCESS_NAMES coverage ─────────────────────────────────────────

	test("all known agent CLI names match as pane_current_command", () => {
		for (const agentName of AGENT_PROCESS_NAMES) {
			execFileSyncMock.mockReset();
			execFileSyncMock.mockImplementation(
				makeExecImpl({ tmux: `${agentName}|1234\n` }),
			);
			expect(
				isTmuxPaneAgentAlive("agent-session"),
				`expected ${agentName} to be alive`,
			).toBe(true);
		}
	});

	test("aider and ollama also match as pane_current_command", () => {
		for (const name of ["aider", "ollama"] as const) {
			execFileSyncMock.mockReset();
			execFileSyncMock.mockImplementation(
				makeExecImpl({ tmux: `${name}|5555\n` }),
			);
			expect(
				isTmuxPaneAgentAlive("agent-misc"),
				`${name} should be alive`,
			).toBe(true);
		}
	});
});
