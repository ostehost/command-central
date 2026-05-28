#!/usr/bin/env bun
/**
 * Preview status tracker for `just cut-preview`.
 *
 * Records a durable, repo-local lifecycle bookmark for long-running preview
 * cuts so that callers (OpenClaw node-invoke, a second terminal, a future
 * agent) can answer "is a preview already running, did the last one succeed,
 * or did it die without me noticing?" without relying on the invoke pipe
 * staying open. The cut itself is unchanged — only observability and
 * duplicate-start protection are added.
 *
 * State file:  .preview-status/state.json   (gitignored)
 * Logs:        .preview-status/cut-preview-<utc-timestamp>.log
 *
 * Subcommands (CLI):
 *   start    --command=... --cwd=... [--log-path=...] [--version=...] [--force]
 *   finish   --exit-code=N [--version=...] [--artifact=...] [--artifact-sha=...]
 *   show     [--json]
 *   clear
 *
 * Pure module API is exported for testing; the CLI is invoked only when
 * `import.meta.main` is true.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const PREVIEW_STATUS_SCHEMA_VERSION = 1;

export type PreviewState =
	| "running"
	| "succeeded"
	| "failed"
	| "unknown"
	| "none";

export type PreviewStatusRecord = {
	version: typeof PREVIEW_STATUS_SCHEMA_VERSION;
	state: Exclude<PreviewState, "none">;
	pid: number | null;
	command: string;
	cwd: string;
	host: string;
	user: string;
	startedAt: string;
	finishedAt: string | null;
	durationMs: number | null;
	logPath: string | null;
	packageVersion: string | null;
	artifactPath: string | null;
	artifactSha256: string | null;
	exitCode: number | null;
};

export type IsAliveFn = (pid: number) => boolean;

export type StartOptions = {
	command: string;
	cwd: string;
	logPath?: string | null;
	packageVersion?: string | null;
	pid?: number;
	force?: boolean;
	now?: Date;
};

export type FinishOptions = {
	exitCode: number;
	artifactPath?: string | null;
	artifactSha256?: string | null;
	packageVersion?: string | null;
	now?: Date;
};

export class PreviewStatusError extends Error {
	readonly code: "ALREADY_RUNNING" | "NO_RECORD" | "PARSE_ERROR";
	readonly record: PreviewStatusRecord | null;

	constructor(
		code: "ALREADY_RUNNING" | "NO_RECORD" | "PARSE_ERROR",
		message: string,
		record: PreviewStatusRecord | null = null,
	) {
		super(message);
		this.name = "PreviewStatusError";
		this.code = code;
		this.record = record;
	}
}

/**
 * Process-liveness probe. `kill(pid, 0)` is the POSIX idiom: it sends no
 * signal but raises ESRCH when no such pid exists, and EPERM when the pid
 * exists but is owned by another user. We treat EPERM as alive so we don't
 * stomp on someone else's job.
 */
export function defaultIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EPERM") return true;
		return false;
	}
}

/**
 * Classify a stored record against current process liveness. Records persist
 * as "running" forever once written, so we reclassify to "unknown" when the
 * pid has disappeared — that's the stale case OpenClaw/node-invoke timeouts
 * created before this script existed.
 */
export function classifyState(
	record: PreviewStatusRecord,
	isAlive: IsAliveFn = defaultIsAlive,
): Exclude<PreviewState, "none"> {
	if (record.state !== "running") return record.state;
	if (record.pid != null && isAlive(record.pid)) return "running";
	return "unknown";
}

export function parseRecord(raw: string): PreviewStatusRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new PreviewStatusError(
			"PARSE_ERROR",
			`preview-status: invalid JSON: ${(err as Error).message}`,
		);
	}

	if (!parsed || typeof parsed !== "object") {
		throw new PreviewStatusError(
			"PARSE_ERROR",
			"preview-status: record is not an object",
		);
	}

	const obj = parsed as Record<string, unknown>;
	if (obj["version"] !== PREVIEW_STATUS_SCHEMA_VERSION) {
		throw new PreviewStatusError(
			"PARSE_ERROR",
			`preview-status: unsupported schema version ${String(obj["version"])}`,
		);
	}

	const state = obj["state"];
	if (
		state !== "running" &&
		state !== "succeeded" &&
		state !== "failed" &&
		state !== "unknown"
	) {
		throw new PreviewStatusError(
			"PARSE_ERROR",
			`preview-status: invalid state ${String(state)}`,
		);
	}

	return {
		version: PREVIEW_STATUS_SCHEMA_VERSION,
		state,
		pid: typeof obj["pid"] === "number" ? (obj["pid"] as number) : null,
		command: typeof obj["command"] === "string" ? obj["command"] : "",
		cwd: typeof obj["cwd"] === "string" ? obj["cwd"] : "",
		host: typeof obj["host"] === "string" ? obj["host"] : "",
		user: typeof obj["user"] === "string" ? obj["user"] : "",
		startedAt: typeof obj["startedAt"] === "string" ? obj["startedAt"] : "",
		finishedAt:
			typeof obj["finishedAt"] === "string" ? obj["finishedAt"] : null,
		durationMs:
			typeof obj["durationMs"] === "number" ? obj["durationMs"] : null,
		logPath: typeof obj["logPath"] === "string" ? obj["logPath"] : null,
		packageVersion:
			typeof obj["packageVersion"] === "string"
				? obj["packageVersion"]
				: null,
		artifactPath:
			typeof obj["artifactPath"] === "string" ? obj["artifactPath"] : null,
		artifactSha256:
			typeof obj["artifactSha256"] === "string"
				? obj["artifactSha256"]
				: null,
		exitCode:
			typeof obj["exitCode"] === "number" ? obj["exitCode"] : null,
	};
}

export class PreviewStatusStore {
	readonly stateDir: string;
	readonly stateFile: string;
	private readonly isAlive: IsAliveFn;

	constructor(stateDir: string, isAlive: IsAliveFn = defaultIsAlive) {
		this.stateDir = stateDir;
		this.stateFile = path.join(stateDir, "state.json");
		this.isAlive = isAlive;
	}

	async read(): Promise<PreviewStatusRecord | null> {
		try {
			const raw = await fs.readFile(this.stateFile, "utf8");
			return parseRecord(raw);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw err;
		}
	}

	async write(record: PreviewStatusRecord): Promise<void> {
		await fs.mkdir(this.stateDir, { recursive: true });
		const tmp = `${this.stateFile}.tmp`;
		await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		await fs.rename(tmp, this.stateFile);
	}

	async clear(): Promise<void> {
		try {
			await fs.unlink(this.stateFile);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}

	async classify(): Promise<PreviewState> {
		const record = await this.read();
		if (!record) return "none";
		return classifyState(record, this.isAlive);
	}

	async start(options: StartOptions): Promise<PreviewStatusRecord> {
		const existing = await this.read();
		if (existing && !options.force) {
			const live = classifyState(existing, this.isAlive);
			if (live === "running") {
				throw new PreviewStatusError(
					"ALREADY_RUNNING",
					formatAlreadyRunning(existing),
					existing,
				);
			}
		}

		const now = options.now ?? new Date();
		const record: PreviewStatusRecord = {
			version: PREVIEW_STATUS_SCHEMA_VERSION,
			state: "running",
			pid: options.pid ?? process.pid,
			command: options.command,
			cwd: options.cwd,
			host: os.hostname(),
			user: process.env["USER"] ?? os.userInfo().username,
			startedAt: now.toISOString(),
			finishedAt: null,
			durationMs: null,
			logPath: options.logPath ?? null,
			packageVersion: options.packageVersion ?? null,
			artifactPath: null,
			artifactSha256: null,
			exitCode: null,
		};
		await this.write(record);
		return record;
	}

	async finish(options: FinishOptions): Promise<PreviewStatusRecord> {
		const existing = await this.read();
		if (!existing) {
			throw new PreviewStatusError(
				"NO_RECORD",
				"preview-status: no record to finish (state file missing)",
			);
		}
		const now = options.now ?? new Date();
		const startedMs = Date.parse(existing.startedAt);
		const durationMs = Number.isFinite(startedMs)
			? now.getTime() - startedMs
			: null;
		const finished: PreviewStatusRecord = {
			...existing,
			state: options.exitCode === 0 ? "succeeded" : "failed",
			finishedAt: now.toISOString(),
			durationMs,
			exitCode: options.exitCode,
			artifactPath: options.artifactPath ?? existing.artifactPath,
			artifactSha256:
				options.artifactSha256 ?? existing.artifactSha256,
			packageVersion:
				options.packageVersion ?? existing.packageVersion,
		};
		await this.write(finished);
		return finished;
	}
}

function formatAlreadyRunning(record: PreviewStatusRecord): string {
	const pid = record.pid ?? "?";
	const startedAt = record.startedAt || "unknown";
	const command = record.command || "?";
	const log = record.logPath ?? "(no log path)";
	return [
		"A preview cut is already running.",
		`  command: ${command}`,
		`  started: ${startedAt}`,
		`  pid:     ${pid}`,
		`  log:     ${log}`,
		"",
		"To start a new preview, either:",
		"  • wait for it to finish, then re-run",
		`  • kill it (kill -TERM ${pid}) and clear: just preview-status clear`,
		"  • or force-overwrite: bun run scripts-v2/preview-status.ts start --force ...",
	].join("\n");
}

export function formatRecord(
	record: PreviewStatusRecord,
	live: Exclude<PreviewState, "none">,
): string {
	const lines = [
		`state:          ${live}${live !== record.state ? ` (stored as ${record.state})` : ""}`,
		`command:        ${record.command}`,
		`cwd:            ${record.cwd}`,
		`host/user:      ${record.host}/${record.user}`,
		`pid:            ${record.pid ?? "(none)"}`,
		`started:        ${record.startedAt}`,
		`finished:       ${record.finishedAt ?? "(running)"}`,
		`duration (ms):  ${record.durationMs ?? "(running)"}`,
		`log:            ${record.logPath ?? "(none)"}`,
		`version:        ${record.packageVersion ?? "(none)"}`,
		`artifact:       ${record.artifactPath ?? "(none)"}`,
		`artifact sha:   ${record.artifactSha256 ?? "(none)"}`,
		`exit code:      ${record.exitCode ?? "(none)"}`,
	];
	return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────

function getFlag(args: string[], name: string): string | undefined {
	const eqIdx = args.findIndex((a) => a.startsWith(`--${name}=`));
	if (eqIdx !== -1) return args[eqIdx]?.split("=").slice(1).join("=");
	const idx = args.indexOf(`--${name}`);
	if (idx === -1) return undefined;
	const next = args[idx + 1];
	if (next == null || next.startsWith("--")) return "";
	return next;
}

function hasFlag(args: string[], name: string): boolean {
	return args.includes(`--${name}`);
}

async function runCli(argv: string[]): Promise<number> {
	const [sub, ...rest] = argv;
	const stateDir =
		getFlag(argv, "state-dir") ?? path.join(process.cwd(), ".preview-status");
	const store = new PreviewStatusStore(stateDir);

	if (!sub || sub === "--help" || sub === "-h") {
		console.log(
			[
				"preview-status — track durable lifecycle of `just cut-preview` runs",
				"",
				"Usage:",
				"  preview-status start    --command=... --cwd=... [--log-path=...] [--version=...] [--force]",
				"  preview-status finish   --exit-code=N [--version=...] [--artifact=...] [--artifact-sha=...]",
				"  preview-status show     [--json]",
				"  preview-status clear",
				"",
				"State file: .preview-status/state.json (gitignored).",
			].join("\n"),
		);
		return 0;
	}

	if (sub === "start") {
		const command = getFlag(rest, "command");
		const cwd = getFlag(rest, "cwd") ?? process.cwd();
		if (!command) {
			console.error("preview-status start: --command is required");
			return 64;
		}
		try {
			const record = await store.start({
				command,
				cwd,
				logPath: getFlag(rest, "log-path") ?? null,
				packageVersion: getFlag(rest, "version") ?? null,
				pid: parsePidFlag(getFlag(rest, "pid")),
				force: hasFlag(rest, "force"),
			});
			console.log(
				`preview-status: started (pid=${record.pid}, started=${record.startedAt})`,
			);
			if (record.logPath) console.log(`  log: ${record.logPath}`);
			return 0;
		} catch (err) {
			if (
				err instanceof PreviewStatusError &&
				err.code === "ALREADY_RUNNING"
			) {
				console.error(err.message);
				return 2;
			}
			throw err;
		}
	}

	if (sub === "finish") {
		const exitCodeRaw = getFlag(rest, "exit-code");
		if (exitCodeRaw == null) {
			console.error("preview-status finish: --exit-code is required");
			return 64;
		}
		const exitCode = Number.parseInt(exitCodeRaw, 10);
		if (!Number.isFinite(exitCode)) {
			console.error(`preview-status finish: --exit-code must be a number`);
			return 64;
		}
		try {
			const record = await store.finish({
				exitCode,
				artifactPath: getFlag(rest, "artifact") ?? null,
				artifactSha256: getFlag(rest, "artifact-sha") ?? null,
				packageVersion: getFlag(rest, "version") ?? null,
			});
			console.log(
				`preview-status: ${record.state} (exit=${record.exitCode}, duration=${record.durationMs}ms)`,
			);
			return 0;
		} catch (err) {
			if (err instanceof PreviewStatusError && err.code === "NO_RECORD") {
				console.error(err.message);
				return 2;
			}
			throw err;
		}
	}

	if (sub === "show") {
		const record = await store.read();
		if (!record) {
			if (hasFlag(rest, "json")) {
				console.log(JSON.stringify({ state: "none" }));
			} else {
				console.log("preview-status: no record (state: none)");
			}
			return 0;
		}
		const live = classifyState(record);
		if (hasFlag(rest, "json")) {
			console.log(JSON.stringify({ ...record, liveState: live }, null, 2));
		} else {
			console.log(formatRecord(record, live));
		}
		return 0;
	}

	if (sub === "clear") {
		await store.clear();
		console.log("preview-status: cleared");
		return 0;
	}

	console.error(`preview-status: unknown subcommand "${sub}"`);
	return 64;
}

function parsePidFlag(raw: string | undefined): number | undefined {
	if (raw == null || raw === "") return undefined;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : undefined;
}

if (import.meta.main) {
	runCli(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		});
}
