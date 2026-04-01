import * as fs from "node:fs";
import {
	resolveClaudeSessionIdForTask,
	resolveClaudeTranscriptPathForTask,
} from "../discovery/session-resolver.js";
import type { AgentTask } from "../providers/agent-status-tree-provider.js";
import { shellQuote } from "../utils/shell-command.js";

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

export async function buildResumeCommand(
	task: ResumeTask,
	claudeBaseDir?: string,
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
			const sessionId = await resolveClaudeSessionIdForTask(
				task,
				claudeBaseDir,
			);
			return sessionId
				? `claude --resume ${shellQuote(sessionId)}`
				: "claude --continue";
		}
	}
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
