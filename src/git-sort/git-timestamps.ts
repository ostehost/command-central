/**
 * Git-aware timestamp collection
 * Uses git's internal timestamps to survive checkout/stash/rebase operations
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

function buildIsolatedGitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("GIT_")) continue;
		env[key] = value;
	}
	return env;
}
const MAX_FILES = 500; // Increased to handle larger repositories
const TIMEOUT_MS = 200;

/**
 * Runs a git command and resolves with its stdout. Injectable so the production
 * Node extension host and tests share one code path.
 *
 * The default implementation uses node:child_process.execFile — NOT Bun.spawn,
 * which is undefined in the VS Code Node extension host (globalThis.Bun absent)
 * and would throw a ReferenceError. See PAR-64 / CP-25.
 */
export type GitRunner = (
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<string>;

// Calls execFile fresh each invocation so test mocks of node:child_process.execFile
// take effect even after mock.restore() runs between tests. (A module-load
// promisify(execFile) would cache the reference and break under bun's mock
// lifecycle.) The timeout option makes child_process kill a hung git process.
const defaultGitRunner: GitRunner = (args, options) =>
	new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{
				cwd: options.cwd,
				env: options.env,
				timeout: options.timeoutMs,
				encoding: "utf-8",
			},
			(err, stdout) => {
				if (err) reject(err);
				else resolve(String(stdout));
			},
		);
	});

export async function getGitAwareTimestamps(
	_workspaceRoot: string,
	files: string[],
): Promise<Map<string, number>> {
	const timestamps = new Map<string, number>();

	// Enforce file limit at the earliest point - increased to 500
	const limitedFiles = files.slice(0, MAX_FILES);

	// Always use filesystem timestamps for accurate modification times
	// Git doesn't provide reliable mtime for working tree files
	const promises = limitedFiles.map(async (file) => {
		const timestamp = await getFileTimestamp(file);
		return { file, timestamp };
	});

	const results = await Promise.all(promises);

	for (const { file, timestamp } of results) {
		// Only add to map if we successfully got a timestamp
		if (timestamp !== undefined) {
			timestamps.set(file, timestamp);
		}
	}

	return timestamps;
}

// Removed unused getGitTimestamps function - we always use filesystem timestamps

async function getFileTimestamp(filepath: string): Promise<number | undefined> {
	try {
		const stat = await fs.stat(filepath);
		return stat.mtime.getTime();
	} catch {
		// Return undefined to signal error - caller can handle logging
		return undefined;
	}
}

/**
 * Gets the last known modification timestamp for a deleted file from git history.
 * Returns undefined if no history is found - no fallback by design.
 * This allows us to identify edge cases through error logs.
 *
 * @public Exported for testing via mock.module() pattern
 * Note: Knip reports this as unused because it's used in dynamic mocks
 */
export async function getDeletedFileTimestamp(
	workspaceRoot: string,
	filepath: string,
	gitRunner: GitRunner = defaultGitRunner,
): Promise<number | undefined> {
	try {
		// Use relative path for git command
		const relativePath = path.relative(workspaceRoot, filepath);

		// Get the last commit timestamp for this file via node:child_process.
		// The runner's timeout kills a hung git process (200ms — VS Code guideline).
		const result = await gitRunner(
			["log", "-1", "--format=%at", "--", relativePath],
			{
				cwd: workspaceRoot,
				env: buildIsolatedGitEnv(),
				timeoutMs: TIMEOUT_MS,
			},
		);
		const trimmed = result.trim();

		if (trimmed) {
			// Convert Unix timestamp (seconds) to JavaScript timestamp (milliseconds)
			const timestamp = parseInt(trimmed, 10) * 1000;
			return timestamp;
		}

		// No git history found - return undefined
		// This may occur for files that were created and deleted without being committed
		return undefined;
	} catch {
		// Command failed - return undefined
		// Git command may have failed or file may not be in repository
		return undefined;
	}
}

/**
 * NOTE: getChangedFiles() function was moved to legacy/unused-code/
 * on 2025-10-19. It was unused and replaced by VS Code's Git API integration.
 * See legacy/unused-code/getChangedFiles.ts for the original implementation.
 */
