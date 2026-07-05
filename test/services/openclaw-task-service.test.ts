import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	isTerminalStatus,
	openclawStatusToIcon,
	openclawStatusToLabel,
} from "../../src/types/openclaw-task-types.js";
import { createVSCodeMock } from "../helpers/vscode-mock.js";
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

let execFileResult: string | Error = "[]";
let execFileCalls: Array<{ cmd: string; args: string[] }> = [];
// Delay (ms) before the mocked execFile callback fires; lets tests assert that
// reload() / start() return before the CLI resolves (no extension-host block).
let execFileDelayMs = 0;

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
		const fire = () => {
			if (execFileResult instanceof Error) {
				cb(execFileResult, "");
			} else {
				cb(null, execFileResult);
			}
		};
		if (execFileDelayMs > 0) {
			setTimeout(fire, execFileDelayMs);
		} else {
			fire();
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

// Spread the canonical mock so the vscode surface can never shrink below what a
// later-loading test relies on (the ThemeColor leak, CCSTD-06). The status-icon
// helpers only touch ThemeIcon/ThemeColor, both of which createVSCodeMock
// already provides.
mock.module("vscode", () => createVSCodeMock());

const { OpenClawTaskService } = await import(
	"../../src/services/openclaw-task-service.js"
);

function at<T>(arr: T[], index: number): T {
	const el = arr[index];
	if (el === undefined) throw new Error(`No element at index ${index}`);
	return el;
}

const now = Date.now();
const sampleTasks = [
	{
		taskId: "task-1",
		runtime: "cron",
		ownerKey: "main",
		scopeKind: "workspace",
		task: "Nightly summary",
		status: "running",
		deliveryStatus: "pending",
		notifyPolicy: "silent",
		createdAt: now - 10_000,
		lastEventAt: now - 2_000,
		progressSummary: "halfway there",
	},
	{
		taskId: "task-2",
		runtime: "cli",
		ownerKey: "main",
		scopeKind: "workspace",
		task: "Old task",
		status: "succeeded",
		deliveryStatus: "delivered",
		notifyPolicy: "done_only",
		createdAt: now - 10 * 24 * 60 * 60 * 1000,
	},
];

describe("OpenClawTaskService", () => {
	beforeEach(() => {
		execFileResult = "[]";
		execFileCalls = [];
		execFileDelayMs = 0;
		watchCallback = null;
		watchClosed = false;
	});

	test("parses valid openclaw tasks list output", async () => {
		execFileResult = JSON.stringify(sampleTasks);
		const service = new OpenClawTaskService({ debounceMs: 1 });
		service.start(() => {});
		await service.reload();

		const tasks = service.getTasks();
		expect(tasks).toHaveLength(1);
		expect(at(tasks, 0).taskId).toBe("task-1");
		service.dispose();
	});

	test("handles ENOENT (OpenClaw not installed)", async () => {
		const err = new Error("spawn openclaw ENOENT") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		execFileResult = err;

		const service = new OpenClawTaskService({ debounceMs: 1 });
		service.start(() => {});
		await service.reload();

		expect(service.getTasks()).toHaveLength(0);
		expect(service.isInstalled).toBe(false);
		service.dispose();
	});

	test("handles non-zero exit and keeps last known state", async () => {
		execFileResult = JSON.stringify(sampleTasks);
		const service = new OpenClawTaskService({ debounceMs: 1 });
		service.start(() => {});
		await service.reload();
		expect(service.getTasks()).toHaveLength(1);

		const err = new Error("exit code 1") as NodeJS.ErrnoException;
		err.code = "ERR_CHILD_PROCESS";
		execFileResult = err;
		await service.reload();

		expect(service.getTasks()).toHaveLength(1);
		expect(service.isInstalled).toBe(true);
		service.dispose();
	});

	test("reload does not block the caller and updates tasks after the CLI resolves", async () => {
		// Slow CLI: the mocked execFile callback fires only after a delay.
		execFileResult = JSON.stringify(sampleTasks);
		execFileDelayMs = 50;
		const service = new OpenClawTaskService({ debounceMs: 1 });

		// start() must return before the slow CLI resolves (no synchronous block).
		service.start(() => {});
		expect(service.getTasks()).toHaveLength(0);

		await waitFor(() => service.getTasks().length === 1, {
			message:
				"OpenClaw reload should populate tasks after the async CLI resolves",
		});
		expect(at(service.getTasks(), 0).taskId).toBe("task-1");
		service.dispose();
	});

	test("a reload resolving after dispose() does not resurrect tasks", async () => {
		// Slow CLI so the reload is still in flight when we dispose.
		execFileResult = JSON.stringify(sampleTasks);
		execFileDelayMs = 50;
		const service = new OpenClawTaskService({ debounceMs: 1 });

		const run = service.reload();
		expect(service.getTasks()).toHaveLength(0);

		// Tear down before the in-flight CLI resolves; the late result must be
		// discarded, not applied to the torn-down service.
		service.dispose();
		await run;
		await waitFor(() => true, { message: "let any late assignment flush" });
		expect(service.getTasks()).toHaveLength(0);
	});

	test("coalesces overlapping reloads into a single in-flight CLI read", async () => {
		execFileResult = JSON.stringify(sampleTasks);
		execFileDelayMs = 50;
		const service = new OpenClawTaskService({ debounceMs: 1 });

		// Three overlapping reloads while the first is still in flight.
		const first = service.reload();
		const second = service.reload();
		const third = service.reload();
		expect(first).toBe(second);
		expect(second).toBe(third);

		await Promise.all([first, second, third]);
		expect(execFileCalls).toHaveLength(1);
		service.dispose();
	});

	test("debounce fires only once for rapid file changes", async () => {
		execFileResult = JSON.stringify(sampleTasks);
		let callbackCount = 0;
		const service = new OpenClawTaskService({ debounceMs: 1 });
		service.start(() => {
			callbackCount++;
		});

		watchCallback?.("change", "runs.sqlite-wal");
		watchCallback?.("change", "runs.sqlite-wal");
		watchCallback?.("change", "runs.sqlite-wal");

		await waitFor(() => callbackCount === 1, {
			message:
				"OpenClaw watcher debounce should collapse rapid WAL changes into one reload",
		});
		expect(callbackCount).toBe(1);
		service.dispose();
	});

	test("file watcher triggers reload callback", async () => {
		execFileResult = JSON.stringify(sampleTasks);
		let callbackCount = 0;
		const service = new OpenClawTaskService({ debounceMs: 1 });
		service.start(() => {
			callbackCount++;
		});

		watchCallback?.("change", "runs.sqlite");
		await waitFor(() => callbackCount === 1, {
			message: "OpenClaw watcher should reload after runs.sqlite changes",
		});
		expect(callbackCount).toBe(1);
		service.dispose();
	});

	test("cancelTask calls correct CLI command", async () => {
		const service = new OpenClawTaskService({ debounceMs: 1 });
		service.start(() => {});
		await service.reload();
		// Ignore the startup reload's execFile call.
		execFileCalls = [];

		await service.cancelTask("task-1");
		expect(at(execFileCalls, 0).cmd).toBe("openclaw");
		expect(at(execFileCalls, 0).args).toEqual(["tasks", "cancel", "task-1"]);
		service.dispose();
	});

	test("setNotifyPolicy calls correct CLI command", async () => {
		const service = new OpenClawTaskService({ debounceMs: 1 });
		service.start(() => {});
		await service.reload();
		// Ignore the startup reload's execFile call.
		execFileCalls = [];

		await service.setNotifyPolicy("task-1", "state_changes");
		expect(at(execFileCalls, 0).args).toEqual([
			"tasks",
			"notify",
			"task-1",
			"state_changes",
		]);
		service.dispose();
	});

	test("dispose cleans up watcher and timer", () => {
		const service = new OpenClawTaskService({ debounceMs: 1 });
		service.start(() => {});

		service.dispose();
		expect(watchClosed).toBe(true);
		expect(service.getTasks()).toHaveLength(0);
	});
});

describe("openclaw task status helpers", () => {
	test("maps all statuses to labels and icons", () => {
		const statuses = [
			"queued",
			"running",
			"succeeded",
			"failed",
			"timed_out",
			"cancelled",
			"lost",
			"blocked",
		] as const;

		expect(statuses.map((status) => openclawStatusToLabel(status))).toEqual([
			"Queued",
			"Running",
			"Done",
			"Failed",
			"Timed Out",
			"Cancelled",
			"Lost",
			"Needs Approval",
		]);
		expect(statuses.map((status) => openclawStatusToIcon(status).id)).toEqual([
			"loading~spin",
			"pulse",
			"check",
			"error",
			"watch",
			"circle-slash",
			"warning",
			"shield",
		]);
	});

	test("blocked is treated as a terminal status", () => {
		expect(isTerminalStatus("blocked")).toBe(true);
		expect(isTerminalStatus("running")).toBe(false);
	});
});
