import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	classifyState,
	formatRecord,
	PREVIEW_STATUS_SCHEMA_VERSION,
	PreviewStatusError,
	type PreviewStatusRecord,
	PreviewStatusStore,
	parseRecord,
} from "../../scripts-v2/preview-status.ts";

function recordFixture(
	overrides: Partial<PreviewStatusRecord> = {},
): PreviewStatusRecord {
	return {
		version: PREVIEW_STATUS_SCHEMA_VERSION,
		state: "running",
		pid: 4242,
		command: "just cut-preview --prerelease",
		cwd: "/tmp/repo",
		host: "MacBookPro.lan",
		user: "ostehost",
		startedAt: "2026-05-28T04:00:00.000Z",
		finishedAt: null,
		durationMs: null,
		logPath: ".preview-status/cut-preview-20260528T040000Z.log",
		packageVersion: "0.6.0-rc.47",
		artifactPath: null,
		artifactSha256: null,
		exitCode: null,
		...overrides,
	};
}

async function mkTempStateDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "preview-status-test-"));
}

describe("parseRecord", () => {
	test("round-trips a valid record", () => {
		const r = recordFixture();
		expect(parseRecord(JSON.stringify(r))).toEqual(r);
	});

	test("rejects invalid JSON", () => {
		expect(() => parseRecord("{not-json")).toThrow(PreviewStatusError);
	});

	test("rejects mismatched schema version", () => {
		const raw = JSON.stringify({ ...recordFixture(), version: 99 });
		expect(() => parseRecord(raw)).toThrow(/schema version/);
	});

	test("rejects unknown state values", () => {
		const raw = JSON.stringify({ ...recordFixture(), state: "weird" });
		expect(() => parseRecord(raw)).toThrow(/invalid state/);
	});

	test("coerces missing optional fields to null", () => {
		const raw = JSON.stringify({
			version: PREVIEW_STATUS_SCHEMA_VERSION,
			state: "succeeded",
		});
		const parsed = parseRecord(raw);
		expect(parsed.state).toBe("succeeded");
		expect(parsed.pid).toBeNull();
		expect(parsed.logPath).toBeNull();
		expect(parsed.exitCode).toBeNull();
	});
});

describe("classifyState", () => {
	test("succeeded records pass through unchanged", () => {
		const r = recordFixture({ state: "succeeded", pid: null });
		expect(classifyState(r, () => false)).toBe("succeeded");
	});

	test("running record with a live pid stays running", () => {
		const r = recordFixture({ state: "running", pid: 1234 });
		expect(classifyState(r, (pid) => pid === 1234)).toBe("running");
	});

	test("running record with a dead pid reclassifies to unknown", () => {
		const r = recordFixture({ state: "running", pid: 9999 });
		expect(classifyState(r, () => false)).toBe("unknown");
	});

	test("running record with no pid reclassifies to unknown", () => {
		const r = recordFixture({ state: "running", pid: null });
		expect(classifyState(r, () => true)).toBe("unknown");
	});
});

describe("PreviewStatusStore.start", () => {
	let stateDir: string;
	afterEach(async () => {
		if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
	});
	beforeEach(async () => {
		stateDir = await mkTempStateDir();
	});

	test("writes a running record when no prior state exists", async () => {
		const store = new PreviewStatusStore(stateDir, () => false);
		const r = await store.start({
			command: "just cut-preview --prerelease",
			cwd: "/tmp/repo",
			logPath: "/tmp/log",
			packageVersion: "0.6.0-rc.48",
			pid: 1001,
		});
		expect(r.state).toBe("running");
		expect(r.pid).toBe(1001);
		expect(r.command).toBe("just cut-preview --prerelease");
		expect(r.logPath).toBe("/tmp/log");
		expect(r.finishedAt).toBeNull();

		const readBack = await store.read();
		expect(readBack).toEqual(r);
	});

	test("refuses to start when an existing job is alive", async () => {
		const liveStore = new PreviewStatusStore(stateDir, (pid) => pid === 2002);
		await liveStore.start({
			command: "just cut-preview --prerelease",
			cwd: "/tmp/repo",
			pid: 2002,
		});

		await expect(
			liveStore.start({
				command: "just cut-preview --prerelease",
				cwd: "/tmp/repo",
				pid: 3003,
			}),
		).rejects.toMatchObject({
			code: "ALREADY_RUNNING",
			name: "PreviewStatusError",
		});
	});

	test("replaces a stale running record when the prior pid is gone", async () => {
		// First write a running record with pid 4242, alive.
		const aliveStore = new PreviewStatusStore(stateDir, () => true);
		await aliveStore.start({
			command: "just cut-preview --prerelease",
			cwd: "/tmp/repo",
			pid: 4242,
		});

		// Now classify with a dead-pid probe — the next start should succeed.
		const deadStore = new PreviewStatusStore(stateDir, () => false);
		const next = await deadStore.start({
			command: "just cut-preview --prerelease",
			cwd: "/tmp/repo",
			pid: 5555,
		});
		expect(next.pid).toBe(5555);
		expect(next.state).toBe("running");
	});

	test("--force overwrites an existing live running record", async () => {
		const store = new PreviewStatusStore(stateDir, () => true);
		await store.start({
			command: "just cut-preview --prerelease",
			cwd: "/tmp/repo",
			pid: 6001,
		});
		const forced = await store.start({
			command: "just cut-preview --prerelease",
			cwd: "/tmp/repo",
			pid: 6002,
			force: true,
		});
		expect(forced.pid).toBe(6002);
	});
});

describe("PreviewStatusStore.finish", () => {
	let stateDir: string;
	afterEach(async () => {
		if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
	});
	beforeEach(async () => {
		stateDir = await mkTempStateDir();
	});

	test("flips running → succeeded on exit-code 0", async () => {
		const store = new PreviewStatusStore(stateDir, () => true);
		await store.start({
			command: "just cut-preview --prerelease",
			cwd: "/tmp/repo",
			pid: 7001,
			now: new Date("2026-05-28T04:00:00.000Z"),
		});
		const finished = await store.finish({
			exitCode: 0,
			artifactPath: "releases/command-central-0.6.0-rc.48.vsix",
			artifactSha256: "deadbeef",
			packageVersion: "0.6.0-rc.48",
			now: new Date("2026-05-28T04:05:00.000Z"),
		});
		expect(finished.state).toBe("succeeded");
		expect(finished.exitCode).toBe(0);
		expect(finished.durationMs).toBe(300_000);
		expect(finished.artifactPath).toBe(
			"releases/command-central-0.6.0-rc.48.vsix",
		);
		expect(finished.artifactSha256).toBe("deadbeef");
		expect(finished.packageVersion).toBe("0.6.0-rc.48");
	});

	test("flips running → failed on a non-zero exit code", async () => {
		const store = new PreviewStatusStore(stateDir, () => true);
		await store.start({
			command: "just cut-preview --prerelease",
			cwd: "/tmp/repo",
			pid: 8001,
			now: new Date("2026-05-28T04:00:00.000Z"),
		});
		const finished = await store.finish({
			exitCode: 1,
			now: new Date("2026-05-28T04:00:30.000Z"),
		});
		expect(finished.state).toBe("failed");
		expect(finished.exitCode).toBe(1);
		expect(finished.durationMs).toBe(30_000);
	});

	test("refuses to finish when no record exists", async () => {
		const store = new PreviewStatusStore(stateDir, () => false);
		await expect(store.finish({ exitCode: 0 })).rejects.toMatchObject({
			code: "NO_RECORD",
		});
	});
});

describe("PreviewStatusStore.classify and clear", () => {
	let stateDir: string;
	afterEach(async () => {
		if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
	});
	beforeEach(async () => {
		stateDir = await mkTempStateDir();
	});

	test("classify returns 'none' when there is no state file", async () => {
		const store = new PreviewStatusStore(stateDir, () => false);
		expect(await store.classify()).toBe("none");
	});

	test("classify reclassifies a stale running record to 'unknown'", async () => {
		const aliveStore = new PreviewStatusStore(stateDir, () => true);
		await aliveStore.start({
			command: "just cut-preview --prerelease",
			cwd: "/tmp/repo",
			pid: 9001,
		});
		const staleStore = new PreviewStatusStore(stateDir, () => false);
		expect(await staleStore.classify()).toBe("unknown");
	});

	test("clear removes the state file", async () => {
		const store = new PreviewStatusStore(stateDir, () => true);
		await store.start({
			command: "just cut-preview --prerelease",
			cwd: "/tmp/repo",
			pid: 9101,
		});
		await store.clear();
		expect(await store.read()).toBeNull();
		// idempotent
		await store.clear();
	});
});

describe("formatRecord", () => {
	test("renders the stored-vs-live mismatch for stale records", () => {
		const r = recordFixture({ state: "running", pid: 1234 });
		const out = formatRecord(r, "unknown");
		expect(out).toContain("state:          unknown");
		expect(out).toContain("(stored as running)");
		expect(out).toContain("command:        just cut-preview --prerelease");
	});

	test("omits the stored-vs-live note when they match", () => {
		const r = recordFixture({ state: "succeeded", exitCode: 0 });
		const out = formatRecord(r, "succeeded");
		expect(out).toContain("state:          succeeded");
		expect(out).not.toContain("stored as");
	});
});
