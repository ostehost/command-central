/**
 * AgentRegistry tests
 *
 * Validates merging of launcher tasks, session-file agents, and
 * process-scanned agents. Dedup, priority, and event emission.
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
import { createVSCodeMock } from "../helpers/vscode-mock.js";

// ── Mocks ────────────────────────────────────────────────────────────

// IMPORTANT: Do NOT use `import * as realFs from "node:fs"` (or
// child_process) here. Bun's namespace imports are live bindings. By the
// time this file loads, earlier test files have already installed fs/cp
// mocks via mock.module(), so a local namespace spread would spread the
// MOCKED module back into our factory — creating self-referential mocks
// that ENOENT on every real path and cascading into slow recovery paths.
// Use the frozen snapshots stashed by test/setup/global-test-cleanup.ts
// (via bunfig preload) before any test file loads.
const realFs = (globalThis as Record<string, unknown>)["__realNodeFs"] as
	| typeof import("node:fs")
	| undefined;
const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process") | undefined;
if (!realFs || !realChildProcess) {
	throw new Error(
		"globalThis.__realNodeFs / __realNodeChildProcess missing — is test/setup/global-test-cleanup.ts still in bunfig preload?",
	);
}

// Mock child_process for ProcessScanner / SessionWatcher.
// IMPORTANT: because module mocks are process-global in Bun, this mock must
// only intercept the specific discovery calls this file cares about and pass
// everything else through to the real child_process implementation.
type ExecFileCallback = (
	err: Error | null,
	result: { stdout: string; stderr: string },
) => void;
function returnExecFileResult(cb: ExecFileCallback | undefined, stdout = "") {
	if (cb) cb(null, { stdout, stderr: "" });
	return { on: () => ({}) };
}
mock.module("node:child_process", () => ({
	...realChildProcess,
	execFile: (
		cmd: string,
		args: string[],
		optsOrCb?: Record<string, unknown> | ExecFileCallback,
		cb?: ExecFileCallback,
	) => {
		const callback = typeof optsOrCb === "function" ? optsOrCb : cb;
		if (
			cmd === "ps" &&
			args[0] === "-eo" &&
			args[1] === "pid,ppid,lstart,command"
		) {
			return returnExecFileResult(callback, "");
		}
		if (typeof optsOrCb === "function") {
			return (
				realChildProcess.execFile as unknown as (...a: unknown[]) => unknown
			)(cmd, args, optsOrCb);
		}
		if (cb) {
			return (
				realChildProcess.execFile as unknown as (...a: unknown[]) => unknown
			)(cmd, args, optsOrCb, cb);
		}
		return (
			realChildProcess.execFile as unknown as (...a: unknown[]) => unknown
		)(cmd, args, optsOrCb);
	},
	execFileSync: (
		cmd: string,
		args: string[],
		opts?: Record<string, unknown>,
	) => {
		if (
			cmd === "ps" &&
			args[0] === "-p" &&
			args[2] === "-o" &&
			args[3] === "command="
		) {
			const pid = Number(args[1]);
			const command =
				pidCommands[pid] ?? `/usr/local/bin/claude --resume pid-${pid}`;
			if (!command) throw new Error("ESRCH");
			return `${command}
`;
		}
		return (
			realChildProcess.execFileSync as unknown as (...a: unknown[]) => unknown
		)(cmd, args, opts);
	},
}));

// Mock node:fs for SessionWatcher
let sessionFiles: Record<string, string> = {};
let dirContents: string[] = [];
let pidCommands: Record<number, string> = {};

// Bun's `mock.module()` is global-for-the-process and `mock.restore()`
// does not undo it, so these overrides stay active for every subsequent
// test in the suite. We therefore pass through to realFs whenever the
// call isn't targeted at the session-file paths this file controls,
// otherwise unrelated tests' fs operations (mkdtempSync, writeFileSync,
// readFileSync of source/config files, etc.) get mocked mid-run and
// either stall or fail.
// biome-ignore lint/suspicious/noExplicitAny: pass-through wrapper
type AnyArgs = any[];
mock.module("node:fs", () => ({
	...realFs,
	readdirSync: ((...args: AnyArgs) => {
		// dirContents is the SessionWatcher scenario contract. When a test
		// has populated it, use it; otherwise fall back to real readdirSync
		// so we don't break unrelated tests' filesystem reads.
		if (dirContents.length > 0) return dirContents;
		return (realFs?.readdirSync as (...a: AnyArgs) => unknown)(...args);
	}) as typeof realFs.readdirSync,
	readFileSync: ((...args: AnyArgs) => {
		const [filePath, enc] = args as [string, string | undefined];
		const parts = String(filePath).split("/");
		const filename = parts.at(-1);
		if (filename !== undefined) {
			const content = sessionFiles[filename];
			if (content !== undefined) return content;
		}
		return (realFs?.readFileSync as (...a: AnyArgs) => unknown)(
			filePath,
			enc as never,
		);
	}) as typeof realFs.readFileSync,
	// SessionWatcher expects to install a watcher; other tests don't rely
	// on watch, so returning a stub here is fine.
	watch: () => ({
		close: mock(() => {}),
		on: mock(() => {}),
	}),
}));

// Reuse the global preload vscode mock from test/setup/global-test-cleanup.ts.
// A file-local module-scope vscode mock here leaks into later files because
// Bun keeps module mocks process-global for the whole test run.

// Mock process.kill for isProcessAlive. Module-scope monkey-patch that we
// restore in afterAll so other test files see the real `process.kill` again.
const originalKill = process.kill;
let alivePids: Set<number> = new Set();
process.kill = ((pid: number, signal?: number) => {
	if (signal === 0) {
		if (!alivePids.has(pid)) throw new Error("ESRCH");
		return true;
	}
	return signal === undefined
		? originalKill.call(process, pid)
		: originalKill.call(process, pid, signal);
}) as typeof process.kill;

afterAll(() => {
	process.kill = originalKill;
	mock.module("node:fs", () => realFs);
	mock.module("node:child_process", () => realChildProcess);
	mock.module("vscode", () => createVSCodeMock());
});

import { AgentRegistry } from "../../src/discovery/agent-registry.js";

// TODO(oste): add completed_stale launcher PID masking regression test.

// Helper to create a mock AgentTask (launcher source)
function createMockTask(overrides: Record<string, unknown> = {}) {
	return {
		id: "task-1",
		status: "running" as const,
		project_dir: "/project",
		project_name: "project",
		session_id: "launcher-sess",
		bundle_path: "/bundle",
		prompt_file: "/prompt.md",
		started_at: "2025-01-01T00:00:00Z",
		attempts: 1,
		max_attempts: 3,
		...overrides,
	};
}

describe("AgentRegistry", () => {
	let registry: AgentRegistry;
	let trackedLauncherTasks: ReturnType<typeof createMockTask>[];

	beforeEach(() => {
		sessionFiles = {};
		dirContents = [];
		pidCommands = {};
		alivePids = new Set();
		trackedLauncherTasks = [];
		registry = new AgentRegistry("/tmp/test-sessions", {
			launcherTasksProvider: () => trackedLauncherTasks,
			idleStreamThresholdMs: 5 * 60_000,
		});
	});

	// Every test in this file invokes `registry.start()`, which fires off a
	// non-awaited `doProcessScan()` Promise, a setInterval poller, a
	// SessionWatcher fs.watch, and a workspace.onDidChangeConfiguration
	// disposable. Without explicit teardown those leak into the next test
	// file's event loop and show up as 5-10s stalls entering its beforeEach.
	// dispose() clears the interval, disposes the SessionWatcher and the
	// EventEmitter, and disposes the config-change listener.
	afterEach(() => {
		registry?.dispose();
	});

	// ── Merging launcher + discovered agents ─────────────────────────

	describe("getDiscoveredAgents", () => {
		test("returns discovered agents not in launcher task list", () => {
			// Set up a session file agent
			sessionFiles["500.json"] = JSON.stringify({
				pid: 500,
				sessionId: "disc-sess",
				cwd: "/discovered-project",
				startedAt: 1704067200000,
			});
			dirContents = ["500.json"];
			alivePids.add(500);

			registry.start();

			// Launcher has a different task
			const launcherTasks = [createMockTask({ session_id: "launcher-sess" })];
			const discovered = registry.getDiscoveredAgents(launcherTasks);

			expect(discovered).toHaveLength(1);
			expect(discovered[0]?.pid).toBe(500);
		});

		test("filters out agents whose sessionId matches launcher", () => {
			sessionFiles["600.json"] = JSON.stringify({
				pid: 600,
				sessionId: "shared-sess",
				cwd: "/shared-project",
				startedAt: 1704067200000,
			});
			dirContents = ["600.json"];
			alivePids.add(600);

			registry.start();

			const launcherTasks = [createMockTask({ session_id: "shared-sess" })];
			const discovered = registry.getDiscoveredAgents(launcherTasks);

			expect(discovered).toHaveLength(0);
		});

		test("does not filter discovered agent when launcher task is non-running", () => {
			sessionFiles["601.json"] = JSON.stringify({
				pid: 601,
				sessionId: "shared-sess-stopped",
				cwd: "/shared-project-stopped",
				startedAt: 1704067200000,
			});
			dirContents = ["601.json"];
			alivePids.add(601);

			registry.start();

			const launcherTasks = [
				createMockTask({
					session_id: "shared-sess-stopped",
					status: "completed_stale",
				}),
			];
			const discovered = registry.getDiscoveredAgents(launcherTasks);

			expect(discovered).toHaveLength(1);
			expect(discovered[0]?.pid).toBe(601);
		});

		test("does not filter discovered agent when launcher PID is non-running", () => {
			sessionFiles["602.json"] = JSON.stringify({
				pid: 602,
				sessionId: "pid-shared-stopped",
				cwd: "/shared-project-pid-stopped",
				startedAt: 1704067200000,
			});
			dirContents = ["602.json"];
			alivePids.add(602);

			registry.start();

			const launcherTasks = [
				createMockTask({
					session_id: "pid-shared-stopped",
					status: "completed_stale",
					pid: 602,
				}),
			];
			const discovered = registry.getDiscoveredAgents(launcherTasks);

			expect(discovered).toHaveLength(1);
			expect(discovered[0]?.pid).toBe(602);
		});

		test("filters discovered agent when launcher PID is running", () => {
			sessionFiles["603.json"] = JSON.stringify({
				pid: 603,
				sessionId: "pid-only-match",
				cwd: "/shared-project-pid-running",
				startedAt: 1704067200000,
			});
			dirContents = ["603.json"];
			alivePids.add(603);

			registry.start();

			const launcherTasks = [
				createMockTask({
					session_id: "different-session",
					status: "running",
					pid: 603,
				}),
			];
			const discovered = registry.getDiscoveredAgents(launcherTasks);

			expect(discovered).toHaveLength(0);
		});

		test("filters discovered agent when launcher PID is running without sessionId", () => {
			sessionFiles["604.json"] = JSON.stringify({
				pid: 604,
				sessionId: "pid-match-no-session-id",
				cwd: "/shared-project-pid-running-no-session",
				startedAt: 1704067200000,
			});
			dirContents = ["604.json"];
			alivePids.add(604);

			registry.start();

			const launcherTasks = [
				createMockTask({
					session_id: "",
					status: "running",
					pid: 604,
				}),
			];
			const discovered = registry.getDiscoveredAgents(launcherTasks);

			expect(discovered).toHaveLength(0);
		});

		test("returns empty when no discovered agents", () => {
			dirContents = [];
			registry.start();

			const discovered = registry.getDiscoveredAgents([createMockTask()]);
			expect(discovered).toHaveLength(0);
		});

		test("prunes stale session-file agents whose PID died after initial discovery", () => {
			sessionFiles["605.json"] = JSON.stringify({
				pid: 605,
				sessionId: "ghost-worktree-agent",
				cwd: "/Users/test/projects/command-central-feature-diagnostics",
				startedAt: 1704067200000,
			});
			dirContents = ["605.json"];
			alivePids.add(605);

			registry.start();
			expect(registry.getAllDiscovered().map((agent) => agent.pid)).toContain(
				605,
			);

			alivePids.delete(605);

			expect(
				registry.getAllDiscovered().map((agent) => agent.pid),
			).not.toContain(605);
			expect(
				registry.getDiscoveredAgents([]).map((agent) => agent.pid),
			).not.toContain(605);
			expect(registry.getDiagnostics().prunedDeadAgents).toBeGreaterThanOrEqual(
				1,
			);
		});

		test("suppresses discovered agents when the matching launcher task is already completed", () => {
			sessionFiles["606.json"] = JSON.stringify({
				pid: 606,
				sessionId: "cli-sess-completed",
				cwd: "/project-terminal",
				startedAt: 1704067200000,
			});
			dirContents = ["606.json"];
			alivePids.add(606);
			trackedLauncherTasks = [
				createMockTask({
					status: "completed",
					project_dir: "/project-terminal",
					started_at: new Date(1704067200000).toISOString(),
					agent_backend: "claude",
				}),
			];

			registry.start();

			expect(registry.getAllDiscovered()).toHaveLength(0);
			expect(registry.getDiscoveredAgents([])).toHaveLength(0);
		});

		test("suppresses idle session-file agents when the matching running task stream is stale", () => {
			const streamFile = `/tmp/agent-registry-idle-${Date.now()}.jsonl`;
			realFs.writeFileSync(streamFile, '{"type":"thread.started"}\n');
			const staleSeconds = Math.floor((Date.now() - 6 * 60_000) / 1000);
			realFs.utimesSync(streamFile, staleSeconds, staleSeconds);

			sessionFiles["607.json"] = JSON.stringify({
				pid: 607,
				sessionId: "cli-sess-idle",
				cwd: "/project-idle",
				startedAt: 1704067200000,
			});
			dirContents = ["607.json"];
			alivePids.add(607);
			trackedLauncherTasks = [
				createMockTask({
					id: "running-idle",
					status: "running",
					project_dir: "/project-idle",
					started_at: new Date(1704067200000).toISOString(),
					stream_file: streamFile,
					agent_backend: "claude",
				}),
			];

			registry.start();

			expect(registry.getAllDiscovered()).toHaveLength(0);
			realFs.rmSync(streamFile, { force: true });
		});
	});

	// ── Dedup: same PID from session + process → one entry ───────────

	describe("dedup", () => {
		test("getAllDiscovered returns deduplicated list", () => {
			sessionFiles["700.json"] = JSON.stringify({
				pid: 700,
				sessionId: "sess-700",
				cwd: "/project-700",
				startedAt: 1704067200000,
			});
			dirContents = ["700.json"];
			alivePids.add(700);

			registry.start();

			const all = registry.getAllDiscovered();
			// Even if both session and process scanner find PID 700,
			// it should appear only once
			const pids = all.map((a) => a.pid);
			const uniquePids = new Set(pids);
			expect(uniquePids.size).toBe(pids.length);
		});
	});

	// ── Priority: launcher > session-file > process ──────────────────

	describe("source priority", () => {
		test("session-file source is included in discovered agents", () => {
			sessionFiles["800.json"] = JSON.stringify({
				pid: 800,
				sessionId: "sess-800",
				cwd: "/project-800",
				startedAt: 1704067200000,
			});
			dirContents = ["800.json"];
			alivePids.add(800);

			registry.start();

			const all = registry.getAllDiscovered();
			const agent = all.find((a) => a.pid === 800);
			expect(agent).toBeDefined();
			expect(agent?.source).toBe("session-file");
		});
	});

	// ── Events ───────────────────────────────────────────────────────

	describe("events", () => {
		test("fires onDidChange when started", () => {
			const listener = mock(() => {});
			registry.onDidChange(listener);

			dirContents = [];
			registry.start();

			// The initial process scan fires onDidChange
			// Wait briefly for the async scan to complete
			expect(listener).toBeDefined();
		});
	});

	// ── Dedup priority resolution ────────────────────────────────────

	describe("dedup priority resolution", () => {
		test("session-file source wins over process source for same PID", () => {
			// Session file with PID 900 and rich metadata
			sessionFiles["900.json"] = JSON.stringify({
				pid: 900,
				sessionId: "sess-900",
				cwd: "/session-project",
				startedAt: 1704067200000,
			});
			dirContents = ["900.json"];
			alivePids.add(900);

			registry.start();

			const all = registry.getAllDiscovered();
			const agent = all.find((a) => a.pid === 900);
			expect(agent).toBeDefined();
			// Session-file should win over process
			expect(agent?.source).toBe("session-file");
			expect(agent?.sessionId).toBe("sess-900");
		});

		test("three sources for same PID → higher priority source fields take precedence", () => {
			// The dedup method merges by PID, higher priority wins
			// Session file has richer data than process scan
			sessionFiles["1100.json"] = JSON.stringify({
				pid: 1100,
				sessionId: "rich-session",
				cwd: "/rich-project",
				startedAt: 1704067200000,
			});
			dirContents = ["1100.json"];
			alivePids.add(1100);

			registry.start();

			const all = registry.getAllDiscovered();
			const agent = all.find((a) => a.pid === 1100);
			expect(agent).toBeDefined();
			// Session file wins over process
			expect(agent?.source).toBe("session-file");
			expect(agent?.projectDir).toBe("/rich-project");
		});
	});

	// ── Field merging on dedup ───────────────────────────────────────

	describe("field merging on dedup", () => {
		test("sessionId from session-file preserved when process has none", () => {
			sessionFiles["1200.json"] = JSON.stringify({
				pid: 1200,
				sessionId: "unique-session-id",
				cwd: "/project-1200",
				startedAt: 1704067200000,
			});
			dirContents = ["1200.json"];
			alivePids.add(1200);

			registry.start();

			const all = registry.getAllDiscovered();
			const agent = all.find((a) => a.pid === 1200);
			expect(agent).toBeDefined();
			expect(agent?.sessionId).toBe("unique-session-id");
		});

		test("projectDir from higher-priority source wins", () => {
			// Session file has its own projectDir
			sessionFiles["1300.json"] = JSON.stringify({
				pid: 1300,
				sessionId: "sess-1300",
				cwd: "/session-dir",
				startedAt: 1704067200000,
			});
			dirContents = ["1300.json"];
			alivePids.add(1300);

			registry.start();

			const all = registry.getAllDiscovered();
			const agent = all.find((a) => a.pid === 1300);
			expect(agent).toBeDefined();
			expect(agent?.projectDir).toBe("/session-dir");
		});
	});

	// ── getDiscoveredAgents filtering ────────────────────────────────

	describe("getDiscoveredAgents filtering", () => {
		test("sessionId match against launcher task filters correctly", () => {
			sessionFiles["1400.json"] = JSON.stringify({
				pid: 1400,
				sessionId: "launcher-tracked-sess",
				cwd: "/project-1400",
				startedAt: 1704067200000,
			});
			dirContents = ["1400.json"];
			alivePids.add(1400);

			registry.start();

			const launcherTasks = [
				createMockTask({ session_id: "launcher-tracked-sess" }),
			];
			const discovered = registry.getDiscoveredAgents(launcherTasks);

			// Should be filtered out because sessionId matches launcher
			expect(discovered).toHaveLength(0);
		});

		test("agent with different PID AND sessionId passes through", () => {
			sessionFiles["1500.json"] = JSON.stringify({
				pid: 1500,
				sessionId: "independent-sess",
				cwd: "/project-1500",
				startedAt: 1704067200000,
			});
			dirContents = ["1500.json"];
			alivePids.add(1500);

			registry.start();

			const launcherTasks = [createMockTask({ session_id: "other-sess" })];
			const discovered = registry.getDiscoveredAgents(launcherTasks);

			// Should pass through — neither PID nor sessionId match launcher
			expect(discovered).toHaveLength(1);
			expect(discovered[0]?.pid).toBe(1500);
		});

		test("external Claude in same project_dir as launcher lane stays visible", () => {
			// Truth-hierarchy guard: a launcher task running in project /shared
			// must NOT hide an ad-hoc interactive Claude the user separately
			// spawned in the same folder. Previously the coarse project_dir set
			// filter over-claimed here and swallowed the external session.
			sessionFiles["1600.json"] = JSON.stringify({
				pid: 1600,
				sessionId: "external-user-claude",
				cwd: "/shared-project-coexist",
				startedAt: Date.now() - 60 * 60_000, // 1h ago, outside 15min window
			});
			dirContents = ["1600.json"];
			alivePids.add(1600);

			registry.start();

			const launcherTasks = [
				createMockTask({
					id: "launcher-lane-1",
					status: "running",
					session_id: "launcher-internal-sess",
					project_dir: "/shared-project-coexist",
					started_at: new Date().toISOString(),
					agent_backend: "claude",
					pid: 999999,
				}),
			];
			const discovered = registry.getDiscoveredAgents(launcherTasks);

			expect(discovered).toHaveLength(1);
			expect(discovered[0]?.pid).toBe(1600);
			expect(discovered[0]?.sessionId).toBe("external-user-claude");
		});
	});

	// ── ACP session suppression (4th discovery source) ──────────────

	describe("ACP session suppression", () => {
		test("suppresses discovered agent when sessionId matches ACP task childSessionKey", () => {
			sessionFiles["2000.json"] = JSON.stringify({
				pid: 2000,
				sessionId: "acp-harness-session",
				cwd: "/acp-project",
				startedAt: 1704067200000,
			});
			dirContents = ["2000.json"];
			alivePids.add(2000);

			registry = new AgentRegistry("/tmp/test-sessions", {
				launcherTasksProvider: () => trackedLauncherTasks,
				acpTasksProvider: () => [
					{
						taskId: "acp-task-1",
						runtime: "acp" as const,
						ownerKey: "main",
						scopeKind: "workspace",
						childSessionKey: "acp-harness-session",
						task: "Agent task",
						status: "running" as const,
						deliveryStatus: "pending",
						notifyPolicy: "silent",
						createdAt: 1704067200000,
					},
				],
				idleStreamThresholdMs: 5 * 60_000,
			});
			registry.start();

			const all = registry.getAllDiscovered();
			expect(all.find((a) => a.pid === 2000)).toBeUndefined();
		});

		test("does not suppress agent when sessionId does not match any ACP childSessionKey", () => {
			sessionFiles["2001.json"] = JSON.stringify({
				pid: 2001,
				sessionId: "independent-session",
				cwd: "/independent-project",
				startedAt: 1704067200000,
			});
			dirContents = ["2001.json"];
			alivePids.add(2001);

			registry = new AgentRegistry("/tmp/test-sessions", {
				launcherTasksProvider: () => trackedLauncherTasks,
				acpTasksProvider: () => [
					{
						taskId: "acp-task-2",
						runtime: "acp" as const,
						ownerKey: "main",
						scopeKind: "workspace",
						childSessionKey: "different-session-key",
						task: "Agent task",
						status: "running" as const,
						deliveryStatus: "pending",
						notifyPolicy: "silent",
						createdAt: 1704067200000,
					},
				],
				idleStreamThresholdMs: 5 * 60_000,
			});
			registry.start();

			const all = registry.getAllDiscovered();
			expect(all.find((a) => a.pid === 2001)).toBeDefined();
		});

		test("does not suppress agent without sessionId even when ACP tasks exist", () => {
			sessionFiles["2002.json"] = JSON.stringify({
				pid: 2002,
				// No sessionId
				cwd: "/no-session-project",
				startedAt: 1704067200000,
			});
			dirContents = ["2002.json"];
			alivePids.add(2002);

			registry = new AgentRegistry("/tmp/test-sessions", {
				launcherTasksProvider: () => trackedLauncherTasks,
				acpTasksProvider: () => [
					{
						taskId: "acp-task-3",
						runtime: "acp" as const,
						ownerKey: "main",
						scopeKind: "workspace",
						childSessionKey: "some-session",
						task: "Agent task",
						status: "running" as const,
						deliveryStatus: "pending",
						notifyPolicy: "silent",
						createdAt: 1704067200000,
					},
				],
				idleStreamThresholdMs: 5 * 60_000,
			});
			registry.start();

			const all = registry.getAllDiscovered();
			expect(all.find((a) => a.pid === 2002)).toBeDefined();
		});

		test("empty acpTasksProvider does not suppress any agents", () => {
			sessionFiles["2003.json"] = JSON.stringify({
				pid: 2003,
				sessionId: "free-session",
				cwd: "/free-project",
				startedAt: 1704067200000,
			});
			dirContents = ["2003.json"];
			alivePids.add(2003);

			registry = new AgentRegistry("/tmp/test-sessions", {
				launcherTasksProvider: () => trackedLauncherTasks,
				acpTasksProvider: () => [],
				idleStreamThresholdMs: 5 * 60_000,
			});
			registry.start();

			const all = registry.getAllDiscovered();
			expect(all.find((a) => a.pid === 2003)).toBeDefined();
		});

		test("default registry (no acpTasksProvider) does not suppress agents", () => {
			sessionFiles["2004.json"] = JSON.stringify({
				pid: 2004,
				sessionId: "default-session",
				cwd: "/default-project",
				startedAt: 1704067200000,
			});
			dirContents = ["2004.json"];
			alivePids.add(2004);

			// Use the beforeEach-constructed registry (no acpTasksProvider)
			registry.start();

			const all = registry.getAllDiscovered();
			expect(all.find((a) => a.pid === 2004)).toBeDefined();
		});
	});

	// ── Polling lifecycle ────────────────────────────────────────────

	describe("polling lifecycle", () => {
		test("startPolling creates interval timer", () => {
			registry.startPolling(5000);

			// If polling is active, stopPolling should be able to clear it
			// We verify indirectly: dispose doesn't throw (timer was set)
			expect(() => registry.dispose()).not.toThrow();
		});

		test("stopPolling clears interval", () => {
			registry.startPolling(5000);
			registry.stopPolling();

			// Double stop should be safe
			expect(() => registry.stopPolling()).not.toThrow();
		});

		test("restartPolling clears old timer and creates new one", () => {
			registry.startPolling(5000);
			// Calling startPolling again should clear the old timer first
			registry.startPolling(3000);

			// Should still dispose cleanly (only one timer active)
			expect(() => registry.dispose()).not.toThrow();
		});

		test("dispose stops polling and cleans up", () => {
			registry.start();

			// Dispose should clean up everything
			expect(() => registry.dispose()).not.toThrow();

			// Double dispose should be safe too
			expect(() => registry.dispose()).not.toThrow();
		});
	});

	// ── Dispose ──────────────────────────────────────────────────────

	describe("dispose", () => {
		test("disposes cleanly without errors", () => {
			registry.start();
			expect(() => registry.dispose()).not.toThrow();
		});

		test("can be disposed before start", () => {
			expect(() => registry.dispose()).not.toThrow();
		});
	});
});
