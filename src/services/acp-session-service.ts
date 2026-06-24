import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenClawTask } from "../types/openclaw-task-types.js";

const DEFAULT_DEBOUNCE_MS = 150;
const CLI_TIMEOUT_MS = 5000;
const DEFAULT_WATCH_RETRY_MS = 5000;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const TASKS_DIR = path.join(os.homedir(), ".openclaw", "tasks");
const TASKS_DB = "runs.sqlite";
const TASKS_WAL = "runs.sqlite-wal";

/**
 * AcpSessionService — discovery source for ACP-runtime OpenClaw tasks.
 *
 * Polls `openclaw tasks list --json --runtime acp` and watches the
 * SQLite ledger for changes. Used as the 4th discovery source by
 * AgentRegistry to suppress process-scanned duplicates of ACP-spawned
 * Claude Code sessions.
 */
export class AcpSessionService {
	private tasks: OpenClawTask[] = [];
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

	/**
	 * Fire-and-forget reload. Returns synchronously so callers (start,
	 * watcher) never block the extension host on the CLI. Concurrent calls
	 * coalesce onto the in-flight run; the awaitable promise is exposed via
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
			const stdout = await this.execCli([
				"tasks",
				"list",
				"--json",
				"--runtime",
				"acp",
			]);
			if (this.disposed) return;
			this.tasks = this.parseTasksOutput(stdout);
			this._isInstalled = true;
		} catch (error: unknown) {
			if (this.disposed) return;
			this.handleReloadError(error);
		}
	}

	getTasks(): OpenClawTask[] {
		return this.tasks;
	}

	getRunningTasks(): OpenClawTask[] {
		return this.tasks.filter(
			(task) => task.status === "queued" || task.status === "running",
		);
	}

	getTaskById(id: string): OpenClawTask | undefined {
		return this.tasks.find((task) => task.taskId === id);
	}

	async cancelTask(id: string): Promise<void> {
		await this.execCli(["tasks", "cancel", id]);
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
		this.tasks = [];
	}

	private parseTasksOutput(stdout: string): OpenClawTask[] {
		if (!stdout.trim()) return [];
		const parsed = JSON.parse(stdout) as
			| OpenClawTask[]
			| { tasks?: OpenClawTask[] };
		const tasks = Array.isArray(parsed) ? parsed : (parsed.tasks ?? []);
		const cutoffMs = Date.now() - LOOKBACK_MS;
		return tasks
			.filter((task) => task.runtime === "acp")
			.filter((task) => this.getTaskSortTime(task) >= cutoffMs);
	}

	private getTaskSortTime(task: OpenClawTask): number {
		return (
			task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt ?? 0
		);
	}

	private handleReloadError(error: unknown): void {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			this._isInstalled = false;
			this.tasks = [];
			return;
		}
		// Non-ENOENT errors (e.g. non-zero exit): keep last known state.
	}

	/**
	 * Install the tasks-dir watcher. If the OpenClaw tasks directory is absent
	 * at startup (fs.watch throws ENOENT, or the watcher emits an error), fall
	 * back to polling so the watcher self-heals once the ledger is created
	 * later — instead of staying permanently blind until restart.
	 */
	private startWatching(): void {
		if (this.tryInstallWatcher()) return;
		this.scheduleWatchRetry();
	}

	private tryInstallWatcher(): boolean {
		try {
			const watcher = fs.watch(TASKS_DIR, (_event, filename) => {
				if (filename === TASKS_WAL || filename === TASKS_DB) {
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
			// OpenClaw task ledger may not exist yet — caller schedules a retry.
			return false;
		}
	}

	private scheduleWatchRetry(): void {
		if (this.watchRetryTimer) return;
		this.watchRetryTimer = setInterval(() => {
			if (this.tryInstallWatcher()) {
				this.stopWatchRetry();
				// The ledger appeared while we were blind; pick up any changes
				// that happened before the watcher was installed.
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
