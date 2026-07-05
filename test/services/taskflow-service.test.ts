import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	isTerminalFlowStatus,
	taskflowStatusToIcon,
	taskflowStatusToLabel,
} from "../../src/types/taskflow-types.js";
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

// Reload now flows through the async execFile path (PAR-68 / CP-29):
// reload() returns synchronously and resolves the CLI off the event loop.
// `execFileResult` drives the resolved stdout (or thrown Error) for reloads
// AND mutating CLI commands; `execFilePending`, when set, holds the callback
// so a test can control exactly when the CLI resolves.
let execFileResult: string | Error = '{"count":0,"status":null,"flows":[]}';
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

// Spread the canonical mock so the vscode surface can never shrink below what a
// later-loading test relies on (the taskflow ThemeColor leak, CCSTD-06). The
// status-icon helpers only touch ThemeIcon/ThemeColor, both of which
// createVSCodeMock already provides.
mock.module("vscode", () => createVSCodeMock());

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
		execFileResult = '{"count":0,"status":null,"flows":[]}';
		execFileCalls = [];
		execFilePending = null;
		watchCallback = null;
		watchClosed = false;
	});

	test("parses valid flow list output", async () => {
		execFileResult = JSON.stringify(sampleFlows);
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		const flows = service.getFlows();
		expect(flows).toHaveLength(1);
		expect(at(flows, 0).flowId).toBe("flow-1");
		service.dispose();
	});

	test("preserves nested flow tasks from CLI output", async () => {
		execFileResult = JSON.stringify({
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
		await service.reloadAsync();

		const flow = at(service.getFlows(), 0);
		expect(flow.tasks).toHaveLength(1);
		expect(flow.tasks?.[0]?.taskId).toBe("task-1");
		expect(flow.tasks?.[0]?.childSessionKey).toBe("session-123");
		service.dispose();
	});

	test("calls correct CLI command", async () => {
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		expect(at(execFileCalls, 0).cmd).toBe("openclaw");
		expect(at(execFileCalls, 0).args).toEqual([
			"tasks",
			"flow",
			"list",
			"--json",
		]);
		service.dispose();
	});

	test("handles ENOENT (OpenClaw not installed)", async () => {
		const err = new Error("spawn openclaw ENOENT") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		execFileResult = err;

		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		expect(service.getFlows()).toHaveLength(0);
		expect(service.isInstalled).toBe(false);
		service.dispose();
	});

	test("handles non-zero exit and keeps last known state", async () => {
		execFileResult = JSON.stringify(sampleFlows);
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();
		expect(service.getFlows()).toHaveLength(1);

		const err = new Error("exit code 1") as NodeJS.ErrnoException;
		err.code = "ERR_CHILD_PROCESS";
		execFileResult = err;
		await service.reloadAsync();

		expect(service.getFlows()).toHaveLength(1);
		expect(service.isInstalled).toBe(true);
		service.dispose();
	});

	test("getActiveFlows filters to active statuses", async () => {
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
		execFileResult = JSON.stringify(flowsWithMixed);
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		const active = service.getActiveFlows();
		expect(active).toHaveLength(3);
		expect(active.map((f) => f.flowId).sort()).toEqual(["f1", "f2", "f4"]);
		service.dispose();
	});

	test("getRecentFlows returns sorted and limited results", async () => {
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
		execFileResult = JSON.stringify(manyFlows);
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		const recent = service.getRecentFlows(2);
		expect(recent).toHaveLength(2);
		expect(at(recent, 0).flowId).toBe("newest");
		expect(at(recent, 1).flowId).toBe("middle");
		service.dispose();
	});

	test("debounce fires only once for rapid file changes", async () => {
		execFileResult = JSON.stringify(sampleFlows);
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
		execFileResult = JSON.stringify(sampleFlows);
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
		await service.reloadAsync();
		execFileCalls = [];

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

	test("handles empty string output", async () => {
		execFileResult = "";
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		expect(service.getFlows()).toHaveLength(0);
		service.dispose();
	});

	test("handles array format output", async () => {
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
		execFileResult = JSON.stringify(arrayFlows);
		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		expect(service.getFlows()).toHaveLength(1);
		expect(at(service.getFlows(), 0).flowId).toBe("f1");
		service.dispose();
	});

	// ── PAR-68 / CP-29 regression: non-blocking async reload ─────────────
	// On the synchronous (execFileSync) implementation start() did not return
	// until the CLI finished, and flows were populated before start() returned.
	// These tests assert start() returns BEFORE the CLI resolves and that
	// state lands only after the deferred CLI callback fires.
	test("start() returns before the CLI resolves (non-blocking reload)", async () => {
		const cli: { resolve: ((stdout: string) => void) | null } = {
			resolve: null,
		};
		execFilePending = (cb) => {
			cli.resolve = (stdout) => cb(null, stdout);
		};

		const service = new TaskFlowService({ debounceMs: 1 });
		service.start(() => {});

		// start() has returned but the CLI has not resolved yet — on the old
		// execFileSync code this state was impossible (flows already populated).
		expect(cli.resolve).not.toBeNull();
		expect(service.getFlows()).toHaveLength(0);

		cli.resolve?.(JSON.stringify(sampleFlows));
		await waitFor(() => service.getFlows().length === 1, {
			message: "flows should populate after the deferred CLI resolves",
		});
		expect(service.getFlows()).toHaveLength(1);
		service.dispose();
	});

	test("concurrent reloads coalesce onto a single CLI invocation", async () => {
		const cli: { resolve: ((stdout: string) => void) | null } = {
			resolve: null,
		};
		execFilePending = (cb) => {
			cli.resolve = (stdout) => cb(null, stdout);
		};

		const service = new TaskFlowService({ debounceMs: 1 });
		const first = service.reloadAsync();
		const second = service.reloadAsync();
		const third = service.reloadAsync();

		expect(execFileCalls).toHaveLength(1);
		expect(second).toBe(first);
		expect(third).toBe(first);

		cli.resolve?.(JSON.stringify(sampleFlows));
		await Promise.all([first, second, third]);
		expect(execFileCalls).toHaveLength(1);
		expect(service.getFlows()).toHaveLength(1);
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
