import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	classifyState,
	detectArtifact,
	formatRecord,
	PREVIEW_STATUS_SCHEMA_VERSION,
	PreviewStatusError,
	type PreviewStatusRecord,
	PreviewStatusStore,
	parseCli,
	parseRecord,
} from "../../scripts-v2/preview-status.ts";

const CLI_PATH = path.resolve(
	import.meta.dir,
	"..",
	"..",
	"scripts-v2",
	"preview-status.ts",
);

type CliResult = { status: number; stdout: string; stderr: string };

function runCliSync(args: string[]): CliResult {
	try {
		const stdout = execFileSync("bun", ["run", CLI_PATH, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, stdout, stderr: "" };
	} catch (err) {
		const e = err as {
			status?: number | null;
			stdout?: string | Buffer;
			stderr?: string | Buffer;
		};
		return {
			status: typeof e.status === "number" ? e.status : 1,
			stdout: e.stdout ? e.stdout.toString() : "",
			stderr: e.stderr ? e.stderr.toString() : "",
		};
	}
}

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

describe("parseCli", () => {
	test("empty argv defaults to show", () => {
		expect(parseCli([])).toEqual({
			kind: "command",
			stateDir: undefined,
			subcommand: "show",
			subArgs: [],
		});
	});

	test("a bare --json defaults to show with the flag forwarded", () => {
		expect(parseCli(["--json"])).toEqual({
			kind: "command",
			stateDir: undefined,
			subcommand: "show",
			subArgs: ["--json"],
		});
	});

	test("explicit clear dispatches the clear subcommand", () => {
		expect(parseCli(["clear"])).toEqual({
			kind: "command",
			stateDir: undefined,
			subcommand: "clear",
			subArgs: [],
		});
	});

	test("show --json continues to work", () => {
		expect(parseCli(["show", "--json"])).toEqual({
			kind: "command",
			stateDir: undefined,
			subcommand: "show",
			subArgs: ["--json"],
		});
	});

	test("--state-dir <dir> before the subcommand is hoisted as global", () => {
		expect(parseCli(["--state-dir", "/tmp/x", "show", "--json"])).toEqual({
			kind: "command",
			stateDir: "/tmp/x",
			subcommand: "show",
			subArgs: ["--json"],
		});
	});

	test("--state-dir=<dir> form is supported", () => {
		expect(parseCli(["--state-dir=/tmp/y", "clear"])).toEqual({
			kind: "command",
			stateDir: "/tmp/y",
			subcommand: "clear",
			subArgs: [],
		});
	});

	test("--state-dir after the subcommand still works", () => {
		expect(parseCli(["show", "--state-dir", "/tmp/z", "--json"])).toEqual({
			kind: "command",
			stateDir: "/tmp/z",
			subcommand: "show",
			subArgs: ["--json"],
		});
	});

	test("--state-dir without a value is rejected", () => {
		expect(parseCli(["--state-dir"])).toEqual({
			kind: "error",
			message: "preview-status: --state-dir requires a value",
		});
	});

	test("--state-dir followed by a flag is rejected", () => {
		expect(parseCli(["--state-dir", "--json"])).toEqual({
			kind: "error",
			message: "preview-status: --state-dir requires a value",
		});
	});

	test("an unknown positional is an error, not a silent show", () => {
		expect(parseCli(["clearr"])).toEqual({
			kind: "error",
			message: 'preview-status: unknown subcommand "clearr"',
		});
	});

	test("--help short-circuits as a help request", () => {
		expect(parseCli(["--help"])).toEqual({ kind: "help", stateDir: undefined });
	});

	test("-h short-circuits as a help request even with --state-dir", () => {
		expect(parseCli(["--state-dir=/tmp/h", "-h"])).toEqual({
			kind: "help",
			stateDir: "/tmp/h",
		});
	});
});

describe("preview-status CLI (subprocess smoke)", () => {
	let stateDir: string;
	beforeEach(async () => {
		stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "preview-status-cli-"));
	});
	afterEach(async () => {
		if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
	});

	test("bare CLI defaults to show and reports no record", () => {
		const r = runCliSync(["--state-dir", stateDir]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("no record (state: none)");
	});

	test('--json defaults to show --json and emits {"state":"none"}', () => {
		const r = runCliSync(["--state-dir", stateDir, "--json"]);
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({ state: "none" });
	});

	test("explicit clear subcommand actually clears (state file removed)", async () => {
		// Seed state.json so we can prove clear deletes it (and isn't show).
		await fs.writeFile(
			path.join(stateDir, "state.json"),
			JSON.stringify({
				version: PREVIEW_STATUS_SCHEMA_VERSION,
				state: "succeeded",
				exitCode: 0,
			}),
			"utf8",
		);
		const r = runCliSync(["--state-dir", stateDir, "clear"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("preview-status: cleared");
		expect(
			await fs
				.stat(path.join(stateDir, "state.json"))
				.then(() => true)
				.catch(() => false),
		).toBe(false);
	});

	test("global --state-dir BEFORE subcommand: show --json (handoff-recommended shape)", async () => {
		await fs.writeFile(
			path.join(stateDir, "state.json"),
			JSON.stringify({
				version: PREVIEW_STATUS_SCHEMA_VERSION,
				state: "succeeded",
				exitCode: 0,
				packageVersion: "0.6.0-rc.47",
			}),
			"utf8",
		);
		const r = runCliSync(["--state-dir", stateDir, "show", "--json"]);
		expect(r.status).toBe(0);
		const obj = JSON.parse(r.stdout);
		expect(obj.state).toBe("succeeded");
		expect(obj.liveState).toBe("succeeded");
		expect(obj.packageVersion).toBe("0.6.0-rc.47");
	});

	test("show --state-dir <dir> --json (state-dir AFTER subcommand) still works", async () => {
		await fs.writeFile(
			path.join(stateDir, "state.json"),
			JSON.stringify({
				version: PREVIEW_STATUS_SCHEMA_VERSION,
				state: "failed",
				exitCode: 7,
			}),
			"utf8",
		);
		const r = runCliSync(["show", "--state-dir", stateDir, "--json"]);
		expect(r.status).toBe(0);
		const obj = JSON.parse(r.stdout);
		expect(obj.state).toBe("failed");
		expect(obj.exitCode).toBe(7);
	});

	test("unknown subcommand exits 64 with a helpful error", () => {
		const r = runCliSync(["--state-dir", stateDir, "clearr"]);
		expect(r.status).toBe(64);
		expect(r.stderr).toContain('unknown subcommand "clearr"');
	});
});

async function mkTempRepoDir(version?: string, vsix?: string): Promise<string> {
	const repoDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "preview-status-repo-"),
	);
	if (version) {
		await fs.writeFile(
			path.join(repoDir, "package.json"),
			JSON.stringify({ name: "command-central", version }),
			"utf8",
		);
	}
	if (version && vsix != null) {
		await fs.mkdir(path.join(repoDir, "releases"), { recursive: true });
		await fs.writeFile(
			path.join(repoDir, "releases", `command-central-${version}.vsix`),
			vsix,
			"utf8",
		);
	}
	return repoDir;
}

describe("detectArtifact", () => {
	let repoDir: string;
	afterEach(async () => {
		if (repoDir) await fs.rm(repoDir, { recursive: true, force: true });
	});

	test("resolves version, artifact path, and sha256 from a cut repo", async () => {
		repoDir = await mkTempRepoDir("0.6.0-rc.50", "fake-vsix-bytes");
		const detected = await detectArtifact(repoDir);
		expect(detected.packageVersion).toBe("0.6.0-rc.50");
		expect(detected.artifactPath).toBe(
			path.join(repoDir, "releases", "command-central-0.6.0-rc.50.vsix"),
		);
		expect(detected.artifactSha256).toBe(
			createHash("sha256").update("fake-vsix-bytes").digest("hex"),
		);
	});

	test("reports version only when the matching VSIX is missing", async () => {
		repoDir = await mkTempRepoDir("0.6.0-rc.50");
		const detected = await detectArtifact(repoDir);
		expect(detected.packageVersion).toBe("0.6.0-rc.50");
		expect(detected.artifactPath).toBeNull();
		expect(detected.artifactSha256).toBeNull();
	});

	test("degrades to all-null when package.json is absent", async () => {
		repoDir = await mkTempRepoDir();
		expect(await detectArtifact(repoDir)).toEqual({
			packageVersion: null,
			artifactPath: null,
			artifactSha256: null,
		});
	});
});

describe("preview-status CLI finish --auto-artifact", () => {
	let stateDir: string;
	let repoDir: string;
	beforeEach(async () => {
		stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "preview-status-cli-"));
	});
	afterEach(async () => {
		if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
		if (repoDir) await fs.rm(repoDir, { recursive: true, force: true });
	});

	function startRecord(cwd: string): void {
		const r = runCliSync([
			"--state-dir",
			stateDir,
			"start",
			"--command=just cut-preview --prerelease",
			`--cwd=${cwd}`,
		]);
		expect(r.status).toBe(0);
	}

	function showRecord(): PreviewStatusRecord {
		const r = runCliSync(["--state-dir", stateDir, "show", "--json"]);
		expect(r.status).toBe(0);
		return JSON.parse(r.stdout) as PreviewStatusRecord;
	}

	test("successful finish fills version/artifact/sha from the record cwd", async () => {
		repoDir = await mkTempRepoDir("0.6.0-rc.50", "fake-vsix-bytes");
		startRecord(repoDir);
		const r = runCliSync([
			"--state-dir",
			stateDir,
			"finish",
			"--exit-code=0",
			"--auto-artifact",
		]);
		expect(r.status).toBe(0);
		const record = showRecord();
		expect(record.state).toBe("succeeded");
		expect(record.packageVersion).toBe("0.6.0-rc.50");
		expect(record.artifactPath).toBe(
			path.join(repoDir, "releases", "command-central-0.6.0-rc.50.vsix"),
		);
		expect(record.artifactSha256).toBe(
			createHash("sha256").update("fake-vsix-bytes").digest("hex"),
		);
	});

	test("explicit --version wins over auto-detection", async () => {
		repoDir = await mkTempRepoDir("0.6.0-rc.50", "fake-vsix-bytes");
		startRecord(repoDir);
		const r = runCliSync([
			"--state-dir",
			stateDir,
			"finish",
			"--exit-code=0",
			"--auto-artifact",
			"--version=9.9.9-explicit",
		]);
		expect(r.status).toBe(0);
		expect(showRecord().packageVersion).toBe("9.9.9-explicit");
	});

	test("failed finish does not record artifact identity", async () => {
		repoDir = await mkTempRepoDir("0.6.0-rc.50", "fake-vsix-bytes");
		startRecord(repoDir);
		const r = runCliSync([
			"--state-dir",
			stateDir,
			"finish",
			"--exit-code=1",
			"--auto-artifact",
		]);
		expect(r.status).toBe(0);
		const record = showRecord();
		expect(record.state).toBe("failed");
		expect(record.packageVersion).toBeNull();
		expect(record.artifactPath).toBeNull();
		expect(record.artifactSha256).toBeNull();
	});
});
