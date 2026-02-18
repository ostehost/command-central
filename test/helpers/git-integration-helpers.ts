/**
 * Git Integration Test Helpers
 *
 * EVOLUTION FROM PREVIOUS SESSION:
 * - Previous: Failed unit mocks with Bun.spawn
 * - Now: REAL git repositories for integration testing
 *
 * VALUE PROPOSITION:
 * - Reusable across all git-related tests
 * - Fast temp directory creation (Bun native)
 * - Real git operations prove actual functionality
 * - Team can use these helpers for future work
 *
 * BEST PRACTICES (VS Code Extension Testing 2024):
 * - Integration tests > unit mocks for external commands
 * - Temp directories for isolation
 * - Cleanup after tests (no pollution)
 */

import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Run a git command in the given directory. Throws on non-zero exit. */
export function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
		timeout: 10_000,
	});
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed (exit ${result.status}): ${result.stderr}`,
		);
	}
	return (result.stdout ?? "").trim();
}

export interface GitRepo {
	/** Absolute path to repository root */
	path: string;
	/** Cleanup function - MUST call in afterEach */
	cleanup: () => Promise<void>;
}

export interface GitCommitOptions {
	/** File path relative to repo root */
	relativePath: string;
	/** File content */
	content: string;
	/** Optional commit message (default: "Add {filename}") */
	message?: string;
	/** Optional commit timestamp (default: Date.now()) */
	timestamp?: number;
}

/**
 * Create a temporary git repository for testing
 *
 * USAGE:
 * ```typescript
 * let repo: GitRepo;
 * beforeEach(async () => {
 *   repo = await createTempGitRepo();
 * });
 * afterEach(async () => {
 *   await repo.cleanup();
 * });
 * ```
 *
 * @param prefix - Directory prefix (default: "git-test-")
 * @returns GitRepo with path and cleanup function
 */
export async function createTempGitRepo(
	prefix = "git-test-",
): Promise<GitRepo> {
	// Create temp directory (Bun native - FAST!)
	const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));

	try {
		// Initialize git repository
		git(repoPath, "init");

		// Configure git user (required for commits)
		git(repoPath, "config", "user.name", "Test User");
		git(repoPath, "config", "user.email", "test@example.com");

		return {
			path: repoPath,
			cleanup: async () => {
				try {
					await fs.rm(repoPath, { recursive: true, force: true });
				} catch (_error) {
					// Ignore cleanup errors (directory may be locked)
				}
			},
		};
	} catch (error) {
		// Cleanup on failure
		try {
			await fs.rm(repoPath, { recursive: true, force: true });
		} catch (_cleanupError) {
			// Ignore
		}
		throw new Error(
			`Failed to create git repository: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Commit a file to the git repository
 *
 * VALUE: Creates REAL git history for testing deleted file timestamps
 *
 * @param repo - Git repository from createTempGitRepo()
 * @param options - Commit options
 * @returns Absolute path to created file
 */
export async function commitFile(
	repo: GitRepo,
	options: GitCommitOptions,
): Promise<string> {
	const { relativePath, content, message, timestamp } = options;

	// Calculate absolute path
	const absolutePath = path.join(repo.path, relativePath);

	// Ensure parent directory exists (sync to guarantee visibility to git subprocess)
	const parentDir = path.dirname(absolutePath);
	fsSync.mkdirSync(parentDir, { recursive: true });

	// Write file (sync to guarantee visibility to git subprocess)
	fsSync.writeFileSync(absolutePath, content, "utf-8");

	// Stage file (use relative path for cross-platform compatibility)
	git(repo.path, "add", relativePath);

	// Commit with optional timestamp
	const commitMessage = message || `Add ${path.basename(relativePath)}`;

	if (timestamp) {
		const dateStr = new Date(timestamp).toISOString();
		git(repo.path, "commit", `--date=${dateStr}`, "-m", commitMessage);
	} else {
		git(repo.path, "commit", "-m", commitMessage);
	}

	return absolutePath;
}

/**
 * Delete a file and commit the deletion
 *
 * VALUE: Creates scenario for testing getDeletedFileTimestamp()
 *
 * @param repo - Git repository
 * @param relativePath - Path to file (relative to repo root)
 * @param message - Optional commit message
 */
export async function deleteAndCommitFile(
	repo: GitRepo,
	relativePath: string,
	message?: string,
): Promise<void> {
	const absolutePath = path.join(repo.path, relativePath);

	// Delete file (sync to guarantee visibility to git subprocess)
	fsSync.rmSync(absolutePath, { force: true });

	// Stage deletion (use relative path for cross-platform compatibility)
	git(repo.path, "add", relativePath);

	// Commit
	const commitMessage = message || `Delete ${path.basename(relativePath)}`;
	git(repo.path, "commit", "-m", commitMessage);
}

/**
 * Create an untracked file (not in git)
 *
 * VALUE: Tests edge case where file exists but has no git history
 *
 * @param repo - Git repository
 * @param relativePath - Path to file
 * @param content - File content
 * @returns Absolute path to created file
 */
export async function createUntrackedFile(
	repo: GitRepo,
	relativePath: string,
	content = "untracked content",
): Promise<string> {
	const absolutePath = path.join(repo.path, relativePath);

	// Ensure parent directory exists (sync for subprocess visibility)
	const parentDir = path.dirname(absolutePath);
	fsSync.mkdirSync(parentDir, { recursive: true });

	// Write file (do NOT stage or commit)
	fsSync.writeFileSync(absolutePath, content, "utf-8");

	return absolutePath;
}

/**
 * Modify a file without committing
 *
 * VALUE: Test unstaged changes
 *
 * @param repo - Git repository
 * @param options - File modification options
 */
export async function modifyFile(
	repo: GitRepo,
	options: { relativePath: string; content: string },
): Promise<void> {
	const absolutePath = path.join(repo.path, options.relativePath);
	fsSync.writeFileSync(absolutePath, options.content, "utf-8");
}

/**
 * Modify a file and commit the change
 *
 * VALUE: Creates file with multiple commits for timestamp testing
 *
 * @param repo - Git repository
 * @param relativePath - Path to existing file
 * @param newContent - New file content
 * @param message - Optional commit message
 */
export async function modifyAndCommitFile(
	repo: GitRepo,
	relativePath: string,
	newContent: string,
	message?: string,
): Promise<void> {
	const absolutePath = path.join(repo.path, relativePath);

	// Modify file (sync for subprocess visibility)
	fsSync.writeFileSync(absolutePath, newContent, "utf-8");

	// Stage and commit (use relative path for cross-platform compatibility)
	git(repo.path, "add", relativePath);

	const commitMessage = message || `Update ${path.basename(relativePath)}`;
	git(repo.path, "commit", "-m", commitMessage);
}

/**
 * Get git log timestamp for a file
 *
 * VALUE: Verification helper to ensure our tests are correct
 *
 * @param repo - Git repository
 * @param relativePath - Path to file
 * @returns Unix timestamp (seconds) or undefined if no history
 */
export async function getGitLogTimestamp(
	repo: GitRepo,
	relativePath: string,
): Promise<number | undefined> {
	try {
		const result = git(
			repo.path,
			"log",
			"-1",
			"--format=%at",
			"--",
			relativePath,
		);
		return result ? parseInt(result, 10) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Corrupt git repository (for error testing)
 *
 * VALUE: Tests graceful error handling when git is broken
 *
 * @param repo - Git repository to corrupt
 */
export async function corruptGitRepo(repo: GitRepo): Promise<void> {
	// Delete .git directory to simulate corrupted repo
	const gitDir = path.join(repo.path, ".git");
	await fs.rm(gitDir, { recursive: true, force: true });
}

/**
 * Create multiple commits with different timestamps
 *
 * VALUE: Batch helper for complex test scenarios
 *
 * @param repo - Git repository
 * @param files - Array of file configs
 * @returns Map of relativePath → absolutePath
 */
export async function commitMultipleFiles(
	repo: GitRepo,
	files: Array<{
		path: string;
		content: string;
		timestamp?: number;
	}>,
): Promise<Map<string, string>> {
	const pathMap = new Map<string, string>();

	for (const file of files) {
		const absolutePath = await commitFile(repo, {
			relativePath: file.path,
			content: file.content,
			timestamp: file.timestamp,
		});
		pathMap.set(file.path, absolutePath);
	}

	return pathMap;
}
