/**
 * Pure prompt-summary text processing for agent task rows.
 *
 * These functions strip launcher/harness boilerplate and normalize prompt text
 * into a short, human-readable summary line for the tree. They were extracted
 * from AgentStatusTreeProvider, where they were stateless private string
 * helpers. No provider state is touched.
 */

/** First meaningful (non-boilerplate) line of a raw prompt, or null. */
export function cleanPromptForDisplay(raw: string): string | null {
	const lines = raw.split("\n");
	const boilerplatePrefixes = [
		"ULTRATHINK",
		"<system-reminder>",
		"---",
		"##",
		"# Task",
		"task_id:",
	];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (boilerplatePrefixes.some((p) => trimmed.startsWith(p))) continue;
		return trimmed;
	}
	return null;
}

export function truncatePromptSummary(value: string): string {
	return value.length > 80 ? `${value.substring(0, 80)}…` : value;
}

export function normalizePromptSummaryLine(line: string): string | null {
	const normalized = line
		.trim()
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+\.\s+/, "")
		.replace(/^>\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length > 0 ? normalized : null;
}

export function isPromptBoilerplateLine(line: string): boolean {
	return [
		/^At the START of your work/i,
		/^Use the task system/i,
		/^As you work/i,
		/^When ALL work is complete/i,
		/^The TaskCompleted hook/i,
		/^This is critical/i,
		/^\d+\.\s+\*\*Commit all changes/i,
		/^\d+\.\s+\*\*Verify clean working tree/i,
		/^\d+\.\s+\*\*Do not exit with uncommitted work/i,
		/^\d+\.\s+\*\*Fix hooks, never bypass them/i,
		/^\d+\.\s+\*\*Write the handoff file/i,
		/^\d+\.\s+\*\*Completion is automatic/i,
		/^You MUST write a completion report/i,
		/^This file is checked by the orchestrator/i,
		// rc.37: defensive skip of harness role preambles synthesized by
		// `~/projects/ghostty-launcher/scripts/write-prompt.sh` (lines
		// ~117-131). The launcher wraps user prompts with one of these
		// role declarations before claude sees them, and `prompt_file` in
		// tasks.json points at the WRAPPED file — so without this skip
		// every task row in the tree shows the harness boilerplate
		// instead of the user's actual prompt content.
		/^You are the implementation agent for task_id/i,
		/^You are the team lead for task_id/i,
		/^You are the test agent for task_id/i,
	].some((pattern) => pattern.test(line));
}
