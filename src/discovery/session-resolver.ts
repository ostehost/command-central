/**
 * Session Resolver — finds Claude Code session IDs by project directory.
 *
 * Claude Code stores session files at:
 *   ~/.claude/projects/{escaped-path}/{uuid}.jsonl
 *
 * The escaped path replaces all `/` with `-`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTask } from "../providers/agent-status-tree-provider.js";

export interface ClaudeSessionCandidate {
	sessionId: string;
	transcriptPath: string;
	createdAtMs: number;
	modifiedAtMs: number;
}

type ClaudeTaskResolutionInput = Pick<
	AgentTask,
	"project_dir" | "started_at" | "completed_at" | "claude_session_id"
>;

/**
 * Escape a project directory path the same way Claude Code does.
 * All `/` characters are replaced with `-`.
 *
 * Example: `/Users/ostemini/projects/command-central` → `-Users-ostemini-projects-command-central`
 */
export function escapeProjectPath(projectDir: string): string {
	return projectDir.replace(/\//g, "-");
}

function getClaudeSessionsDir(
	projectDir: string,
	claudeBaseDir?: string,
): string {
	const escaped = escapeProjectPath(projectDir);
	const baseDir =
		claudeBaseDir ?? path.join(os.homedir(), ".claude", "projects");
	return path.join(baseDir, escaped);
}

function parseIsoTimestamp(value?: string | null): number | null {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
}

function getSessionCreatedAtMs(stat: fs.Stats): number {
	return stat.birthtimeMs > 0
		? Math.min(stat.birthtimeMs, stat.mtimeMs)
		: stat.mtimeMs;
}

function byNewestCreatedAt(
	a: ClaudeSessionCandidate,
	b: ClaudeSessionCandidate,
): number {
	return (
		b.createdAtMs - a.createdAtMs ||
		b.modifiedAtMs - a.modifiedAtMs ||
		b.sessionId.localeCompare(a.sessionId)
	);
}

function byNewestModifiedAt(
	a: ClaudeSessionCandidate,
	b: ClaudeSessionCandidate,
): number {
	return (
		b.modifiedAtMs - a.modifiedAtMs ||
		b.createdAtMs - a.createdAtMs ||
		b.sessionId.localeCompare(a.sessionId)
	);
}

async function listClaudeSessionCandidates(
	projectDir: string,
	claudeBaseDir?: string,
): Promise<ClaudeSessionCandidate[]> {
	const sessionsDir = getClaudeSessionsDir(projectDir, claudeBaseDir);

	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(sessionsDir, {
			withFileTypes: true,
		});
	} catch {
		return [];
	}

	const candidates = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map(async (entry): Promise<ClaudeSessionCandidate | null> => {
				const transcriptPath = path.join(sessionsDir, entry.name);
				try {
					const stat = await fs.promises.stat(transcriptPath);
					return {
						sessionId: entry.name.replace(/\.jsonl$/, ""),
						transcriptPath,
						createdAtMs: getSessionCreatedAtMs(stat),
						modifiedAtMs: stat.mtimeMs,
					};
				} catch {
					return null;
				}
			}),
	);

	return candidates
		.filter((candidate) => candidate !== null)
		.sort(byNewestCreatedAt);
}

function selectClaudeSessionCandidateForTask(
	candidates: readonly ClaudeSessionCandidate[],
	task: ClaudeTaskResolutionInput,
): ClaudeSessionCandidate | null {
	const startedAtMs = parseIsoTimestamp(task.started_at);
	const completedAtMs = parseIsoTimestamp(task.completed_at ?? null);
	const withinTaskWindow = candidates.filter((candidate) => {
		if (startedAtMs !== null && candidate.createdAtMs < startedAtMs) {
			return false;
		}
		if (completedAtMs !== null && candidate.createdAtMs > completedAtMs) {
			return false;
		}
		return true;
	});
	if (withinTaskWindow.length > 0) {
		return withinTaskWindow[0] ?? null;
	}

	const afterTaskStarted = candidates.filter((candidate) =>
		startedAtMs === null ? true : candidate.createdAtMs >= startedAtMs,
	);
	if (afterTaskStarted.length > 0) {
		return afterTaskStarted[0] ?? null;
	}

	return candidates[0] ?? null;
}

async function resolveClaudeSessionCandidateForTask(
	task: ClaudeTaskResolutionInput,
	claudeBaseDir?: string,
): Promise<ClaudeSessionCandidate | null> {
	const candidates = await listClaudeSessionCandidates(
		task.project_dir,
		claudeBaseDir,
	);
	if (candidates.length === 0) {
		return null;
	}

	const explicitSessionId = task.claude_session_id?.trim();
	if (explicitSessionId) {
		const explicitCandidate = candidates.find(
			(candidate) => candidate.sessionId === explicitSessionId,
		);
		if (explicitCandidate) {
			return explicitCandidate;
		}
		const explicitPath = path.join(
			getClaudeSessionsDir(task.project_dir, claudeBaseDir),
			`${explicitSessionId}.jsonl`,
		);
		try {
			const stat = await fs.promises.stat(explicitPath);
			return {
				sessionId: explicitSessionId,
				transcriptPath: explicitPath,
				createdAtMs: getSessionCreatedAtMs(stat),
				modifiedAtMs: stat.mtimeMs,
			};
		} catch {
			// Stored ID is missing on disk — fall back to timestamp heuristics.
		}
	}

	return selectClaudeSessionCandidateForTask(candidates, task);
}

/**
 * Resolve the most recent Claude Code session ID for a project directory.
 * Returns the UUID (filename without .jsonl) of the most recently modified session file,
 * or null if no sessions are found.
 */
export async function resolveClaudeSessionId(
	projectDir: string,
	claudeBaseDir?: string,
): Promise<string | null> {
	const newest = (
		await listClaudeSessionCandidates(projectDir, claudeBaseDir)
	).sort(byNewestModifiedAt)[0];
	return newest?.sessionId ?? null;
}

export async function resolveClaudeSessionIdForTask(
	task: ClaudeTaskResolutionInput,
	claudeBaseDir?: string,
): Promise<string | null> {
	const candidate = await resolveClaudeSessionCandidateForTask(
		task,
		claudeBaseDir,
	);
	return candidate?.sessionId ?? null;
}

export async function resolveClaudeTranscriptPathForTask(
	task: ClaudeTaskResolutionInput,
	claudeBaseDir?: string,
): Promise<string | null> {
	const candidate = await resolveClaudeSessionCandidateForTask(
		task,
		claudeBaseDir,
	);
	return candidate?.transcriptPath ?? null;
}
