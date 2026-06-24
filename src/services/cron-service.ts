/**
 * CronService — OpenClaw cron CLI wrapper with file watching.
 *
 * Reads cron job state via `openclaw cron list --json` and watches
 * ~/.openclaw/cron/jobs.json for changes. All mutations go through
 * the CLI — never writes to jobs.json directly.
 *
 * Pattern follows OpenClawConfigService: file watch + debounce + disposal.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { CronJob, CronRun } from "../types/cron-types.js";

const DEFAULT_DEBOUNCE_MS = 150;
const CLI_TIMEOUT_MS = 5000;
const DEFAULT_WATCH_RETRY_MS = 5000;
const JOBS_FILE = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");

export class CronService implements vscode.Disposable {
	private jobs: CronJob[] = [];
	private watcher: fs.FSWatcher | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private watchRetryTimer: ReturnType<typeof setInterval> | null = null;
	private onChange: (() => void) | null = null;
	private _isInstalled = true;
	private readonly debounceMs: number;
	private readonly watchRetryMs: number;
	private reloadInFlight: Promise<void> | null = null;
	private disposed = false;

	constructor(opts: { debounceMs?: number; watchRetryMs?: number } = {}) {
		this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.watchRetryMs = opts.watchRetryMs ?? DEFAULT_WATCH_RETRY_MS;
	}

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

	/**
	 * Fire-and-forget reload. Returns synchronously so callers (start,
	 * watcher, tree refresh) never block the extension host on the CLI.
	 * Concurrent calls coalesce; the awaitable promise is exposed via
	 * {@link reloadAsync} for tests and sequencing.
	 */
	reload(): void {
		void this.reloadAsync();
	}

	/**
	 * Async reload with in-flight coalescing + post-dispose protection.
	 * - Coalescing: a second call while one is running awaits the same promise.
	 * - Post-dispose protection: a run whose CLI result resolves after the
	 *   service has been disposed discards its output instead of resurrecting
	 *   state on a torn-down service.
	 */
	reloadAsync(): Promise<void> {
		if (this.reloadInFlight) return this.reloadInFlight;
		const run = this.runReload().finally(() => {
			this.reloadInFlight = null;
		});
		this.reloadInFlight = run;
		return run;
	}

	private async runReload(): Promise<void> {
		try {
			const stdout = await this.execCli(["cron", "list", "--json"]);
			if (this.disposed) return;
			this.jobs = this.parseJobsOutput(stdout);
			this._isInstalled = true;
		} catch (error: unknown) {
			if (this.disposed) return;
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
		// Mark disposed first so an in-flight reload resolving after teardown
		// discards its result instead of resurrecting state.
		this.disposed = true;
		this.reloadInFlight = null;
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		if (this.watchRetryTimer) {
			clearInterval(this.watchRetryTimer);
			this.watchRetryTimer = null;
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

	/**
	 * Install the jobs.json watcher. If the cron directory is absent at
	 * startup (fs.watch throws ENOENT, or the watcher emits an error), fall
	 * back to polling so the watcher self-heals once OpenClaw creates the
	 * directory later — instead of staying permanently blind until restart.
	 */
	private startWatching(): void {
		if (this.tryInstallWatcher()) return;
		this.scheduleWatchRetry();
	}

	private tryInstallWatcher(): boolean {
		try {
			const dir = path.dirname(JOBS_FILE);
			const basename = path.basename(JOBS_FILE);

			const watcher = fs.watch(dir, (_event, filename) => {
				if (filename === basename) {
					this.debouncedReload();
				}
			});
			watcher.on("error", () => {
				// Directory was removed or became unwatchable — drop the dead
				// watcher and poll until it can be reinstalled.
				this.handleWatcherError();
			});
			this.watcher = watcher;
			return true;
		} catch {
			// Cron directory doesn't exist yet — caller schedules a retry.
			return false;
		}
	}

	private scheduleWatchRetry(): void {
		if (this.watchRetryTimer) return;
		this.watchRetryTimer = setInterval(() => {
			if (this.tryInstallWatcher()) {
				this.stopWatchRetry();
				// The directory appeared while we were blind; pick up any
				// changes that happened before the watcher was installed.
				this.debouncedReload();
			}
		}, this.watchRetryMs);
	}

	private stopWatchRetry(): void {
		if (this.watchRetryTimer) {
			clearInterval(this.watchRetryTimer);
			this.watchRetryTimer = null;
		}
	}

	private handleWatcherError(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		this.scheduleWatchRetry();
	}

	private debouncedReload(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			void this.reloadAsync().then(() => {
				this.onChange?.();
			});
		}, this.debounceMs);
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
