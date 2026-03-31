/**
 * Shared types for the agent discovery subsystem.
 *
 * Three discovery sources feed into AgentRegistry:
 *   1. ProcessScanner  — `ps` + `lsof` based detection
 *   2. SessionWatcher  — ~/.claude/projects/ file watcher
 *   3. Launcher        — existing tasks.json (AgentTask)
 */

import type { WorktreeInfo } from "./worktree-resolver.js";

export type DiscoverySource = "process" | "session-file" | "launcher";

export interface DiscoveredAgent {
	/** OS process ID (used for dedup across sources) */
	pid: number;
	/** Parent process ID when discovered from the process table */
	ppid?: number;
	/** Absolute path to the project the agent is working in */
	projectDir: string;
	/** Raw command string from `ps` */
	command: string;
	/** CLI name if known (for example: claude, codex, gemini) */
	cli_name?: string;
	/** Normalized backend hint for UI type detection */
	agent_backend?: "claude" | "codex" | "gemini";
	/** When the process started */
	startTime: Date;
	/** Model flag parsed from --model arg, if present */
	model?: string;
	/** Session ID parsed from args or session file */
	sessionId?: string;
	/** Git worktree info if the agent is in a worktree */
	worktree?: WorktreeInfo;
	/** Which discovery mechanism found this agent */
	source: DiscoverySource;
}
