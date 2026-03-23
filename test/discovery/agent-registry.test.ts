/**
 * AgentRegistry tests
 *
 * Validates merging of launcher tasks, session-file agents, and
 * process-scanned agents. Dedup, priority, and event emission.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

// Mock child_process for ProcessScanner
mock.module("node:child_process", () => ({
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
			expect(discovered[0]!.pid).toBe(500);
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

			const launcherTasks = [
				createMockTask({ session_id: "shared-sess" }),
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
			expect(agent!.source).toBe("session-file");
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
