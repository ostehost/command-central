/**
 * SessionWatcher tests
 *
 * Validates parsing of ~/.claude/sessions/ JSON files and
 * file watcher event handling. All filesystem access is mocked.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as path from "node:path";

// Track fs.watch callbacks so we can trigger them in tests
let watchCallback: ((event: string, filename: string | null) => void) | null =
	null;
const mockWatcher = {
	close: mock(() => {}),
	on: mock(() => {}),
};

// Mocked file contents keyed by filename
let sessionFiles: Record<string, string> = {};
let dirContents: string[] = [];

import * as realFs from "node:fs";

mock.module("node:fs", () => ({
	...realFs,
	readdirSync: (_dir: string) => dirContents,
	readFileSync: (filePath: string, _enc: string) => {
		const filename = path.basename(filePath);
		const content = sessionFiles[filename];
		if (content === undefined) throw new Error("ENOENT");
		return content;
	},
	watch: (
		_dir: string,
		cb: (event: string, filename: string | null) => void,
	) => {
		watchCallback = cb;
		return mockWatcher;
	},
}));

// Mock process.kill for isProcessAlive checks
const originalKill = process.kill;
let alivePids: Set<number> = new Set();
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

import { SessionWatcher } from "../../src/discovery/session-watcher.js";

describe("SessionWatcher", () => {
	let watcher: SessionWatcher;

	beforeEach(() => {
		sessionFiles = {};
		dirContents = [];
		alivePids = new Set();
		watchCallback = null;
		mockWatcher.close.mockClear();
		mockWatcher.on.mockClear();

		watcher = new SessionWatcher("/tmp/test-sessions");
	});

	// ── Parsing valid session files ──────────────────────────────────

	describe("valid session parsing", () => {
		test("parses a valid session JSON file on full scan", () => {
			const session = {
				pid: 12345,
				sessionId: "sess-abc",
				cwd: "/home/user/project",
				startedAt: 1704067200000,
			};
			sessionFiles["12345.json"] = JSON.stringify(session);
			dirContents = ["12345.json"];
			alivePids.add(12345);

			watcher.start();
			const agents = watcher.getAgents();

			expect(agents).toHaveLength(1);
			expect(agents[0]?.pid).toBe(12345);
			expect(agents[0]?.projectDir).toBe("/home/user/project");
			expect(agents[0]?.sessionId).toBe("sess-abc");
			expect(agents[0]?.source).toBe("session-file");
		});

		test("discovers multiple session files", () => {
			sessionFiles["100.json"] = JSON.stringify({
				pid: 100,
				sessionId: "s1",
				cwd: "/project-a",
				startedAt: 1704067200000,
			});
			sessionFiles["200.json"] = JSON.stringify({
				pid: 200,
				sessionId: "s2",
				cwd: "/project-b",
				startedAt: 1704067300000,
			});
			dirContents = ["100.json", "200.json"];
			alivePids.add(100);
			alivePids.add(200);

			watcher.start();
			expect(watcher.getAgents()).toHaveLength(2);
		});
	});

	// ── Handling malformed/empty JSON ────────────────────────────────

	describe("malformed session files", () => {
		test("skips file with invalid JSON", () => {
			sessionFiles["bad.json"] = "not json {{{";
			dirContents = ["bad.json"];

			watcher.start();
			expect(watcher.getAgents()).toHaveLength(0);
		});

		test("skips file with missing required fields", () => {
			sessionFiles["incomplete.json"] = JSON.stringify({ pid: 999 });
			dirContents = ["incomplete.json"];

			watcher.start();
			expect(watcher.getAgents()).toHaveLength(0);
		});

		test("skips file with wrong field types", () => {
			sessionFiles["wrong-types.json"] = JSON.stringify({
				pid: "not-a-number",
				cwd: 42,
				startedAt: "not-a-number",
			});
			dirContents = ["wrong-types.json"];

			watcher.start();
			expect(watcher.getAgents()).toHaveLength(0);
		});

		test("handles empty directory gracefully", () => {
			dirContents = [];
			watcher.start();
			expect(watcher.getAgents()).toHaveLength(0);
		});
	});

	// ── File watcher events ──────────────────────────────────────────

	describe("file watcher events", () => {
		test("adds agent when new session file appears", () => {
			dirContents = [];
			watcher.start();
			expect(watcher.getAgents()).toHaveLength(0);

			// Simulate new file via watch callback
			sessionFiles["555.json"] = JSON.stringify({
				pid: 555,
				sessionId: "new-sess",
				cwd: "/new-project",
				startedAt: 1704068000000,
			});
			alivePids.add(555);
			watchCallback?.("change", "555.json");

			expect(watcher.getAgents()).toHaveLength(1);
			expect(watcher.getAgents()[0]?.pid).toBe(555);
		});

		test("updates agent when session file changes", () => {
			sessionFiles["777.json"] = JSON.stringify({
				pid: 777,
				sessionId: "s-old",
				cwd: "/old-dir",
				startedAt: 1704067200000,
			});
			dirContents = ["777.json"];
			alivePids.add(777);

			watcher.start();
			expect(watcher.getAgents()[0]?.projectDir).toBe("/old-dir");

			// Update file content
			sessionFiles["777.json"] = JSON.stringify({
				pid: 777,
				sessionId: "s-new",
				cwd: "/new-dir",
				startedAt: 1704067200000,
			});
			watchCallback?.("change", "777.json");

			expect(watcher.getAgents()[0]?.projectDir).toBe("/new-dir");
		});

		test("removes agent when process is no longer alive", () => {
			sessionFiles["888.json"] = JSON.stringify({
				pid: 888,
				sessionId: "s-dead",
				cwd: "/dead-project",
				startedAt: 1704067200000,
			});
			dirContents = ["888.json"];
			alivePids.add(888);

			watcher.start();
			expect(watcher.getAgents()).toHaveLength(1);

			// Process dies
			alivePids.delete(888);
			watchCallback?.("change", "888.json");

			expect(watcher.getAgents()).toHaveLength(0);
		});

		test("ignores non-JSON filenames", () => {
			dirContents = [];
			watcher.start();

			watchCallback?.("change", "readme.txt");
			expect(watcher.getAgents()).toHaveLength(0);
		});

		test("ignores null filename", () => {
			dirContents = [];
			watcher.start();

			watchCallback?.("change", null);
			expect(watcher.getAgents()).toHaveLength(0);
		});
	});

	// ── Dedup by PID ─────────────────────────────────────────────────

	describe("dedup by PID", () => {
		test("same PID updates in place rather than duplicating", () => {
			sessionFiles["123.json"] = JSON.stringify({
				pid: 123,
				sessionId: "v1",
				cwd: "/dir-v1",
				startedAt: 1704067200000,
			});
			dirContents = ["123.json"];
			alivePids.add(123);

			watcher.start();
			expect(watcher.getAgents()).toHaveLength(1);

			// Same PID, updated content
			sessionFiles["123.json"] = JSON.stringify({
				pid: 123,
				sessionId: "v2",
				cwd: "/dir-v2",
				startedAt: 1704067200000,
			});
			watchCallback?.("change", "123.json");

			const agents = watcher.getAgents();
			expect(agents).toHaveLength(1);
			expect(agents[0]?.sessionId).toBe("v2");
		});
	});

	// ── Dispose ──────────────────────────────────────────────────────

	describe("dispose", () => {
		test("cleans up watcher and agents on dispose", () => {
			sessionFiles["999.json"] = JSON.stringify({
				pid: 999,
				sessionId: "s",
				cwd: "/dir",
				startedAt: 1704067200000,
			});
			dirContents = ["999.json"];
			alivePids.add(999);

			watcher.start();
			expect(watcher.getAgents()).toHaveLength(1);

			watcher.dispose();
			expect(watcher.getAgents()).toHaveLength(0);
			expect(mockWatcher.close).toHaveBeenCalled();
		});
	});

	// ── onChange callback ────────────────────────────────────────────

	describe("onChange callback", () => {
		test("calls onChange when new agent discovered", () => {
			const onChange = mock(() => {});
			dirContents = [];
			watcher.start(onChange);

			sessionFiles["111.json"] = JSON.stringify({
				pid: 111,
				sessionId: "s",
				cwd: "/dir",
				startedAt: 1704067200000,
			});
			alivePids.add(111);
			watchCallback?.("change", "111.json");

			expect(onChange).toHaveBeenCalled();
		});

		test("calls onChange when agent removed (process died)", () => {
			const onChange = mock(() => {});
			sessionFiles["222.json"] = JSON.stringify({
				pid: 222,
				sessionId: "s",
				cwd: "/dir",
				startedAt: 1704067200000,
			});
			dirContents = ["222.json"];
			alivePids.add(222);

			watcher.start(onChange);
			onChange.mockClear();

			alivePids.delete(222);
			watchCallback?.("change", "222.json");

			expect(onChange).toHaveBeenCalled();
		});
	});
});
