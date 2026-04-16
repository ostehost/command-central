import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { TaskFlow } from "../types/taskflow-types.js";

const DEFAULT_DEBOUNCE_MS = 150;
const CLI_TIMEOUT_MS = 5000;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const TASKS_DIR = path.join(os.homedir(), ".openclaw", "tasks");
const TASKS_DB = "runs.sqlite";
const TASKS_WAL = "runs.sqlite-wal";

export class TaskFlowService implements vscode.Disposable {
	private flows: TaskFlow[] = [];
	private watcher: fs.FSWatcher | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private onChange: (() => void) | null = null;
	private _isInstalled = true;
	private readonly debounceMs: number;

	constructor(opts: { debounceMs?: number } = {}) {
		this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	}

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
				["tasks", "flow", "list", "--json"],
				{ encoding: "utf-8", timeout: CLI_TIMEOUT_MS },
			);
			this.flows = this.parseFlowsOutput(stdout);
			this._isInstalled = true;
		} catch (error: unknown) {
			this.handleReloadError(error);
		}
	}

	getFlows(): TaskFlow[] {
		return this.flows;
	}

	getActiveFlows(): TaskFlow[] {
		return this.flows.filter(
			(flow) =>
				flow.status === "queued" ||
				flow.status === "running" ||
				flow.status === "waiting",
		);
	}

	getRecentFlows(limit = 20): TaskFlow[] {
		return [...this.flows]
			.sort(
				(left, right) =>
					this.getFlowSortTime(right) - this.getFlowSortTime(left),
			)
			.slice(0, limit);
	}

	getFlowById(id: string): TaskFlow | undefined {
		return this.flows.find((flow) => flow.flowId === id);
	}

	async cancelFlow(id: string): Promise<void> {
		await this.execCli(["tasks", "flow", "cancel", id]);
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
		this.flows = [];
	}

	private parseFlowsOutput(stdout: string): TaskFlow[] {
		if (!stdout.trim()) return [];
		const parsed = JSON.parse(stdout) as TaskFlow[] | { flows?: TaskFlow[] };
		const flows = Array.isArray(parsed) ? parsed : (parsed.flows ?? []);
		const cutoffMs = Date.now() - LOOKBACK_MS;
		return flows.filter((flow) => this.getFlowSortTime(flow) >= cutoffMs);
	}

	private getFlowSortTime(flow: TaskFlow): number {
		return flow.endedAt ?? flow.startedAt ?? flow.createdAt ?? 0;
	}

	private handleReloadError(error: unknown): void {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			this._isInstalled = false;
			this.flows = [];
			return;
		}
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
