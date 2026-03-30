/**
 * Agent Status Discovery Pipeline — End-to-End Integration Tests
 *
 * Validates that the full agent discovery pipeline works correctly for
 * Claude Code and Codex agents across both discovery sources (ProcessScanner
 * and SessionWatcher), including:
 *   1. Claude Code agent discovery (session-file + process scanner)
 *   2. Interactive CLI session exclusion
 *   3. Codex --cd flag project directory resolution
 *   4. Internal tool directory filtering
 *   5. Registry merge/dedup across both sources
 *
 * All system calls are mocked — no real processes are inspected.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

// ── Module-level mocks (must be set up before importing sources) ────

// Track fs.watch callbacks for SessionWatcher
let watchCallback: ((event: string, filename: string | null) => void) | null =
	null;
const mockWatcher = {
	close: mock(() => {}),
	on: mock(() => {}),
};

// Mocked session file contents keyed by filename
let sessionFiles: Record<string, string> = {};
let dirContents: string[] = [];
let pidCommands: Record<number, string> = {};

import * as realFs from "node:fs";

mock.module("node:child_process", () => ({
	...realChildProcess,
	execFileSync: (_cmd: string, args: string[]) => {
		const pid = Number(args[1]);
		const command = pidCommands[pid];
		if (!command) throw new Error("ESRCH");
		return `${command}\n`;
	},
}));

mock.module("node:fs", () => ({
	...realFs,
	readdirSync: (_dir: string) => dirContents,
	readFileSync: (filePath: string, enc?: string) => {
		if (enc === "utf-8" || enc === "utf8") {
			const filename = path.basename(filePath);
			const content = sessionFiles[filename];
			if (content !== undefined) return content;
		}
		// Fall through to real fs for other reads (e.g. stat in process scanner)
		return realFs.readFileSync(filePath, enc as BufferEncoding);
	},
	watch: (
		_dir: string,
		cb: (event: string, filename: string | null) => void,
	) => {
		watchCallback = cb;
		return mockWatcher;
	},
	statSync: realFs.statSync,
	existsSync: realFs.existsSync,
}));

// Mock process.kill for isProcessAlive checks
const originalKill = process.kill;
let alivePids = new Set<number>();
process.kill = ((pid: number, signal?: number) => {
	if (signal === 0) {
		if (!alivePids.has(pid)) {
			throw new Error("ESRCH");
		}
		return true;
	}
	return signal === undefined
		? originalKill.call(process, pid)
		: originalKill.call(process, pid, signal);
}) as typeof process.kill;

// ── Now import the discovery modules (after mocks are in place) ─────

import { ProcessScanner } from "../../src/discovery/process-scanner.js";
import { SessionWatcher } from "../../src/discovery/session-watcher.js";
import type { DiscoveredAgent } from "../../src/discovery/types.js";

// ── Shared test constants ───────────────────────────────────────────

const FIXED_NOW = Date.parse("2026-03-30T12:00:00Z");
const HOME = os.homedir();

// Mock execFileAsync for ProcessScanner (constructor injection)
const mockExecFile = mock(
	(_cmd: string, _args?: readonly string[], _opts?: Record<string, unknown>) =>
		Promise.resolve({ stdout: "", stderr: "" }) as Promise<{
			stdout: string;
			stderr: string;
		}>,
);

// ── Test Suite ──────────────────────────────────────────────────────

describe("Agent Discovery E2E Pipeline", () => {
	let scanner: ProcessScanner;
	let watcher: SessionWatcher;

	beforeEach(() => {
		// Reset all mocks and state
		mockExecFile.mockClear();
		mockExecFile.mockImplementation(
			() =>
				Promise.resolve({ stdout: "", stderr: "" }) as Promise<{
					stdout: string;
					stderr: string;
				}>,
		);
		sessionFiles = {};
		dirContents = [];
		pidCommands = {};
		alivePids = new Set();
		watchCallback = null;
		mockWatcher.close.mockClear();
		mockWatcher.on.mockClear();

		scanner = new ProcessScanner(
			mockExecFile as unknown as Parameters<typeof ProcessScanner>[0],
			// Skip worktree resolution in integration tests
			async () => null,
			{
				launcherTasksProvider: () => [],
				nowProvider: () => FIXED_NOW,
			},
		);

		watcher = new SessionWatcher("/tmp/test-sessions");
	});

	// ── 1. Claude Code agent discovery (session-file path) ──────────

	describe("Claude Code agent via session file", () => {
		test("discovers Claude Code agent with -p flag from session file + ps validation", () => {
			const session = {
				pid: 50001,
				sessionId: "sess-claude-agent",
				cwd: "/Users/test/projects/my-app",
				startedAt: FIXED_NOW - 60_000,
			};
			sessionFiles["50001.json"] = JSON.stringify(session);
			dirContents = ["50001.json"];
			alivePids.add(50001);
			pidCommands[50001] = "claude -p 'summarize this repo'";

			watcher.start();
			const agents = watcher.getAgents();

			expect(agents).toHaveLength(1);
			expect(agents[0]?.pid).toBe(50001);
			expect(agents[0]?.projectDir).toBe("/Users/test/projects/my-app");
			expect(agents[0]?.sessionId).toBe("sess-claude-agent");
			expect(agents[0]?.source).toBe("session-file");
		});

		test("discovers Claude Code agent with --print flag from session file", () => {
			const session = {
				pid: 50002,
				sessionId: "sess-claude-print",
				cwd: "/Users/test/projects/backend",
				startedAt: FIXED_NOW - 120_000,
			};
			sessionFiles["50002.json"] = JSON.stringify(session);
			dirContents = ["50002.json"];
			alivePids.add(50002);
			pidCommands[50002] = "/usr/local/bin/claude --print 'fix the tests'";

			watcher.start();
			const agents = watcher.getAgents();

			expect(agents).toHaveLength(1);
			expect(agents[0]?.pid).toBe(50002);
			expect(agents[0]?.projectDir).toBe("/Users/test/projects/backend");
			expect(agents[0]?.source).toBe("session-file");
		});
	});

	// ── 2. Claude Code interactive session exclusion ────────────────

	describe("Claude Code interactive exclusion", () => {
		test("excludes bare 'claude' (no -p/--print) from session-file discovery", () => {
			const session = {
				pid: 50010,
				sessionId: "sess-interactive",
				cwd: "/Users/test/projects/my-app",
				startedAt: FIXED_NOW - 30_000,
			};
			sessionFiles["50010.json"] = JSON.stringify(session);
			dirContents = ["50010.json"];
			alivePids.add(50010);
			// Bare claude — interactive session
			pidCommands[50010] = "claude";

			watcher.start();
			const agents = watcher.getAgents();

			expect(agents).toHaveLength(0);
		});

		test("excludes interactive 'claude chat' from session-file discovery", () => {
			const session = {
				pid: 50011,
				sessionId: "sess-chat",
				cwd: "/Users/test/projects/my-app",
				startedAt: FIXED_NOW - 30_000,
			};
			sessionFiles["50011.json"] = JSON.stringify(session);
			dirContents = ["50011.json"];
			alivePids.add(50011);
			pidCommands[50011] = "claude chat";

			watcher.start();
			const agents = watcher.getAgents();

			expect(agents).toHaveLength(0);
		});

		test("excludes bare claude from process scanner as interactive-process", async () => {
			mockExecFile.mockImplementation(
				(cmd: unknown) =>
					Promise.resolve({
						stdout:
							cmd === "ps"
								? [
										"  PID   STARTED                       COMMAND",
										"50012 Mon Mar 30 11:50:00 2026 claude",
									].join("\n")
								: "",
						stderr: "",
					}) as Promise<{ stdout: string; stderr: string }>,
			);

			const agents = await scanner.scan();
			expect(agents).toHaveLength(0);

			const diag = scanner.getLastDiagnostics();
			expect(
				diag.filtered.some(
					(e) => e.pid === 50012 && e.reason === "interactive-process",
				),
			).toBe(true);
		});
	});

	// ── 3. Codex agent with --cd flag (process scanner path) ────────

	describe("Codex agent with --cd flag", () => {
		test("uses --cd flag for projectDir instead of lsof CWD", async () => {
			mockExecFile.mockImplementation((cmd: unknown, args: unknown) => {
				if (cmd === "ps") {
					return Promise.resolve({
						stdout: [
							"  PID   STARTED                       COMMAND",
							`60001 Mon Mar 30 11:55:00 2026 /opt/homebrew/bin/codex exec --json --full-auto --cd /Users/test/projects/my-app 'fix the bug'`,
						].join("\n"),
						stderr: "",
					});
				}
				if (cmd === "lsof" && Array.isArray(args) && args[1] === "60001") {
					return Promise.resolve({
						stdout: `p60001\nfcwd\nn${HOME}/.claude/plans\n`,
						stderr: "",
					});
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			});

			const agents = await scanner.scan();

			expect(agents).toHaveLength(1);
			expect(agents[0]?.pid).toBe(60001);
			// Must use --cd value, NOT the lsof CWD (~/.claude/plans)
			expect(agents[0]?.projectDir).toBe("/Users/test/projects/my-app");
			expect(agents[0]?.agent_backend).toBe("codex");
			expect(agents[0]?.source).toBe("process");
		});

		test("uses --cd= (equals form) for projectDir", async () => {
			mockExecFile.mockImplementation((cmd: unknown, args: unknown) => {
				if (cmd === "ps") {
					return Promise.resolve({
						stdout: [
							"  PID   STARTED                       COMMAND",
							"60002 Mon Mar 30 11:55:00 2026 codex exec --cd=/Users/test/projects/backend 'ship it'",
						].join("\n"),
						stderr: "",
					});
				}
				if (cmd === "lsof" && Array.isArray(args) && args[1] === "60002") {
					return Promise.resolve({
						stdout: `p60002\nfcwd\nn${HOME}/.codex/workspace\n`,
						stderr: "",
					});
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			});

			const agents = await scanner.scan();

			expect(agents).toHaveLength(1);
			expect(agents[0]?.projectDir).toBe("/Users/test/projects/backend");
		});
	});

	// ── 4. Internal tool directory filtering ────────────────────────

	describe("internal tool directory filtering", () => {
		test("filters Codex process with ~/.claude/ CWD and no --cd flag", async () => {
			mockExecFile.mockImplementation((cmd: unknown, args: unknown) => {
				if (cmd === "ps") {
					return Promise.resolve({
						stdout: [
							"  PID   STARTED                       COMMAND",
							"70001 Mon Mar 30 11:55:00 2026 /opt/homebrew/bin/codex exec 'do something'",
						].join("\n"),
						stderr: "",
					});
				}
				if (cmd === "lsof" && Array.isArray(args) && args[1] === "70001") {
					return Promise.resolve({
						stdout: `p70001\nfcwd\nn${HOME}/.claude/plans\n`,
						stderr: "",
					});
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			});

			const agents = await scanner.scan();
			expect(agents).toHaveLength(0);

			const diag = scanner.getLastDiagnostics();
			expect(
				diag.filtered.some(
					(e) => e.pid === 70001 && e.reason === "internal-tool-dir",
				),
			).toBe(true);
		});

		test("filters process with ~/.codex/ CWD", async () => {
			mockExecFile.mockImplementation((cmd: unknown, args: unknown) => {
				if (cmd === "ps") {
					return Promise.resolve({
						stdout: [
							"  PID   STARTED                       COMMAND",
							"70002 Mon Mar 30 11:55:00 2026 /opt/homebrew/bin/codex exec 'run task'",
						].join("\n"),
						stderr: "",
					});
				}
				if (cmd === "lsof" && Array.isArray(args) && args[1] === "70002") {
					return Promise.resolve({
						stdout: `p70002\nfcwd\nn${HOME}/.codex/workspace\n`,
						stderr: "",
					});
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			});

			const agents = await scanner.scan();
			expect(agents).toHaveLength(0);

			const diag = scanner.getLastDiagnostics();
			expect(
				diag.filtered.some(
					(e) => e.pid === 70002 && e.reason === "internal-tool-dir",
				),
			).toBe(true);
		});

		test("filters process with ~/.config/ CWD", async () => {
			mockExecFile.mockImplementation((cmd: unknown, args: unknown) => {
				if (cmd === "ps") {
					return Promise.resolve({
						stdout: [
							"  PID   STARTED                       COMMAND",
							"70003 Mon Mar 30 11:55:00 2026 claude -p 'internal task'",
						].join("\n"),
						stderr: "",
					});
				}
				if (cmd === "lsof" && Array.isArray(args) && args[1] === "70003") {
					return Promise.resolve({
						stdout: `p70003\nfcwd\nn${HOME}/.config/claude\n`,
						stderr: "",
					});
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			});

			const agents = await scanner.scan();
			expect(agents).toHaveLength(0);

			const diag = scanner.getLastDiagnostics();
			expect(
				diag.filtered.some(
					(e) => e.pid === 70003 && e.reason === "internal-tool-dir",
				),
			).toBe(true);
		});

		test("--cd flag rescues Codex from internal-tool-dir filtering", async () => {
			mockExecFile.mockImplementation((cmd: unknown, args: unknown) => {
				if (cmd === "ps") {
					return Promise.resolve({
						stdout: [
							"  PID   STARTED                       COMMAND",
							`70004 Mon Mar 30 11:55:00 2026 codex exec --cd /Users/test/real-project 'fix bug'`,
						].join("\n"),
						stderr: "",
					});
				}
				if (cmd === "lsof" && Array.isArray(args) && args[1] === "70004") {
					// lsof returns internal dir, but --cd should take precedence
					return Promise.resolve({
						stdout: `p70004\nfcwd\nn${HOME}/.claude/plans\n`,
						stderr: "",
					});
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			});

			const agents = await scanner.scan();
			expect(agents).toHaveLength(1);
			expect(agents[0]?.projectDir).toBe("/Users/test/real-project");
		});
	});

	// ── 5. Full pipeline: both sources with dedup ───────────────────

	describe("registry merge: session-file + process-scanner dedup", () => {
		test("session-file agent and process-scanner agent with same PID dedup by PID", async () => {
			// Set up session-file agent (PID 80001)
			const session = {
				pid: 80001,
				sessionId: "sess-overlap",
				cwd: "/Users/test/projects/my-app",
				startedAt: FIXED_NOW - 60_000,
			};
			sessionFiles["80001.json"] = JSON.stringify(session);
			dirContents = ["80001.json"];
			alivePids.add(80001);
			pidCommands[80001] = "claude -p 'summarize this repo'";

			watcher.start();
			const sessionAgents = watcher.getAgents();

			// Set up process-scanner agent (same PID 80001)
			mockExecFile.mockImplementation((cmd: unknown, args: unknown) => {
				if (cmd === "ps") {
					return Promise.resolve({
						stdout: [
							"  PID   STARTED                       COMMAND",
							"80001 Mon Mar 30 11:59:00 2026 claude -p 'summarize this repo' --model opus",
						].join("\n"),
						stderr: "",
					});
				}
				if (cmd === "lsof" && Array.isArray(args) && args[1] === "80001") {
					return Promise.resolve({
						stdout: "p80001\nfcwd\nn/Users/test/projects/my-app\n",
						stderr: "",
					});
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			});

			const processAgents = await scanner.scan();

			// Verify both sources found the same PID
			expect(sessionAgents).toHaveLength(1);
			expect(processAgents).toHaveLength(1);
			expect(sessionAgents[0]?.pid).toBe(80001);
			expect(processAgents[0]?.pid).toBe(80001);

			// Simulate registry dedup: merge by PID, session-file wins (priority 2 > 1)
			const allAgents = [...sessionAgents, ...processAgents];
			const byPid = new Map<number, DiscoveredAgent>();
			for (const agent of allAgents) {
				const existing = byPid.get(agent.pid);
				if (!existing) {
					byPid.set(agent.pid, agent);
				} else {
					const existingPriority = existing.source === "session-file" ? 2 : 1;
					const newPriority = agent.source === "session-file" ? 2 : 1;
					if (newPriority > existingPriority) {
						byPid.set(agent.pid, {
							...existing,
							...agent,
							model: agent.model || existing.model,
						});
					} else {
						byPid.set(agent.pid, {
							...agent,
							...existing,
							model: existing.model || agent.model,
						});
					}
				}
			}
			const merged = Array.from(byPid.values());

			expect(merged).toHaveLength(1);
			expect(merged[0]?.pid).toBe(80001);
			// Session-file source wins
			expect(merged[0]?.source).toBe("session-file");
			// But model from process scanner is preserved
			expect(merged[0]?.model).toBe("opus");
		});

		test("non-overlapping agents from both sources are all included", async () => {
			// Session-file agent (PID 80010)
			const session = {
				pid: 80010,
				sessionId: "sess-only-session",
				cwd: "/Users/test/projects/frontend",
				startedAt: FIXED_NOW - 60_000,
			};
			sessionFiles["80010.json"] = JSON.stringify(session);
			dirContents = ["80010.json"];
			alivePids.add(80010);
			pidCommands[80010] = "claude -p 'lint and fix'";

			watcher.start();
			const sessionAgents = watcher.getAgents();

			// Process-scanner agent (PID 80020 — different from session)
			mockExecFile.mockImplementation((cmd: unknown, args: unknown) => {
				if (cmd === "ps") {
					return Promise.resolve({
						stdout: [
							"  PID   STARTED                       COMMAND",
							"80020 Mon Mar 30 11:58:00 2026 /opt/homebrew/bin/codex exec --cd /Users/test/projects/backend 'deploy'",
						].join("\n"),
						stderr: "",
					});
				}
				if (cmd === "lsof" && Array.isArray(args) && args[1] === "80020") {
					return Promise.resolve({
						stdout: `p80020\nfcwd\nn${HOME}/.claude/plans\n`,
						stderr: "",
					});
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			});

			const processAgents = await scanner.scan();

			// Both sources contribute unique agents
			expect(sessionAgents).toHaveLength(1);
			expect(processAgents).toHaveLength(1);
			expect(sessionAgents[0]?.pid).toBe(80010);
			expect(processAgents[0]?.pid).toBe(80020);

			// Merge (no overlap)
			const merged = [...sessionAgents, ...processAgents];
			const uniquePids = new Set(merged.map((a) => a.pid));
			expect(uniquePids.size).toBe(2);
		});

		test("mixed scenario: discovers agents, excludes interactive, filters internal dirs", async () => {
			// Session file: valid agent (PID 90001)
			sessionFiles["90001.json"] = JSON.stringify({
				pid: 90001,
				sessionId: "sess-valid",
				cwd: "/Users/test/projects/app",
				startedAt: FIXED_NOW - 60_000,
			});
			// Session file: interactive session (PID 90002) — should be excluded
			sessionFiles["90002.json"] = JSON.stringify({
				pid: 90002,
				sessionId: "sess-interactive",
				cwd: "/Users/test/projects/other",
				startedAt: FIXED_NOW - 30_000,
			});
			dirContents = ["90001.json", "90002.json"];
			alivePids.add(90001);
			alivePids.add(90002);
			pidCommands[90001] = "claude --print 'run the tests'";
			pidCommands[90002] = "claude"; // bare interactive

			watcher.start();
			const sessionAgents = watcher.getAgents();

			// Process scanner: one valid codex, one with internal dir
			mockExecFile.mockImplementation((cmd: unknown, args: unknown) => {
				if (cmd === "ps") {
					return Promise.resolve({
						stdout: [
							"  PID   STARTED                       COMMAND",
							"90003 Mon Mar 30 11:57:00 2026 codex exec --cd /Users/test/projects/backend 'deploy'",
							"90004 Mon Mar 30 11:57:00 2026 codex exec 'internal task'",
						].join("\n"),
						stderr: "",
					});
				}
				if (cmd === "lsof" && Array.isArray(args)) {
					const pid = args[1];
					if (pid === "90003") {
						return Promise.resolve({
							stdout: `p90003\nfcwd\nn${HOME}/.claude/plans\n`,
							stderr: "",
						});
					}
					if (pid === "90004") {
						return Promise.resolve({
							stdout: `p90004\nfcwd\nn${HOME}/.claude/internal\n`,
							stderr: "",
						});
					}
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			});

			const processAgents = await scanner.scan();

			// Session: 1 agent (90001), interactive excluded (90002)
			expect(sessionAgents).toHaveLength(1);
			expect(sessionAgents[0]?.pid).toBe(90001);

			// Process: 1 agent (90003 with --cd), internal filtered (90004)
			expect(processAgents).toHaveLength(1);
			expect(processAgents[0]?.pid).toBe(90003);
			expect(processAgents[0]?.projectDir).toBe("/Users/test/projects/backend");

			// Diagnostics confirm internal-tool-dir filtering
			const diag = scanner.getLastDiagnostics();
			expect(
				diag.filtered.some(
					(e) => e.pid === 90004 && e.reason === "internal-tool-dir",
				),
			).toBe(true);

			// Combined: 2 unique agents from both sources
			const allAgents = [...sessionAgents, ...processAgents];
			expect(allAgents).toHaveLength(2);
			expect(new Set(allAgents.map((a) => a.pid))).toEqual(
				new Set([90001, 90003]),
			);
		});
	});

	// ── 6. AGENT_MODE_RE filtering in session watcher ───────────────

	describe("AGENT_MODE_RE session-file filtering", () => {
		test("allows claude --resume (agent mode) through session watcher", () => {
			sessionFiles["60010.json"] = JSON.stringify({
				pid: 60010,
				sessionId: "sess-resume",
				cwd: "/Users/test/projects/app",
				startedAt: FIXED_NOW - 60_000,
			});
			dirContents = ["60010.json"];
			alivePids.add(60010);
			pidCommands[60010] = "claude --resume sess-resume";

			watcher.start();
			expect(watcher.getAgents()).toHaveLength(1);
		});

		test("allows codex exec through session watcher", () => {
			sessionFiles["60020.json"] = JSON.stringify({
				pid: 60020,
				sessionId: "sess-codex-exec",
				cwd: "/Users/test/projects/app",
				startedAt: FIXED_NOW - 60_000,
			});
			dirContents = ["60020.json"];
			alivePids.add(60020);
			pidCommands[60020] =
				"/opt/homebrew/bin/codex exec --model gpt-5 'fix tests'";

			watcher.start();
			expect(watcher.getAgents()).toHaveLength(1);
		});

		test("allows --prompt flag through session watcher", () => {
			sessionFiles["60030.json"] = JSON.stringify({
				pid: 60030,
				sessionId: "sess-prompt",
				cwd: "/Users/test/projects/app",
				startedAt: FIXED_NOW - 60_000,
			});
			dirContents = ["60030.json"];
			alivePids.add(60030);
			pidCommands[60030] = "gemini --prompt 'explain this code'";

			watcher.start();
			expect(watcher.getAgents()).toHaveLength(1);
		});

		test("rejects shell process left behind after agent exits", () => {
			sessionFiles["60040.json"] = JSON.stringify({
				pid: 60040,
				sessionId: "sess-shell",
				cwd: "/Users/test/projects/app",
				startedAt: FIXED_NOW - 60_000,
			});
			dirContents = ["60040.json"];
			alivePids.add(60040);
			pidCommands[60040] = "/bin/zsh";

			watcher.start();
			expect(watcher.getAgents()).toHaveLength(0);
		});
	});
});
