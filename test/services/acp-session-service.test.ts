import { beforeEach, describe, expect, mock, test } from "bun:test";
import { waitFor } from "../helpers/wait-for.js";

let execFileSyncResult: string | Error = "[]";
let execFileSyncCalls: Array<{ cmd: string; args: string[] }> = [];
let execFileResult: string | Error = "";
let execFileCalls: Array<{ cmd: string; args: string[] }> = [];

let watchCallback: ((event: string, filename: string) => void) | null = null;
let watchClosed = false;

mock.module("node:child_process", () => ({
	execFileSync: (cmd: string, args: string[], _opts?: unknown) => {
		execFileSyncCalls.push({ cmd, args });
		if (execFileSyncResult instanceof Error) throw execFileSyncResult;
		return execFileSyncResult;
	},
	execFile: (
		cmd: string,
		args: string[],
		_opts: unknown,
		cb: (err: Error | null, stdout: string) => void,
	) => {
		execFileCalls.push({ cmd, args });
		if (execFileResult instanceof Error) {
			cb(execFileResult, "");
		} else {
			cb(null, execFileResult);
		}
	},
}));

mock.module("node:fs", () => ({
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
		execFileSyncResult = "[]";
		execFileSyncCalls = [];
		execFileResult = "";
		execFileCalls = [];
		watchCallback = null;
		watchClosed = false;
	});

	test("uses --runtime acp flag in CLI call", () => {
		execFileSyncResult = JSON.stringify(sampleAcpTasks);
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});

		expect(at(execFileSyncCalls, 0).cmd).toBe("openclaw");
		expect(at(execFileSyncCalls, 0).args).toContain("--runtime");
		expect(at(execFileSyncCalls, 0).args).toContain("acp");
		service.dispose();
	});

	test("parses valid ACP task list output", () => {
		execFileSyncResult = JSON.stringify(sampleAcpTasks);
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});

		const tasks = service.getTasks();
		expect(tasks).toHaveLength(2);
		expect(tasks.map((t) => t.taskId)).toContain("acp-1");
		expect(tasks.map((t) => t.taskId)).toContain("acp-2");
		service.dispose();
	});

	test("filters out non-ACP runtime tasks from response", () => {
		// Even if the CLI returns non-acp tasks, we filter them out
		execFileSyncResult = JSON.stringify([...sampleAcpTasks, nonAcpTask]);
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});

		const tasks = service.getTasks();
		expect(tasks.every((t) => t.runtime === "acp")).toBe(true);
		expect(tasks.map((t) => t.taskId)).not.toContain("cron-1");
		service.dispose();
	});

	test("handles ENOENT (OpenClaw not installed)", () => {
		const err = new Error("spawn openclaw ENOENT") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		execFileSyncResult = err;

		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});

		expect(service.getTasks()).toHaveLength(0);
		expect(service.isInstalled).toBe(false);
		service.dispose();
	});

	test("handles non-zero exit and keeps last known state", () => {
		execFileSyncResult = JSON.stringify(sampleAcpTasks);
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});
		expect(service.getTasks()).toHaveLength(2);

		const err = new Error("exit code 1") as NodeJS.ErrnoException;
		err.code = "ERR_CHILD_PROCESS";
		execFileSyncResult = err;
		service.reload();

		expect(service.getTasks()).toHaveLength(2);
		expect(service.isInstalled).toBe(true);
		service.dispose();
	});

	test("getRunningTasks returns only queued and running tasks", () => {
		execFileSyncResult = JSON.stringify(sampleAcpTasks);
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});

		const running = service.getRunningTasks();
		expect(running).toHaveLength(1);
		expect(at(running, 0).taskId).toBe("acp-1");
		service.dispose();
	});

	test("getTaskById returns the correct task", () => {
		execFileSyncResult = JSON.stringify(sampleAcpTasks);
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});

		const task = service.getTaskById("acp-1");
		expect(task).toBeDefined();
		expect(task?.childSessionKey).toBe("session-abc123");
		service.dispose();
	});

	test("debounce fires only once for rapid file changes", async () => {
		execFileSyncResult = JSON.stringify(sampleAcpTasks);
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
		execFileSyncResult = JSON.stringify(sampleAcpTasks);
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
		execFileSyncResult = JSON.stringify(sampleAcpTasks);
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

	test("returns empty array for empty CLI output", () => {
		execFileSyncResult = "";
		const service = new AcpSessionService({ debounceMs: 1 });
		service.start(() => {});

		expect(service.getTasks()).toHaveLength(0);
		service.dispose();
	});
});
