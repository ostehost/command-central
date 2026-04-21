import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	isTerminalFlowStatus,
	taskflowStatusToIcon,
	taskflowStatusToLabel,
} from "../../src/types/taskflow-types.js";
import { waitFor } from "../helpers/wait-for.js";

let execFileSyncResult: string | Error = '{"count":0,"status":null,"flows":[]}';
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

const { TaskFlowService } = await import(
	"../../src/services/taskflow-service.js"
);

function at<T>(arr: T[], index: number): T {
	const el = arr[index];
	if (el === undefined) throw new Error(`No element at index ${index}`);
	return el;
}

const now = Date.now();
const sampleFlows = {
	count: 2,
	status: null,
	flows: [
		{
			flowId: "flow-1",
			label: "Deploy pipeline",
			status: "running",
			agentId: "coder",
			createdAt: now - 10_000,
			startedAt: now - 8_000,
			taskCount: 5,
			completedCount: 3,
			failedCount: 0,
		},
		{
			flowId: "flow-2",
			label: "Old flow",
			status: "succeeded",
			agentId: "main",
			createdAt: now - 10 * 24 * 60 * 60 * 1000,
			startedAt: now - 10 * 24 * 60 * 60 * 1000 + 1000,
			endedAt: now - 10 * 24 * 60 * 60 * 1000 + 5000,
			taskCount: 2,
			completedCount: 2,
			failedCount: 0,
		},
	],
};

describe("TaskFlowService", () => {
	beforeEach(() => {
		execFileSyncResult = '{"count":0,"status":null,"flows":[]}';
		execFileSyncCalls = [];
		execFileResult = "";
		execFileCalls = [];
		watchCallback = null;
		watchClosed = false;
	});

	test("parses valid flow list output", () => {
		execFileSyncResult = JSON.stringify(sampleFlows);
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});

		const flows = service.getFlows();
		expect(flows).toHaveLength(1);
		expect(at(flows, 0).flowId).toBe("flow-1");
		service.dispose();
	});

	test("preserves nested flow tasks from CLI output", () => {
		execFileSyncResult = JSON.stringify({
			count: 1,
			status: null,
			flows: [
				{
					flowId: "flow-with-tasks",
					status: "running",
					createdAt: now - 1000,
					taskCount: 1,
					completedCount: 0,
					failedCount: 0,
					tasks: [
						{
							taskId: "task-1",
							runtime: "subagent",
							ownerKey: "main",
							scopeKind: "session",
							task: "Do the thing",
							status: "running",
							deliveryStatus: "pending",
							notifyPolicy: "done_only",
							createdAt: now - 900,
							childSessionKey: "session-123",
						},
					],
				},
			],
		});
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});

		const flow = at(service.getFlows(), 0);
		expect(flow.tasks).toHaveLength(1);
		expect(flow.tasks?.[0]?.taskId).toBe("task-1");
		expect(flow.tasks?.[0]?.childSessionKey).toBe("session-123");
		service.dispose();
	});

	test("calls correct CLI command", () => {
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});

		expect(at(execFileSyncCalls, 0).cmd).toBe("openclaw");
		expect(at(execFileSyncCalls, 0).args).toEqual([
			"tasks",
			"flow",
			"list",
			"--json",
		]);
		service.dispose();
	});

	test("handles ENOENT (OpenClaw not installed)", () => {
		const err = new Error("spawn openclaw ENOENT") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		execFileSyncResult = err;

		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});

		expect(service.getFlows()).toHaveLength(0);
		expect(service.isInstalled).toBe(false);
		service.dispose();
	});

	test("handles non-zero exit and keeps last known state", () => {
		execFileSyncResult = JSON.stringify(sampleFlows);
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});
		expect(service.getFlows()).toHaveLength(1);

		const err = new Error("exit code 1") as NodeJS.ErrnoException;
		err.code = "ERR_CHILD_PROCESS";
		execFileSyncResult = err;
		service.reload();

		expect(service.getFlows()).toHaveLength(1);
		expect(service.isInstalled).toBe(true);
		service.dispose();
	});

	test("getActiveFlows filters to active statuses", () => {
		const flowsWithMixed = {
			count: 3,
			status: null,
			flows: [
				{
					flowId: "f1",
					status: "running",
					createdAt: now - 1000,
					taskCount: 1,
					completedCount: 0,
					failedCount: 0,
				},
				{
					flowId: "f2",
					status: "queued",
					createdAt: now - 2000,
					taskCount: 1,
					completedCount: 0,
					failedCount: 0,
				},
				{
					flowId: "f3",
					status: "succeeded",
					createdAt: now - 3000,
					taskCount: 1,
					completedCount: 1,
					failedCount: 0,
				},
				{
					flowId: "f4",
					status: "waiting",
					createdAt: now - 500,
					taskCount: 2,
					completedCount: 0,
					failedCount: 0,
				},
			],
		};
		execFileSyncResult = JSON.stringify(flowsWithMixed);
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});

		const active = service.getActiveFlows();
		expect(active).toHaveLength(3);
		expect(active.map((f) => f.flowId).sort()).toEqual(["f1", "f2", "f4"]);
		service.dispose();
	});

	test("getRecentFlows returns sorted and limited results", () => {
		const manyFlows = {
			count: 3,
			status: null,
			flows: [
				{
					flowId: "oldest",
					status: "succeeded",
					createdAt: now - 1000,
					endedAt: now - 800,
					taskCount: 1,
					completedCount: 1,
					failedCount: 0,
				},
				{
					flowId: "newest",
					status: "running",
					createdAt: now - 500,
					startedAt: now - 400,
					taskCount: 1,
					completedCount: 0,
					failedCount: 0,
				},
				{
					flowId: "middle",
					status: "failed",
					createdAt: now - 700,
					endedAt: now - 600,
					taskCount: 1,
					completedCount: 0,
					failedCount: 1,
				},
			],
		};
		execFileSyncResult = JSON.stringify(manyFlows);
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});

		const recent = service.getRecentFlows(2);
		expect(recent).toHaveLength(2);
		expect(at(recent, 0).flowId).toBe("newest");
		expect(at(recent, 1).flowId).toBe("middle");
		service.dispose();
	});

	test("debounce fires only once for rapid file changes", async () => {
		execFileSyncResult = JSON.stringify(sampleFlows);
		let callbackCount = 0;
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {
			callbackCount++;
		});

		watchCallback?.("change", "runs.sqlite-wal");
		watchCallback?.("change", "runs.sqlite-wal");
		watchCallback?.("change", "runs.sqlite-wal");

		await waitFor(() => callbackCount === 1, {
			message:
				"TaskFlow watcher debounce should collapse rapid WAL changes into one reload",
		});
		expect(callbackCount).toBe(1);
		service.dispose();
	});

	test("file watcher triggers reload callback", async () => {
		execFileSyncResult = JSON.stringify(sampleFlows);
		let callbackCount = 0;
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {
			callbackCount++;
		});

		watchCallback?.("change", "runs.sqlite");
		await waitFor(() => callbackCount === 1, {
			message: "TaskFlow watcher should reload after runs.sqlite changes",
		});
		expect(callbackCount).toBe(1);
		service.dispose();
	});

	test("cancelFlow calls correct CLI command", async () => {
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});

		await service.cancelFlow("flow-1");
		expect(at(execFileCalls, 0).cmd).toBe("openclaw");
		expect(at(execFileCalls, 0).args).toEqual([
			"tasks",
			"flow",
			"cancel",
			"flow-1",
		]);
		service.dispose();
	});

	test("dispose cleans up watcher and timer", () => {
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});

		service.dispose();
		expect(watchClosed).toBe(true);
		expect(service.getFlows()).toHaveLength(0);
	});

	test("handles empty string output", () => {
		execFileSyncResult = "";
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});

		expect(service.getFlows()).toHaveLength(0);
		service.dispose();
	});

	test("handles array format output", () => {
		const arrayFlows = [
			{
				flowId: "f1",
				status: "running",
				createdAt: now - 1000,
				taskCount: 1,
				completedCount: 0,
				failedCount: 0,
			},
		];
		execFileSyncResult = JSON.stringify(arrayFlows);
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});

		expect(service.getFlows()).toHaveLength(1);
		expect(at(service.getFlows(), 0).flowId).toBe("f1");
		service.dispose();
	});
});

describe("taskflow status helpers", () => {
	test("maps all statuses to labels and icons", () => {
		const statuses = [
			"queued",
			"running",
			"waiting",
			"blocked",
			"succeeded",
			"failed",
			"cancelled",
			"lost",
		] as const;

		expect(statuses.map((status) => taskflowStatusToLabel(status))).toEqual([
			"Queued",
			"Running",
			"Waiting",
			"Blocked",
			"Succeeded",
			"Failed",
			"Cancelled",
			"Lost",
		]);
		expect(statuses.map((status) => taskflowStatusToIcon(status).id)).toEqual([
			"loading~spin",
			"pulse",
			"watch",
			"shield",
			"check",
			"error",
			"circle-slash",
			"warning",
		]);
	});

	test("terminal status detection", () => {
		expect(isTerminalFlowStatus("succeeded")).toBe(true);
		expect(isTerminalFlowStatus("failed")).toBe(true);
		expect(isTerminalFlowStatus("cancelled")).toBe(true);
		expect(isTerminalFlowStatus("lost")).toBe(true);
		expect(isTerminalFlowStatus("running")).toBe(false);
		expect(isTerminalFlowStatus("queued")).toBe(false);
		expect(isTerminalFlowStatus("waiting")).toBe(false);
		expect(isTerminalFlowStatus("blocked")).toBe(false);
	});
});
