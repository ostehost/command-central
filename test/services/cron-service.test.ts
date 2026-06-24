import { beforeEach, describe, expect, mock, test } from "bun:test";
import { waitFor } from "../helpers/wait-for.js";

// Reload now flows through the async execFile path (PAR-68 / CP-29):
// reload() returns synchronously and resolves the CLI off the event loop.
// `execFileResult` drives the resolved stdout (or thrown Error) for reloads
// AND mutating CLI commands; `execFilePending`, when set, holds the callback
// so a test can control exactly when the CLI resolves.
let execFileResult: string | Error = "[]";
let execFileCalls: Array<{ cmd: string; args: string[] }> = [];
let execFilePending:
	| ((cb: (err: Error | null, stdout: string) => void) => void)
	| null = null;

// Track fs.watch calls
let watchCallback: ((event: string, filename: string) => void) | null = null;
let watchClosed = false;
// PAR-67 / CP-28: number of leading fs.watch() calls that should throw ENOENT
// (simulating the OpenClaw cron directory being absent at startup) before a
// subsequent call succeeds. Lets a test exercise the watch-with-retry path.
let watchThrowCount = 0;
let watchCallCount = 0;

mock.module("node:child_process", () => ({
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
	watch: (_dir: string, cb: (event: string, filename: string) => void) => {
		watchCallCount++;
		if (watchCallCount <= watchThrowCount) {
			const err = new Error(`watch ENOENT ${_dir}`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		}
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

// Keep this mock shape compatible with tests that may import status helpers in
// the same Bun process. A bare `{}` leaks globally and makes ThemeColor
// undefined when focused service suites are batched together.
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
		execFileResult = "[]";
		execFileCalls = [];
		execFilePending = null;
		watchCallback = null;
		watchClosed = false;
		watchThrowCount = 0;
		watchCallCount = 0;
	});

	test("parses valid openclaw cron list output", async () => {
		execFileResult = JSON.stringify(sampleJobs);
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		const jobs = service.getJobs();
		expect(jobs).toHaveLength(2);
		expect(at(jobs, 0).name).toBe("Weekly Check");
		expect(at(jobs, 1).name).toBe("Disabled Job");
		service.dispose();
	});

	test("parses output with jobs wrapper object", async () => {
		execFileResult = JSON.stringify({ jobs: sampleJobs });
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		expect(service.getJobs()).toHaveLength(2);
		service.dispose();
	});

	test("handles ENOENT (OpenClaw not installed)", async () => {
		const err = new Error("spawn openclaw ENOENT") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		execFileResult = err;

		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();

		expect(service.getJobs()).toHaveLength(0);
		expect(service.isInstalled).toBe(false);
		service.dispose();
	});

	test("handles non-zero exit — keeps last known state", async () => {
		// First load succeeds
		execFileResult = JSON.stringify(sampleJobs);
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();
		expect(service.getJobs()).toHaveLength(2);

		// Second load fails with non-ENOENT error
		const err = new Error("exit code 1") as NodeJS.ErrnoException;
		err.code = "ERR_CHILD_PROCESS";
		execFileResult = err;
		await service.reloadAsync();

		// Should keep last known state (2 jobs)
		expect(service.getJobs()).toHaveLength(2);
		expect(service.isInstalled).toBe(true);
		service.dispose();
	});

	test("enable calls correct CLI command", async () => {
		execFileResult = "[]";
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();
		execFileCalls = [];

		await service.enableJob("job-1");
		expect(execFileCalls).toHaveLength(1);
		expect(at(execFileCalls, 0).cmd).toBe("openclaw");
		expect(at(execFileCalls, 0).args).toEqual(["cron", "enable", "job-1"]);
		service.dispose();
	});

	test("disable calls correct CLI command", async () => {
		execFileResult = "[]";
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();
		execFileCalls = [];

		await service.disableJob("job-2");
		expect(at(execFileCalls, 0).args).toEqual(["cron", "disable", "job-2"]);
		service.dispose();
	});

	test("runJob calls correct CLI command", async () => {
		execFileResult = "[]";
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();
		execFileCalls = [];

		await service.runJob("job-1");
		expect(at(execFileCalls, 0).args).toEqual(["cron", "run", "job-1"]);
		service.dispose();
	});

	test("file watcher triggers reload callback", async () => {
		execFileResult = "[]";
		let callbackCount = 0;
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {
			callbackCount++;
		});

		// Simulate file change
		watchCallback?.("change", "jobs.json");

		await waitFor(() => callbackCount === 1, {
			message:
				"CronService watcher should trigger exactly one debounced reload",
		});
		expect(callbackCount).toBe(1);
		service.dispose();
	});

	test("debounce fires only once for rapid changes", async () => {
		execFileResult = "[]";
		let callbackCount = 0;
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {
			callbackCount++;
		});

		// Simulate rapid file changes
		watchCallback?.("change", "jobs.json");
		watchCallback?.("change", "jobs.json");
		watchCallback?.("change", "jobs.json");

		await waitFor(() => callbackCount === 1, {
			message:
				"CronService debounce should collapse rapid file changes into one reload",
		});
		expect(callbackCount).toBe(1);
		service.dispose();
	});

	test("dispose cleans up watcher and timer", () => {
		execFileResult = "[]";
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});

		service.dispose();
		expect(watchClosed).toBe(true);
		expect(service.getJobs()).toHaveLength(0);
	});

	test("handles empty stdout", async () => {
		execFileResult = "";
		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});
		await service.reloadAsync();
		expect(service.getJobs()).toHaveLength(0);
		service.dispose();
	});

	// ── PAR-68 / CP-29 regression: non-blocking async reload ─────────────
	// On the synchronous (execFileSync) implementation start() did not return
	// until the CLI finished, and jobs were populated before start() returned.
	// These tests assert start() returns BEFORE the CLI resolves and that
	// state lands only after the deferred CLI callback fires.
	test("start() returns before the CLI resolves (non-blocking reload)", async () => {
		const cli: { resolve: ((stdout: string) => void) | null } = {
			resolve: null,
		};
		execFilePending = (cb) => {
			cli.resolve = (stdout) => cb(null, stdout);
		};

		const service = new CronService({ debounceMs: 1 });
		service.start(() => {});

		// start() has returned but the CLI has not resolved yet — on the old
		// execFileSync code this state was impossible (jobs already populated).
		expect(cli.resolve).not.toBeNull();
		expect(service.getJobs()).toHaveLength(0);

		cli.resolve?.(JSON.stringify(sampleJobs));
		await waitFor(() => service.getJobs().length === 2, {
			message: "jobs should populate after the deferred CLI resolves",
		});
		expect(service.getJobs()).toHaveLength(2);
		service.dispose();
	});

	test("concurrent reloads coalesce onto a single CLI invocation", async () => {
		const cli: { resolve: ((stdout: string) => void) | null } = {
			resolve: null,
		};
		execFilePending = (cb) => {
			cli.resolve = (stdout) => cb(null, stdout);
		};

		const service = new CronService({ debounceMs: 1 });
		const first = service.reloadAsync();
		const second = service.reloadAsync();
		const third = service.reloadAsync();

		expect(execFileCalls).toHaveLength(1);
		expect(second).toBe(first);
		expect(third).toBe(first);

		cli.resolve?.(JSON.stringify(sampleJobs));
		await Promise.all([first, second, third]);
		expect(execFileCalls).toHaveLength(1);
		expect(service.getJobs()).toHaveLength(2);
		service.dispose();
	});

	test("a reload resolving after dispose() does not resurrect state", async () => {
		const cli: { resolve: ((stdout: string) => void) | null } = {
			resolve: null,
		};
		execFilePending = (cb) => {
			cli.resolve = (stdout) => cb(null, stdout);
		};

		const service = new CronService({ debounceMs: 1 });
		const run = service.reloadAsync();
		expect(cli.resolve).not.toBeNull();
		expect(service.getJobs()).toHaveLength(0);

		// Tear down BEFORE the in-flight CLI resolves.
		service.dispose();
		// The CLI now returns — the late result must be discarded, not applied
		// to the torn-down service.
		cli.resolve?.(JSON.stringify(sampleJobs));
		await run;
		expect(service.getJobs()).toHaveLength(0);
	});

	// ── PAR-67 / CP-28 regression: resilient watcher install ─────────────
	// On the buggy code startWatching() called fs.watch exactly once and
	// swallowed the ENOENT throw, so a cron directory absent at startup was
	// never watched even after it appeared — leaving the tree stale until
	// restart. The fix polls and installs the real watcher once the directory
	// shows up, after which jobs.json changes drive reload + onChange.
	test("retries watcher install when cron directory is absent at startup", async () => {
		execFileResult = "[]";
		// First fs.watch() throws (directory missing); the retry must succeed.
		watchThrowCount = 1;
		let callbackCount = 0;
		const service = new CronService({ debounceMs: 1, watchRetryMs: 1 });
		service.start(() => {
			callbackCount++;
		});

		// The startup attempt threw, so no watcher callback is registered yet.
		expect(watchCallback).toBeNull();

		// Once the directory appears the retry installs the real watcher.
		await waitFor(() => watchCallback !== null, {
			message: "CronService should retry fs.watch until the directory exists",
		});

		// A later jobs.json change must now drive a debounced reload + onChange.
		callbackCount = 0;
		watchCallback?.("change", "jobs.json");
		await waitFor(() => callbackCount === 1, {
			message:
				"recovered watcher should trigger a debounced reload after the dir appears",
		});
		expect(callbackCount).toBe(1);
		service.dispose();
	});

	test("stops retrying after the watcher is installed", async () => {
		execFileResult = "[]";
		watchThrowCount = 2;
		const service = new CronService({ debounceMs: 1, watchRetryMs: 1 });
		service.start(() => {});

		await waitFor(() => watchCallback !== null, {
			message: "CronService should eventually install the watcher",
		});
		const callsAtInstall = watchCallCount;

		// Give the retry interval several windows to (incorrectly) fire again.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(watchCallCount).toBe(callsAtInstall);
		service.dispose();
	});
});
