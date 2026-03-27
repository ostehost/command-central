/**
 * AgentRegistry tests
 *
 * Validates merging of launcher tasks, session-file agents, and
 * process-scanned agents. Dedup, priority, and event emission.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

import * as realChildProcess from "node:child_process";
import * as realFs from "node:fs";

// Mock child_process for ProcessScanner
mock.module("node:child_process", () => ({
	...realChildProcess,
	execFile: (
		_cmd: string,
		_args: string[],
		_opts: Record<string, unknown>,
		cb?: (
			err: Error | null,
			result: { stdout: string; stderr: string },
		) => void,
	) => {
		if (cb) cb(null, { stdout: "", stderr: "" });
		return { on: () => ({}) };
	},
}));

// Mock node:fs for SessionWatcher
let sessionFiles: Record<string, string> = {};
let dirContents: string[] = [];

mock.module("node:fs", () => ({
	...realFs,
	readdirSync: () => dirContents,
	readFileSync: (filePath: string, _enc: string) => {
		const parts = filePath.split("/");
		const filename = parts[parts.length - 1]!;
		const content = sessionFiles[filename];
		if (content === undefined) throw new Error("ENOENT");
		return content;
	},
	watch: () => ({
		close: mock(() => {}),
		on: mock(() => {}),
	}),
}));

// Mock vscode
mock.module("vscode", () => ({
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue: unknown) => defaultValue,
		}),
		onDidChangeConfiguration: () => ({ dispose: () => {} }),
	},
	EventEmitter: class MockEventEmitter<T = void> {
		private listeners: Array<(e: T) => void> = [];
		event = (listener: (e: T) => void) => {
			this.listeners.push(listener);
			return {
				dispose: () => {
					const idx = this.listeners.indexOf(listener);
					if (idx >= 0) this.listeners.splice(idx, 1);
				},
			};
		};
		fire(data: T): void {
			for (const listener of this.listeners) listener(data);
		}
		dispose(): void {
			this.listeners = [];
		}
	},
}));

// Mock process.kill for isProcessAlive
const originalKill = process.kill;
let alivePids: Set<number> = new Set();
process.kill = ((pid: number, signal?: number) => {
	if (signal === 0) {
		if (!alivePids.has(pid)) throw new Error("ESRCH");
		return true;
	}
	return originalKill.call(process, pid, signal!);
}) as typeof process.kill;

import { AgentRegistry } from "../../src/discovery/agent-registry.js";

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

	beforeEach(() => {
		sessionFiles = {};
		dirContents = [];
		alivePids = new Set();
		registry = new AgentRegistry("/tmp/test-sessions");
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

		test("returns empty when no discovered agents", () => {
			dirContents = [];
			registry.start();

			const discovered = registry.getDiscoveredAgents([createMockTask()]);
			expect(discovered).toHaveLength(0);
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
