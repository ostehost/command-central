import { beforeEach, describe, expect, mock, test } from "bun:test";
import { waitFor } from "../helpers/wait-for.js";

// Frozen real-module snapshots stashed by test/setup/global-test-cleanup.ts at
// worker startup. Spreading them so unmocked fs/child_process calls fall
// through to the real implementation keeps this file's partial mocks from
// leaking `undefined` methods into later test files — mock.module is
// process-global in Bun. See test/MOCK_HYGIENE.md.
const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");
const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof import("node:fs");

// Reload now flows through the async execFile path (PAR-68 / CP-29):
// reload() returns synchronously and resolves the CLI off the event loop.
// `execFileResult` drives the resolved stdout (or thrown Error) and
// `execFilePending`, when set, holds the callback so a test can control
// exactly when the CLI resolves — used to prove start() does not block.
let execFileResult: string | Error = "[]";
let execFileCalls: Array<{ cmd: string; args: string[] }> = [];
let execFilePending:
	| ((cb: (err: Error | null, stdout: string) => void) => void)
	| null = null;

let watchCallback: ((event: string, filename: string) => void) | null = null;
let watchClosed = false;

mock.module("node:child_process", () => ({
	...realChildProcess,
	execFile: (
		cmd: string,
		args: string[],
		_opts: unknown,
		cb: (err: Error | null, stdout: string) => void,
	) => {
		execFileCalls.push({ cmd, args });
		if (execFilePending) {
			execFilePending(cb);
			return;
		}
		if (execFileResult instanceof Error) {
			cb(execFileResult, "");
		} else {
			cb(null, execFileResult);
		}
	},
}));

mock.module("node:fs", () => ({
	...realFs,
	watch: (_dir: string, cb: (event: string, filename: string) => void) => {
		watchCallback = cb;
		watchClosed = false;
		return {
			close: () => {
				watchClosed = true;
			},
			on: () => {},
		};
	},
}));

const { AcpSessionService } = await import(
	"../../src/services/acp-session-service.js"
);

function at<T>(arr: T[], index: number): T {
	const el = arr[index];
	if (el === undefined) throw new Error(`No element at index ${index}`);
	return el;
}

const now = Date.now();
const sampleAcpTasks = [
	{
		taskId: "acp-1",
		runtime: "acp",
		ownerKey: "main",
		scopeKind: "workspace",
		childSessionKey: "session-abc123",
		task: "Run agent task",
		status: "running",
		deliveryStatus: "pending",
		notifyPolicy: "silent",
		createdAt: now - 5_000,
		startedAt: now - 4_000,
		lastEventAt: now - 1_000,
		progressSummary: "in progress",
	},
	{
		taskId: "acp-2",
		runtime: "acp",
		ownerKey: "main",
		scopeKind: "workspace",
		task: "Old task",
		status: "succeeded",
		deliveryStatus: "delivered",
		notifyPolicy: "done_only",
		createdAt: now - 5_000,
		endedAt: now - 1_000,
	},
];

const nonAcpTask = {
	taskId: "cron-1",
	runtime: "cron",
	ownerKey: "main",
	scopeKind: "workspace",
	task: "Nightly cron",
	status: "running",
	deliveryStatus: "pending",
	notifyPolicy: "silent",
	createdAt: now - 1_000,
	lastEventAt: now - 500,
};

describe("AcpSessionService", () => {
	beforeEach(() => {
		execFileResult = "[]";
		execFileCalls = [];
		execFilePending = null;
		watchCallback = null;
		watchClosed = false;
	});

	test("uses --runtime acp flag in CLI call", async () => {
		execFileResult = JSON.stringify(sampleAcpTasks);
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		expect(at(execFileCalls, 0).cmd).toBe("openclaw");
		expect(at(execFileCalls, 0).args).toContain("--runtime");
		expect(at(execFileCalls, 0).args).toContain("acp");
		service.dispose();
	});

	test("parses valid ACP task list output", async () => {
		execFileResult = JSON.stringify(sampleAcpTasks);
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		const tasks = service.getTasks();
		expect(tasks).toHaveLength(2);
		expect(tasks.map((t) => t.taskId)).toContain("acp-1");
		expect(tasks.map((t) => t.taskId)).toContain("acp-2");
		service.dispose();
	});

	test("filters out non-ACP runtime tasks from response", async () => {
		// Even if the CLI returns non-acp tasks, we filter them out
		execFileResult = JSON.stringify([...sampleAcpTasks, nonAcpTask]);
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		const tasks = service.getTasks();
		expect(tasks.every((t) => t.runtime === "acp")).toBe(true);
		expect(tasks.map((t) => t.taskId)).not.toContain("cron-1");
		service.dispose();
	});

	test("handles ENOENT (OpenClaw not installed)", async () => {
		const err = new Error("spawn openclaw ENOENT") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		execFileResult = err;

		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		expect(service.getTasks()).toHaveLength(0);
		expect(service.isInstalled).toBe(false);
		service.dispose();
	});

	test("handles non-zero exit and keeps last known state", async () => {
		execFileResult = JSON.stringify(sampleAcpTasks);
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();
		expect(service.getTasks()).toHaveLength(2);

		const err = new Error("exit code 1") as NodeJS.ErrnoException;
		err.code = "ERR_CHILD_PROCESS";
		execFileResult = err;
		await service.reloadAsync();

		expect(service.getTasks()).toHaveLength(2);
		expect(service.isInstalled).toBe(true);
		service.dispose();
	});

	test("getRunningTasks returns only queued and running tasks", async () => {
		execFileResult = JSON.stringify(sampleAcpTasks);
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		const running = service.getRunningTasks();
		expect(running).toHaveLength(1);
		expect(at(running, 0).taskId).toBe("acp-1");
		service.dispose();
	});

	test("getTaskById returns the correct task", async () => {
		execFileResult = JSON.stringify(sampleAcpTasks);
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		const task = service.getTaskById("acp-1");
		expect(task).toBeDefined();
		expect(task?.childSessionKey).toBe("session-abc123");
		service.dispose();
	});

	test("debounce fires only once for rapid file changes", async () => {
		execFileResult = JSON.stringify(sampleAcpTasks);
		let callbackCount = 0;
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {
			callbackCount++;
		});

		watchCallback?.("change", "runs.sqlite-wal");
		watchCallback?.("change", "runs.sqlite-wal");
		watchCallback?.("change", "runs.sqlite-wal");

		await waitFor(() => callbackCount === 1, {
			message:
				"ACP watcher debounce should collapse rapid WAL changes into one reload",
		});
		expect(callbackCount).toBe(1);
		service.dispose();
	});

	test("file watcher triggers reload on runs.sqlite change", async () => {
		execFileResult = JSON.stringify(sampleAcpTasks);
		let callbackCount = 0;
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {
			callbackCount++;
		});

		watchCallback?.("change", "runs.sqlite");
		await waitFor(() => callbackCount === 1, {
			message: "ACP watcher should reload after runs.sqlite changes",
		});
		expect(callbackCount).toBe(1);
		service.dispose();
	});

	test("file watcher ignores unrelated file changes", async () => {
		execFileResult = JSON.stringify(sampleAcpTasks);
		let callbackCount = 0;
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {
			callbackCount++;
		});

		watchCallback?.("change", "some-other-file.db");
		expect(callbackCount).toBe(0);
		service.dispose();
	});

	test("cancelTask calls correct CLI command", async () => {
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();
		execFileCalls = [];

		await service.cancelTask("acp-1");
		expect(at(execFileCalls, 0).cmd).toBe("openclaw");
		expect(at(execFileCalls, 0).args).toEqual(["tasks", "cancel", "acp-1"]);
		service.dispose();
	});

	test("dispose cleans up watcher and timer", () => {
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});

		service.dispose();
		expect(watchClosed).toBe(true);
		expect(service.getTasks()).toHaveLength(0);
	});

	test("returns empty array for empty CLI output", async () => {
		execFileResult = "";
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		expect(service.getTasks()).toHaveLength(0);
		service.dispose();
	});

	// ── PAR-68 / CP-29 regression: non-blocking async reload ─────────────
	// On the synchronous (execFileSync) implementation start() did not return
	// until the CLI finished, and tasks were populated before start() returned.
	// These tests assert start() returns BEFORE the CLI resolves and that
	// state lands only after the deferred CLI callback fires.
	test("start() returns before the CLI resolves (non-blocking reload)", async () => {
		const cli: { resolve: ((stdout: string) => void) | null } = {
			resolve: null,
		};
		execFilePending = (cb) => {
			cli.resolve = (stdout) => cb(null, stdout);
		};

		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});

		// start() has returned but the CLI has not resolved yet — on the old
		// execFileSync code this state was impossible (tasks already populated).
		expect(cli.resolve).not.toBeNull();
		expect(service.getTasks()).toHaveLength(0);

		// Resolve the CLI; tasks land only after the deferred callback fires.
		cli.resolve?.(JSON.stringify(sampleAcpTasks));
		await waitFor(() => service.getTasks().length === 2, {
			message: "tasks should populate after the deferred CLI resolves",
		});
		expect(service.getTasks()).toHaveLength(2);
		service.dispose();
	});

	test("concurrent reloads coalesce onto a single CLI invocation", async () => {
		const cli: { resolve: ((stdout: string) => void) | null } = {
			resolve: null,
		};
		execFilePending = (cb) => {
			cli.resolve = (stdout) => cb(null, stdout);
		};

		const service = new AcpSessionService({ debounceMs: 1 });
		const first = service.reloadAsync();
		const second = service.reloadAsync();
		const third = service.reloadAsync();

		// All three coalesce while the first run is in flight.
		expect(execFileCalls).toHaveLength(1);
		expect(second).toBe(first);
		expect(third).toBe(first);

		cli.resolve?.(JSON.stringify(sampleAcpTasks));
		await Promise.all([first, second, third]);
		expect(execFileCalls).toHaveLength(1);
		expect(service.getTasks()).toHaveLength(2);
		service.dispose();
	});
});
