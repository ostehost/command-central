import * as fs from "node:fs";
import * as path from "node:path";
import { resolveClaudeTranscriptPathForTask } from "../discovery/session-resolver.js";
import type { AgentTask } from "../providers/agent-status-tree-provider.js";

export type ResumeBackend = "claude" | "codex" | "gemini" | "acp" | "unknown";

type ResumeTask = Pick<
	AgentTask,
	| "agent_backend"
	| "claude_session_id"
	| "cli_name"
	| "completed_at"
	| "project_dir"
	| "started_at"
	| "stream_file"
>;

export function resolveResumeBackend(task: ResumeTask): ResumeBackend {
	const hint = `${task.agent_backend ?? task.cli_name ?? ""}`
		.trim()
		.toLowerCase();
	if (!hint) return "unknown";
	if (hint.startsWith("acp")) return "acp";
	if (hint.includes("codex")) return "codex";
	if (hint.includes("gemini")) return "gemini";
	if (hint.includes("claude")) return "claude";
	return "unknown";
}

export function canShowResumeAction(task: ResumeTask): boolean {
	return resolveResumeBackend(task) !== "acp";
}

export function supportsInteractiveResume(task: ResumeTask): boolean {
	const backend = resolveResumeBackend(task);
	return (
		backend === "claude" ||
		backend === "codex" ||
		backend === "gemini" ||
		backend === "unknown"
	);
}

/**
 * Claude conversation transcripts live at
 * `~/.claude/projects/<dirhash>/<uuid>.jsonl`. The basename is a lowercase
 * v4 UUID and is the literal value accepted by `claude --resume <uuid>`.
 * Sharing the regex between the resume builder and the tree's at-a-glance
 * link indicator keeps the contract co-located.
 */
const CLAUDE_SESSION_ID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidClaudeSessionId(value?: string | null): boolean {
	return Boolean(value?.trim() && CLAUDE_SESSION_ID_REGEX.test(value.trim()));
}

/**
 * Returns the trimmed UUID if it's a valid claude session id; null otherwise.
 * Use this instead of `isValidClaudeSessionId` + non-null assertion when you
 * need to pass the UUID forward to another call — keeps the type-narrowing
 * inside one expression and avoids the `noNonNullAssertion` lint.
 */
export function getValidClaudeSessionId(value?: string | null): string | null {
	const trimmed = value?.trim();
	if (trimmed && CLAUDE_SESSION_ID_REGEX.test(trimmed)) return trimmed;
	return null;
}

export async function buildResumeCommand(
	task: ResumeTask,
	_claudeBaseDir?: string,
): Promise<string | null> {
	const backend = resolveResumeBackend(task);
	switch (backend) {
		case "acp":
			return null;
		case "codex":
			return "codex resume --last";
		case "gemini":
			return "gemini -p --resume latest";
		case "claude":
		case "unknown": {
			// Prefer task-specific session resume when we have a recorded
			// claude_session_id. Without this, every task in the same
			// project_dir resumes the SAME conversation (the most recent),
			// because `claude --continue` is directory-scoped — not task-
			// scoped. The user reported this as "all sessions seem to be
			// going to the same."
			//
			// claude_session_id is a UUID matching the basename of a file in
			// ~/.claude/projects/<dirhash>/<id>.jsonl. Spawn-time capture of
			// this ID into tasks.json is a launcher-side follow-up; for
			// pre-existing tasks (and any task where capture failed), we
			// fall through to the historical --continue path.
			const claudeUuid = getValidClaudeSessionId(task.claude_session_id);
			if (claudeUuid) {
				return `claude --resume ${claudeUuid}`;
			}
			return "claude --continue";
		}
	}
}

/**
 * Derive the expected /Applications/Projects/{projectId}.app path from a
 * project directory or an explicit bundle_path stored on the task.
 */
export function resolveProjectBundlePath(
	task: Pick<ResumeTask, "project_dir"> & { bundle_path?: string | null },
): string | null {
	// If the task already carries a concrete .app bundle path, prefer that.
	const explicit = task.bundle_path?.trim();
	if (
		explicit?.endsWith(".app") &&
		!explicit.startsWith("(") &&
		fs.existsSync(explicit)
	) {
		return explicit;
	}

	// Convention: /Applications/Projects/<basename>.app
	const basename = path.basename(task.project_dir);
	if (!basename) return null;
	const conventional = path.join(
		"/Applications",
		"Projects",
		`${basename}.app`,
	);
	return fs.existsSync(conventional) ? conventional : null;
}

/**
 * Check whether a usable project launcher bundle is available on disk.
 */
export function isProjectBundleAvailable(
	task: Pick<ResumeTask, "project_dir"> & { bundle_path?: string | null },
): boolean {
	return resolveProjectBundlePath(task) !== null;
}

export async function resolveTaskTranscriptPath(
	task: ResumeTask,
	claudeBaseDir?: string,
): Promise<string | null> {
	const backend = resolveResumeBackend(task);
	if (backend === "claude" || backend === "unknown") {
		const transcriptPath = await resolveClaudeTranscriptPathForTask(
			task,
			claudeBaseDir,
		);
		if (transcriptPath) {
			return transcriptPath;
		}
	}

	const streamFile = task.stream_file?.trim();
	if (streamFile && fs.existsSync(streamFile)) {
		return streamFile;
	}

	return null;
}
