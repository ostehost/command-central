import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenClawTask } from "../types/openclaw-task-types.js";

const DEBOUNCE_MS = 150;
const CLI_TIMEOUT_MS = 5000;
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

	reload(): void {
		try {
			const stdout = execFileSync(
				"openclaw",
				["tasks", "list", "--json", "--runtime", "acp"],
				{
					encoding: "utf-8",
					timeout: CLI_TIMEOUT_MS,
				},
			);
			this.tasks = this.parseTasksOutput(stdout);
			this._isInstalled = true;
		} catch (error: unknown) {
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
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
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

	private startWatching(): void {
		try {
			this.watcher = fs.watch(TASKS_DIR, (_event, filename) => {
				if (filename === TASKS_WAL || filename === TASKS_DB) {
					this.debouncedReload();
				}
			});
			this.watcher.on("error", () => {
				// Directory may not exist yet.
			});
		} catch {
			// OpenClaw task ledger may not exist yet.
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
