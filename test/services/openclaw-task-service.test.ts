import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
	isTerminalStatus,
	openclawStatusToIcon,
	openclawStatusToLabel,
} from "../../src/types/openclaw-task-types.js";

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

mock.module("vscode", () => ({
	ThemeIcon: class {
		constructor(
			public id: string,
			public color?: { id: string },
		) {}
	},
	ThemeColor: class {
		constructor(public id: string) {}
	},
}));

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
		execFileSyncResult = "[]";
		execFileSyncCalls = [];
		execFileResult = "";
		execFileCalls = [];
		watchCallback = null;
		watchClosed = false;
	});

	test("parses valid openclaw tasks list output", () => {
		execFileSyncResult = JSON.stringify(sampleTasks);
		const service = new OpenClawTaskService();
		service.start(() => {});

		const tasks = service.getTasks();
		expect(tasks).toHaveLength(1);
		expect(at(tasks, 0).taskId).toBe("task-1");
		service.dispose();
	});

	test("handles ENOENT (OpenClaw not installed)", () => {
		const err = new Error("spawn openclaw ENOENT") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		execFileSyncResult = err;

		const service = new OpenClawTaskService();
		service.start(() => {});

		expect(service.getTasks()).toHaveLength(0);
		expect(service.isInstalled).toBe(false);
		service.dispose();
	});

	test("handles non-zero exit and keeps last known state", () => {
		execFileSyncResult = JSON.stringify(sampleTasks);
		const service = new OpenClawTaskService();
		service.start(() => {});
		expect(service.getTasks()).toHaveLength(1);

		const err = new Error("exit code 1") as NodeJS.ErrnoException;
		err.code = "ERR_CHILD_PROCESS";
		execFileSyncResult = err;
		service.reload();

		expect(service.getTasks()).toHaveLength(1);
		expect(service.isInstalled).toBe(true);
		service.dispose();
	});

	test("debounce fires only once for rapid file changes", async () => {
		execFileSyncResult = JSON.stringify(sampleTasks);
		let callbackCount = 0;
		const service = new OpenClawTaskService();
		service.start(() => {
			callbackCount++;
		});

		watchCallback?.("change", "runs.sqlite-wal");
		watchCallback?.("change", "runs.sqlite-wal");
		watchCallback?.("change", "runs.sqlite-wal");

		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(callbackCount).toBe(1);
		service.dispose();
	});

	test("file watcher triggers reload callback", async () => {
		execFileSyncResult = JSON.stringify(sampleTasks);
		let callbackCount = 0;
		const service = new OpenClawTaskService();
		service.start(() => {
			callbackCount++;
		});

		watchCallback?.("change", "runs.sqlite");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(callbackCount).toBe(1);
		service.dispose();
	});

	test("cancelTask calls correct CLI command", async () => {
		const service = new OpenClawTaskService();
		service.start(() => {});

		await service.cancelTask("task-1");
		expect(at(execFileCalls, 0).cmd).toBe("openclaw");
		expect(at(execFileCalls, 0).args).toEqual(["tasks", "cancel", "task-1"]);
		service.dispose();
	});

	test("setNotifyPolicy calls correct CLI command", async () => {
		const service = new OpenClawTaskService();
		service.start(() => {});

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
		const service = new OpenClawTaskService();
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
