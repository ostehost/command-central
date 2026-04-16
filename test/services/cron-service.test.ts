import { beforeEach, describe, expect, mock, test } from "bun:test";

// Track execFileSync / execFile calls
let execFileSyncResult: string | Error = "[]";
let execFileSyncCalls: Array<{ cmd: string; args: string[] }> = [];
let execFileResult: string | Error = "";
let execFileCalls: Array<{ cmd: string; args: string[] }> = [];

// Track fs.watch calls
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
	readFileSync: () => "",
}));

mock.module("vscode", () => ({}));

const { CronService } = await import("../../src/services/cron-service.js");

function at<T>(arr: T[], index: number): T {
	const el = arr[index];
	if (el === undefined) throw new Error(`No element at index ${index}`);
	return el;
}

const sampleJobs = [
	{
		id: "job-1",
		name: "Weekly Check",
		enabled: true,
		schedule: { kind: "cron", expr: "0 18 * * 0" },
		sessionTarget: "main",
		payload: { kind: "agentTurn", message: "check" },
		state: { lastStatus: "ok", lastRunAtMs: Date.now() - 3600000 },
	},
	{
		id: "job-2",
		name: "Disabled Job",
		enabled: false,
		schedule: { kind: "every", everyMs: 900000 },
		sessionTarget: "main",
		payload: { kind: "agentTurn", message: "noop" },
		state: {},
	},
];

describe("CronService", () => {
	beforeEach(() => {
		execFileSyncResult = "[]";
		execFileSyncCalls = [];
		execFileResult = "";
		execFileCalls = [];
		watchCallback = null;
		watchClosed = false;
	});

	test("parses valid openclaw cron list output", () => {
		execFileSyncResult = JSON.stringify(sampleJobs);
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});

		const jobs = service.getJobs();
		expect(jobs).toHaveLength(2);
		expect(at(jobs, 0).name).toBe("Weekly Check");
		expect(at(jobs, 1).name).toBe("Disabled Job");
		service.dispose();
	});

	test("parses output with jobs wrapper object", () => {
		execFileSyncResult = JSON.stringify({ jobs: sampleJobs });
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});

		expect(service.getJobs()).toHaveLength(2);
		service.dispose();
	});

	test("handles ENOENT (OpenClaw not installed)", () => {
		const err = new Error("spawn openclaw ENOENT") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		execFileSyncResult = err;

		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});

		expect(service.getJobs()).toHaveLength(0);
		expect(service.isInstalled).toBe(false);
		service.dispose();
	});

	test("handles non-zero exit — keeps last known state", () => {
		// First load succeeds
		execFileSyncResult = JSON.stringify(sampleJobs);
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});
		expect(service.getJobs()).toHaveLength(2);

		// Second load fails with non-ENOENT error
		const err = new Error("exit code 1") as NodeJS.ErrnoException;
		err.code = "ERR_CHILD_PROCESS";
		execFileSyncResult = err;
		service.reload();

		// Should keep last known state (2 jobs)
		expect(service.getJobs()).toHaveLength(2);
		expect(service.isInstalled).toBe(true);
		service.dispose();
	});

	test("enable calls correct CLI command", async () => {
		execFileSyncResult = "[]";
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});

		await service.enableJob("job-1");
		expect(execFileCalls).toHaveLength(1);
		expect(at(execFileCalls, 0).cmd).toBe("openclaw");
		expect(at(execFileCalls, 0).args).toEqual(["cron", "enable", "job-1"]);
		service.dispose();
	});

	test("disable calls correct CLI command", async () => {
		execFileSyncResult = "[]";
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});

		await service.disableJob("job-2");
		expect(at(execFileCalls, 0).args).toEqual(["cron", "disable", "job-2"]);
		service.dispose();
	});

	test("runJob calls correct CLI command", async () => {
		execFileSyncResult = "[]";
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});

		await service.runJob("job-1");
		expect(at(execFileCalls, 0).args).toEqual(["cron", "run", "job-1"]);
		service.dispose();
	});

	test("file watcher triggers reload callback", async () => {
		execFileSyncResult = "[]";
		let callbackCount = 0;
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {
			callbackCount++;
		});

		// Simulate file change
		watchCallback?.("change", "jobs.json");

		// Wait for debounce (150ms)
		await new Promise((r) => setTimeout(r, 20));
		expect(callbackCount).toBe(1);
		service.dispose();
	});

	test("debounce fires only once for rapid changes", async () => {
		execFileSyncResult = "[]";
		let callbackCount = 0;
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {
			callbackCount++;
		});

		// Simulate rapid file changes
		watchCallback?.("change", "jobs.json");
		watchCallback?.("change", "jobs.json");
		watchCallback?.("change", "jobs.json");

		await new Promise((r) => setTimeout(r, 20));
		expect(callbackCount).toBe(1);
		service.dispose();
	});

	test("dispose cleans up watcher and timer", () => {
		execFileSyncResult = "[]";
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});

		service.dispose();
		expect(watchClosed).toBe(true);
		expect(service.getJobs()).toHaveLength(0);
	});

	test("handles empty stdout", () => {
		execFileSyncResult = "";
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});
		expect(service.getJobs()).toHaveLength(0);
		service.dispose();
	});
});
