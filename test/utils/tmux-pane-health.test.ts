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

const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");

// ── Set up execFileSync mock before importing the module under test ─────────

const execFileSyncMock = mock((..._args: unknown[]) => "");

mock.module("node:child_process", () => ({
	...realChildProcess,
	execFileSync: execFileSyncMock,
}));

const {
	isTmuxPaneAgentAlive,
	inspectTmuxPaneAgent,
	inspectTmuxPaneById,
	AGENT_PROCESS_NAMES,
	PANE_ID_RE,
} = await import("../../src/utils/tmux-pane-health.js");

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
				if (pgrep_call === 1 && a[a.indexOf("-P") + 1] === "1234")
					return "5678\n"; // depth 1
				if (pgrep_call === 2 && a[a.indexOf("-P") + 1] === "5678")
					return "6789\n"; // depth 2
				throw Object.assign(new Error("no children"), { status: 1 });
			}
			if (cmd === "ps") return "bash\naider\n";
			return "";
		});
		expect(isTmuxPaneAgentAlive("agent-aider")).toBe(true);
	});

	test("descendant walk passes -a so pgrep does not exclude the probe's own ancestors", () => {
		// BSD/macOS pgrep silently omits the calling process and ALL of its
		// ancestors from matches. Without -a, an extension host running as a
		// descendant of the observed lane (installed-VSIX proof harness, VS Code
		// launched from an agent terminal) gets a clean "no children" exit for
		// its own ancestor chain and falsely reports a live lane as dead.
		const pgrepArgs: string[][] = [];
		execFileSyncMock.mockImplementation((cmd: unknown, args: unknown) => {
			if (cmd === "tmux") return "bash|1234\n";
			if (cmd === "pgrep") {
				pgrepArgs.push([...(args as string[])]);
				throw Object.assign(new Error("no children"), { status: 1 });
			}
			return "";
		});
		expect(inspectTmuxPaneAgent("agent-ancestor-probe")).toBe("dead");
		expect(pgrepArgs.length).toBeGreaterThan(0);
		for (const args of pgrepArgs) {
			expect(args).toContain("-a");
		}
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

	// ── pgrep transient failure must fail-open ───────────────────────────────

	test("pgrep -P throws without status=1 → fail-open (true)", () => {
		// Regression: a transient pgrep error (timeout, signal kill, fatal exit)
		// was previously treated identically to "exit code 1 / no children" and
		// the pane was classified dead. That flipped a live tmux pane's Agent
		// Status to "Agent process ended" on a probe race and back to running
		// on the next refresh. Only pgrep exit status === 1 is proof of "no
		// children"; everything else is ambiguous and must fail-open.
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|1234\n",
				pgrep: () => {
					throw new Error("pgrep error");
				},
			}),
		);
		expect(isTmuxPaneAgentAlive("cc-pgrep-transient")).toBe(true);
	});

	test("pgrep -P killed by signal (status null) → fail-open (true)", () => {
		// `execFileSync` with the `timeout` option SIGTERMs the child and the
		// thrown error has `status: null`. Must be treated as ambiguous.
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|1234\n",
				pgrep: () => {
					throw Object.assign(new Error("ETIMEDOUT"), { status: null });
				},
			}),
		);
		expect(isTmuxPaneAgentAlive("cc-pgrep-timeout")).toBe(true);
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

describe("inspectTmuxPaneAgent (tri-state evidence)", () => {
	beforeEach(() => {
		execFileSyncMock.mockReset();
	});

	test("returns 'alive' when pane_current_command is an agent (positive evidence)", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({ tmux: "claude|12345\n" }),
		);
		expect(inspectTmuxPaneAgent("agent-interactive-claude")).toBe("alive");
	});

	test("returns 'alive' when descendant comm matches an agent name", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|1234\n",
				pgrep: "5678\n",
				ps: "claude\n",
			}),
		);
		expect(inspectTmuxPaneAgent("agent-bash-claude")).toBe("alive");
	});

	test("returns 'dead' when panes enumerate cleanly but no agent is found", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|1234\n",
				pgrep: "5678\n",
				ps: "node\nbash\n",
			}),
		);
		expect(inspectTmuxPaneAgent("cc-dead-lane")).toBe("dead");
	});

	test("returns 'unknown' when tmux list-panes throws (fail-open)", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: () => {
					throw new Error("tmux: no server running");
				},
			}),
		);
		expect(inspectTmuxPaneAgent("agent-anywhere")).toBe("unknown");
	});

	test("returns 'unknown' for invalid session ids", () => {
		expect(inspectTmuxPaneAgent("bad session/id")).toBe("unknown");
		expect(inspectTmuxPaneAgent("")).toBe("unknown");
		expect(execFileSyncMock).not.toHaveBeenCalled();
	});

	test("returns 'unknown' when tmux yields no pane lines", () => {
		execFileSyncMock.mockImplementation(makeExecImpl({ tmux: "" }));
		expect(inspectTmuxPaneAgent("agent-empty-panes")).toBe("unknown");
	});

	test("isTmuxPaneAgentAlive treats 'unknown' as alive (fail-open)", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: () => {
					throw new Error("tmux: no server running");
				},
			}),
		);
		expect(isTmuxPaneAgentAlive("agent-x")).toBe(true);
	});

	test("isTmuxPaneAgentAlive treats 'dead' as dead", () => {
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

	test("returns 'dead' only when pgrep exits cleanly with status=1", () => {
		// pgrep exit code 1 == "no matches" is the only proof of absence we
		// accept. Other exits/throws must be 'unknown', not 'dead'.
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|1234\n",
				pgrep: () => {
					throw Object.assign(new Error("no children"), { status: 1 });
				},
			}),
		);
		expect(inspectTmuxPaneAgent("cc-clean-dead")).toBe("dead");
	});

	test("returns 'unknown' when pgrep throws a non-status-1 error", () => {
		// Transient pgrep failure (timeout, signal, fatal) must fail-open as
		// 'unknown' so the launcher lane is not flipped to 'Agent process ended'
		// on a probe race.
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|1234\n",
				pgrep: () => {
					throw new Error("pgrep error");
				},
			}),
		);
		expect(inspectTmuxPaneAgent("cc-pgrep-flaky")).toBe("unknown");
	});

	test("returns 'unknown' when probe partially succeeds with non-agent comm", () => {
		// First pgrep call (depth 1) succeeds; the depth-2 call throws a
		// non-status-1 error. ps would say "bash" (no agent). We cannot conclude
		// 'dead' because the unreadable subtree could contain a live agent.
		let pgrepCall = 0;
		execFileSyncMock.mockImplementation((cmd: unknown, args: unknown) => {
			const a = args as string[];
			if (cmd === "tmux") return "bash|1234\n";
			if (cmd === "pgrep") {
				pgrepCall++;
				if (pgrepCall === 1 && a[a.indexOf("-P") + 1] === "1234")
					return "5678\n";
				throw new Error("pgrep transient failure");
			}
			if (cmd === "ps") return "bash\n";
			return "";
		});
		expect(inspectTmuxPaneAgent("cc-partial-probe")).toBe("unknown");
	});
});

describe("inspectTmuxPaneById (pane-specific evidence)", () => {
	beforeEach(() => {
		execFileSyncMock.mockReset();
	});

	test("PANE_ID_RE matches valid tmux pane ids", () => {
		expect(PANE_ID_RE.test("%0")).toBe(true);
		expect(PANE_ID_RE.test("%26")).toBe(true);
		expect(PANE_ID_RE.test("%999")).toBe(true);
		expect(PANE_ID_RE.test("26")).toBe(false);
		expect(PANE_ID_RE.test("@42")).toBe(false);
		expect(PANE_ID_RE.test("%")).toBe(false);
		expect(PANE_ID_RE.test("")).toBe(false);
		expect(PANE_ID_RE.test("%26; rm -rf")).toBe(false);
	});

	test("returns 'unknown' for invalid pane id", () => {
		expect(inspectTmuxPaneById("bad-pane")).toBe("unknown");
		expect(inspectTmuxPaneById("")).toBe("unknown");
		expect(inspectTmuxPaneById("26")).toBe("unknown");
		expect(execFileSyncMock).not.toHaveBeenCalled();
	});

	test("returns 'alive' when pane command is an agent", () => {
		execFileSyncMock.mockImplementation((cmd: unknown) => {
			if (cmd === "tmux") return "claude|12345\n";
			return "";
		});
		expect(inspectTmuxPaneById("%26")).toBe("alive");
	});

	test("returns 'alive' when descendant is an agent", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|1234\n",
				pgrep: "5678\n",
				ps: "claude\n",
			}),
		);
		expect(inspectTmuxPaneById("%7")).toBe("alive");
	});

	test("returns 'dead' when pane has no agent process or descendants", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|1234\n",
				pgrep: () => {
					throw Object.assign(new Error("no children"), { status: 1 });
				},
			}),
		);
		expect(inspectTmuxPaneById("%0")).toBe("dead");
	});

	test("returns 'unknown' when descendant probe fails transiently (regression: pane liveness flap)", () => {
		// Repro for cc-agent-status-fresh-lane-20260527-2111: tmux pane is alive
		// with a known pid (the bash login of the launcher lane), but pgrep -P
		// times out or otherwise fails. Previously this returned 'dead', causing
		// the Agent Status pane to render "Agent process ended" for a live lane
		// and then flip back to running on the next 5s probe. The pane-specific
		// inspector must fail-open as 'unknown' in this case.
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|35441\n",
				pgrep: () => {
					throw Object.assign(new Error("ETIMEDOUT"), { status: null });
				},
			}),
		);
		expect(inspectTmuxPaneById("%35")).toBe("unknown");
	});

	test("returns 'dead' when descendants exist but none are agents", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: "bash|1234\n",
				pgrep: "5678\n",
				ps: "node\nbash\n",
			}),
		);
		expect(inspectTmuxPaneById("%3")).toBe("dead");
	});

	test("returns 'unknown' when tmux display-message throws", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({
				tmux: () => {
					throw new Error("can't find pane %99");
				},
			}),
		);
		expect(inspectTmuxPaneById("%99")).toBe("unknown");
	});

	test("returns 'unknown' when tmux output is empty", () => {
		execFileSyncMock.mockImplementation(makeExecImpl({ tmux: "" }));
		expect(inspectTmuxPaneById("%1")).toBe("unknown");
	});

	test("tmuxSocket is forwarded as -S flag", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({ tmux: "claude|7777\n" }),
		);
		expect(inspectTmuxPaneById("%26", "/tmp/my.sock")).toBe("alive");
		const [, tmuxArgs] = execFileSyncMock.mock.calls[0] as [string, string[]];
		expect(tmuxArgs[0]).toBe("-S");
		expect(tmuxArgs[1]).toBe("/tmp/my.sock");
	});

	test("null tmuxSocket omits -S flag", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({ tmux: "claude|7777\n" }),
		);
		expect(inspectTmuxPaneById("%26", null)).toBe("alive");
		const [, tmuxArgs] = execFileSyncMock.mock.calls[0] as [string, string[]];
		expect(tmuxArgs[0]).not.toBe("-S");
	});

	test("uses display-message -t <paneId> -p format (not list-panes)", () => {
		execFileSyncMock.mockImplementation(
			makeExecImpl({ tmux: "claude|7777\n" }),
		);
		inspectTmuxPaneById("%26");
		const [, tmuxArgs] = execFileSyncMock.mock.calls[0] as [string, string[]];
		expect(tmuxArgs).toContain("display-message");
		expect(tmuxArgs).toContain("-t");
		expect(tmuxArgs).toContain("%26");
		expect(tmuxArgs).not.toContain("list-panes");
	});
});
