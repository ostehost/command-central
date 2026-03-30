/**
 * CronService — OpenClaw cron CLI wrapper with file watching.
 *
 * Reads cron job state via `openclaw cron list --json` and watches
 * ~/.openclaw/cron/jobs.json for changes. All mutations go through
 * the CLI — never writes to jobs.json directly.
 *
 * Pattern follows OpenClawConfigService: file watch + debounce + disposal.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { CronJob, CronRun } from "../types/cron-types.js";

const DEBOUNCE_MS = 150;
const CLI_TIMEOUT_MS = 5000;
const JOBS_FILE = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");

export class CronService implements vscode.Disposable {
	private jobs: CronJob[] = [];
	private watcher: fs.FSWatcher | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private onChange: (() => void) | null = null;
	private _isInstalled = true;

	get isInstalled(): boolean {
		return this._isInstalled;
	}

	start(onChange: () => void): void {
		this.onChange = onChange;
		this.reload();
		this.startWatching();
	}

	getJobs(): CronJob[] {
		return this.jobs;
	}

	reload(): void {
		try {
			const stdout = execFileSync("openclaw", ["cron", "list", "--json"], {
				encoding: "utf-8",
				timeout: CLI_TIMEOUT_MS,
			});
			this.jobs = this.parseJobsOutput(stdout);
			this._isInstalled = true;
		} catch (error: unknown) {
			this.handleReloadError(error);
		}
	}

	async enableJob(id: string): Promise<void> {
		await this.execCli(["cron", "enable", id]);
	}

	async disableJob(id: string): Promise<void> {
		await this.execCli(["cron", "disable", id]);
	}

	async runJob(id: string): Promise<void> {
		await this.execCli(["cron", "run", id]);
	}

	async getSchedulerStatus(): Promise<{ ok: boolean; nextPoll?: string }> {
		try {
			const stdout = await this.execCli(["cron", "status"]);
			const data = JSON.parse(stdout) as { ok: boolean; nextPoll?: string };
			return data;
		} catch {
			return { ok: false };
		}
	}

	// ── Phase 2 stubs ──────────────────────────────────────────────────

	async createJob(_opts: unknown): Promise<void> {
		throw new Error("Create Job — coming in Phase 2");
	}

	async editJob(_id: string, _opts: unknown): Promise<void> {
		throw new Error("Edit Job — coming in Phase 2");
	}

	async deleteJob(_id: string): Promise<void> {
		throw new Error("Delete Job — coming in Phase 2");
	}

	async getRunHistory(_id: string): Promise<CronRun[]> {
		throw new Error("Run History — coming in Phase 2");
	}

	dispose(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.onChange = null;
		this.jobs = [];
	}

	// ── Internal ────────────────────────────────────────────────────────

	private parseJobsOutput(stdout: string): CronJob[] {
		if (!stdout.trim()) return [];
		const parsed = JSON.parse(stdout);
		if (Array.isArray(parsed)) return parsed as CronJob[];
		if (parsed && Array.isArray(parsed.jobs)) return parsed.jobs as CronJob[];
		return [];
	}

	private handleReloadError(error: unknown): void {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			this._isInstalled = false;
			this.jobs = [];
			return;
		}
		// Non-zero exit or timeout — keep last known state
	}

	private startWatching(): void {
		try {
			const dir = path.dirname(JOBS_FILE);
			const basename = path.basename(JOBS_FILE);

			this.watcher = fs.watch(dir, (_event, filename) => {
				if (filename === basename) {
					this.debouncedReload();
				}
			});
			this.watcher.on("error", () => {
				// Directory may not exist — ok
			});
		} catch {
			// Cron directory doesn't exist — graceful no-op
		}
	}

	private debouncedReload(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			this.reload();
			this.onChange?.();
		}, DEBOUNCE_MS);
	}

	private execCli(args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(
				"openclaw",
				args,
				{ encoding: "utf-8", timeout: CLI_TIMEOUT_MS },
				(error, stdout) => {
					if (error) return reject(error);
					resolve(stdout);
				},
			);
		});
	}
}
