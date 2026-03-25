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

/**
 * Escape a project directory path the same way Claude Code does.
 * All `/` characters are replaced with `-`.
 *
 * Example: `/Users/ostemini/projects/command-central` → `-Users-ostemini-projects-command-central`
 */
export function escapeProjectPath(projectDir: string): string {
	return projectDir.replace(/\//g, "-");
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
	const escaped = escapeProjectPath(projectDir);
	const baseDir =
		claudeBaseDir ?? path.join(os.homedir(), ".claude", "projects");
	const sessionsDir = path.join(baseDir, escaped);

	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(sessionsDir, {
			withFileTypes: true,
		});
	} catch {
		// Directory missing or unreadable
		return null;
	}

	const jsonlFiles = entries.filter(
		(e) => e.isFile() && e.name.endsWith(".jsonl"),
	);

	if (jsonlFiles.length === 0) {
		return null;
	}

	// Find the most recently modified .jsonl file
	let newest: { name: string; mtime: number } | null = null;

	for (const file of jsonlFiles) {
		try {
			const stat = await fs.promises.stat(path.join(sessionsDir, file.name));
			if (!newest || stat.mtimeMs > newest.mtime) {
				newest = { name: file.name, mtime: stat.mtimeMs };
			}
		} catch {
			// Skip files we can't stat
		}
	}

	if (!newest) {
		return null;
	}

	// Strip .jsonl extension to get the UUID
	return newest.name.replace(/\.jsonl$/, "");
}
