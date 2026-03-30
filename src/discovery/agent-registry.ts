/**
 * AgentRegistry — Unified agent list merging three discovery sources.
 *
 * Sources (in priority order):
 *   1. Launcher tasks.json   — richest metadata (status, role, PR, etc.)
 *   2. SessionWatcher         — ~/.claude/sessions/ (sessionId, cwd, pid)
 *   3. ProcessScanner         — ps/lsof (pid, cwd, command args)
 *
 * Dedup rules:
 *   - Match by PID first
 *   - Then by projectDir + sessionId
 *   - Higher-priority source wins on conflict
 */

import * as vscode from "vscode";
import type { AgentTask } from "../providers/agent-status-tree-provider.js";
import {
	type ProcessScanDiagnostics,
	ProcessScanner,
} from "./process-scanner.js";
import { SessionWatcher } from "./session-watcher.js";
import type { DiscoveredAgent } from "./types.js";

export interface AgentRegistryDiagnostics {
	discoveredCount: number;
	sessionFileCount: number;
	prunedDeadAgents: number;
	processScanner: ProcessScanDiagnostics;
}

export class AgentRegistry implements vscode.Disposable {
	private readonly processScanner = new ProcessScanner();
	private readonly sessionWatcher: SessionWatcher;

	private discoveredAgents: DiscoveredAgent[] = [];
	private scanTimer: ReturnType<typeof setInterval> | null = null;
	private scanning = false;
	private lastSessionAgentCount = 0;
	private lastPrunedDeadAgents = 0;

	private _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	/** Alias for onDidChange — semantic name for tree view consumers */
	readonly onDidChangeAgents = this._onDidChange.event;

	private disposables: vscode.Disposable[] = [];

	constructor(sessionsDir?: string) {
		this.sessionWatcher = new SessionWatcher(sessionsDir);
	}

	/** Start polling and watching. */
	start(): void {
		// Start session file watcher
		this.sessionWatcher.start(() => {
			this.mergeAndNotify();
		});

		// Initial process scan
		this.doProcessScan();

		// Set up polling interval from config
		this.startPolling();

		// React to config changes
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("commandCentral.discovery.pollInterval")) {
					this.restartPolling();
				}
			}),
		);
	}

	/** Start periodic process scanning at the given interval (or config default). */
	startPolling(intervalMs?: number): void {
		this.stopPolling();
		const config = vscode.workspace.getConfiguration("commandCentral");
		const configInterval = config.get<number>("discovery.pollInterval", 5000);
		const interval = Math.max(intervalMs ?? configInterval, 2000);
		this.scanTimer = setInterval(() => {
			this.doProcessScan();
		}, interval);
	}

	/** Stop periodic process scanning. */
	stopPolling(): void {
		if (this.scanTimer) {
			clearInterval(this.scanTimer);
			this.scanTimer = null;
		}
	}

	/**
	 * Get discovered agents that are NOT already in the launcher task list.
	 * This is the list that should be merged into the tree view.
	 */
	getDiscoveredAgents(launcherTasks: AgentTask[]): DiscoveredAgent[] {
		const launcherPids = new Set<number>();
		const launcherSessionIds = new Set<string>();

		for (const task of launcherTasks) {
			// Only hide discovered agents for actively running launcher entries.
			// Non-running launcher entries should not mask a live discovered agent.
			if (task.status === "running") {
				const maybePid = (task as AgentTask & { pid?: unknown }).pid;
				if (typeof maybePid === "number" && Number.isFinite(maybePid)) {
					launcherPids.add(maybePid);
				}
				if (task.session_id) {
					launcherSessionIds.add(task.session_id);
				}
			}
		}

		// Merge session-watcher + process-scanner, dedup by PID
		const merged = this.mergeDiscoverySources();

		// Filter out anything already tracked by the launcher
		return merged.filter((agent) => {
			if (launcherPids.has(agent.pid)) return false;
			if (agent.sessionId && launcherSessionIds.has(agent.sessionId))
				return false;
			return true;
		});
	}

	/** Get all raw discovered agents (before launcher dedup) */
	getAllDiscovered(): DiscoveredAgent[] {
		return [...this.refreshLiveDiscoveredAgents()];
	}

	getDiagnostics(): AgentRegistryDiagnostics {
		const discoveredAgents = this.refreshLiveDiscoveredAgents();
		return {
			discoveredCount: discoveredAgents.length,
			sessionFileCount: this.lastSessionAgentCount,
			prunedDeadAgents: this.lastPrunedDeadAgents,
			processScanner: this.processScanner.getLastDiagnostics(),
		};
	}

	dispose(): void {
		this.stopPolling();
		this.sessionWatcher.dispose();
		this._onDidChange.dispose();
		for (const d of this.disposables) d.dispose();
	}

	// ── Internal ────────────────────────────────────────────────────────

	private async doProcessScan(): Promise<void> {
		if (this.scanning) return; // debounce
		this.scanning = true;
		try {
			const agents = await this.processScanner.scan();
			const sessionAgents = this.getLiveSessionAgents();
			this.discoveredAgents = this.setLiveDiscoveredAgents([
				...sessionAgents,
				...agents,
			]);
			this._onDidChange.fire();
		} finally {
			this.scanning = false;
		}
	}

	private mergeAndNotify(): void {
		const sessionAgents = this.getLiveSessionAgents();
		// Merge session agents into the existing process-scanned list
		const processOnly = this.discoveredAgents.filter(
			(a) => a.source === "process",
		);
		this.discoveredAgents = this.setLiveDiscoveredAgents([
			...sessionAgents,
			...processOnly,
		]);
		this._onDidChange.fire();
	}

	/**
	 * Merge session-watcher and process-scanner agents.
	 * Session-file source wins over process source for same PID.
	 */
	private mergeDiscoverySources(): DiscoveredAgent[] {
		return this.refreshLiveDiscoveredAgents();
	}

	/**
	 * Deduplicate agents by PID. Session-file source has priority
	 * over process source (richer metadata).
	 */
	private dedup(agents: DiscoveredAgent[]): DiscoveredAgent[] {
		const byPid = new Map<number, DiscoveredAgent>();

		for (const agent of agents) {
			const existing = byPid.get(agent.pid);
			if (!existing) {
				byPid.set(agent.pid, agent);
			} else if (
				this.sourcePriority(agent.source) > this.sourcePriority(existing.source)
			) {
				// Merge: keep higher-priority source but fill in missing fields
				byPid.set(agent.pid, {
					...existing,
					...agent,
					// Preserve model from process scanner if session file doesn't have it
					model: agent.model || existing.model,
				});
			} else if (
				this.sourcePriority(agent.source) < this.sourcePriority(existing.source)
			) {
				// Fill in missing fields from lower-priority source
				byPid.set(agent.pid, {
					...agent,
					...existing,
					model: existing.model || agent.model,
				});
			}
		}

		return Array.from(byPid.values());
	}

	private sourcePriority(source: string): number {
		switch (source) {
			case "launcher":
				return 3;
			case "session-file":
				return 2;
			case "process":
				return 1;
			default:
				return 0;
		}
	}

	private restartPolling(): void {
		this.startPolling();
	}

	private getLiveSessionAgents(): DiscoveredAgent[] {
		const sessionAgents = this.sessionWatcher.getAgents();
		this.lastSessionAgentCount = sessionAgents.length;
		return sessionAgents;
	}

	private setLiveDiscoveredAgents(
		agents: DiscoveredAgent[],
	): DiscoveredAgent[] {
		const deduped = this.dedup(agents);
		const liveAgents = this.filterLiveAgents(deduped);
		this.lastPrunedDeadAgents = deduped.length - liveAgents.length;
		return liveAgents;
	}

	private refreshLiveDiscoveredAgents(): DiscoveredAgent[] {
		const liveAgents = this.filterLiveAgents(this.discoveredAgents);
		const prunedDeadAgents = this.discoveredAgents.length - liveAgents.length;
		if (prunedDeadAgents > 0 || this.lastPrunedDeadAgents === 0) {
			this.lastPrunedDeadAgents = prunedDeadAgents;
		}
		this.discoveredAgents = liveAgents;
		return liveAgents;
	}

	private filterLiveAgents(agents: DiscoveredAgent[]): DiscoveredAgent[] {
		return agents.filter((agent) => this.isPidAlive(agent.pid));
	}

	private isPidAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}
}
