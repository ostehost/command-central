/**
 * Git Status Cache
 *
 * Performance layer for Git status queries using batch operations with caching.
 *
 * Performance targets (validated by tests):
 * - <100ms per query
 * - >90% cache hit rate
 * - 100ms TTL
 */

import { spawn } from "node:child_process";
import type { ILoggerService } from "../types/service-interfaces.js";

// Mock Uri type for compatibility
export interface Uri {
	scheme: string;
	authority: string;
	path: string;
	query: string;
	fragment: string;
	fsPath: string;
	with(change: Record<string, unknown>): Uri;
	toString(): string;
	toJSON(): Record<string, unknown>;
}

/**
 * Git file status from porcelain v2
 */
export interface GitFileStatus {
	path: string;
	xy: string; // XY status code (e.g., 'M ', ' M', 'MM', '??', 'UU')
	origPath?: string; // For renames/copies
	score?: number; // Rename/copy similarity
}

/**
 * Cache entry
 */
interface CacheEntry {
	statusMap: Map<string, GitFileStatus>;
	timestamp: number;
}

/**
 * Cache metrics
 */
interface CacheMetrics {
	hits: number;
	misses: number;
	total: number;
}

/**
 * Git Status Cache
 *
 * Provides fast, cached access to Git status using batch operations.
 *
 * Example:
 * ```typescript
 * const cache = new GitStatusCache(gitApi, logger);
 * const statusMap = await cache.getBatchStatus(repoUri);
 *
 * if (cache.isModifiedAfterStaging(statusMap.get('file.ts'))) {
 *   // File modified after staging → appears in unstaged only
 * }
 * ```
 */
export class GitStatusCache {
	private cache = new Map<string, CacheEntry>();
	private readonly TTL_MS = 100; // 100ms cache TTL

	private metrics: CacheMetrics = {
		hits: 0,
		misses: 0,
		total: 0,
	};

	constructor(
		_gitApi: unknown, // VS Code Git API (unused for now, direct spawn)
		private logger: ILoggerService,
	) {}

	/**
	 * Get batch status for all files in repository
	 *
	 * Uses caching with 100ms TTL for performance.
	 * Single git status --porcelain=v2 call per repository.
	 *
	 * @param repoUri - Repository root URI
	 * @returns Map of file path to status
	 */
	async getBatchStatus(repoUri: Uri): Promise<Map<string, GitFileStatus>> {
		const start = performance.now();
		const key = repoUri.toString();

		// Check cache
		const cached = this.cache.get(key);
		if (cached && Date.now() - cached.timestamp < this.TTL_MS) {
			this.metrics.hits++;
			this.metrics.total++;
			this.logger.debug(
				`Cache hit for ${repoUri.fsPath} (${(performance.now() - start).toFixed(2)}ms)`,
			);
			return cached.statusMap;
		}

		// Cache miss - query Git
		this.metrics.misses++;
		this.metrics.total++;

		try {
			const statusMap = await this.queryGitStatus(repoUri);

			// Cache result
			this.cache.set(key, {
				statusMap,
				timestamp: Date.now(),
			});

			const elapsed = performance.now() - start;
			this.logger.debug(
				`Git status query: ${statusMap.size} files in ${elapsed.toFixed(2)}ms`,
			);

			return statusMap;
		} catch (error) {
			this.logger.error("Failed to query Git status", error as Error);
			return new Map();
		}
	}

	/**
	 * Query Git status using porcelain v2 format
	 *
	 * @param repoUri - Repository root URI
	 * @returns Map of file path to status
	 */
	private async queryGitStatus(
		repoUri: Uri,
	): Promise<Map<string, GitFileStatus>> {
		return new Promise((resolve, reject) => {
			const proc = spawn("git", [
				"-C",
				repoUri.fsPath,
				"status",
				"--porcelain=v2",
				"--untracked-files=all",
			]);

			const stdoutChunks: Buffer[] = [];
			const stderrChunks: Buffer[] = [];

			proc.stdout.on("data", (chunk: Buffer) => {
				stdoutChunks.push(chunk);
			});

			proc.stderr.on("data", (chunk: Buffer) => {
				stderrChunks.push(chunk);
			});

			proc.on("close", (exitCode) => {
				if (exitCode !== 0) {
					const error = Buffer.concat(stderrChunks).toString("utf-8");
					reject(new Error(`Git status failed: ${error}`));
					return;
				}

				const output = Buffer.concat(stdoutChunks).toString("utf-8");
				resolve(this.parseGitStatusV2(output));
			});

			proc.on("error", (error) => {
				reject(error);
			});
		});
	}

	/**
	 * Parse git status --porcelain=v2 output
	 *
	 * Made public for testing - Git porcelain v2 parsing is complex enough
	 * to warrant direct unit testing (4 entry types, various edge cases)
	 *
	 * Format: https://git-scm.com/docs/git-status#_porcelain_format_version_2
	 *
	 * @param output - Raw git status output
	 * @returns Map of file path to status
	 */
	public parseGitStatusV2(output: string): Map<string, GitFileStatus> {
		const statusMap = new Map<string, GitFileStatus>();

		for (const line of output.split("\n")) {
			if (!line) continue;

			const type = line[0];

			if (type === "1") {
				// Ordinary changed entries
				// Format: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
				const parts = line.split(" ");
				const xy = parts[1];
				if (!xy) continue;
				const path = parts.slice(8).join(" ");

				statusMap.set(path, { path, xy });
			} else if (type === "2") {
				// Renamed/copied entries
				// Format: 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path><sep><origPath>
				const parts = line.split(" ");
				const xy = parts[1];
				const scoreStr = parts[8];
				if (!xy || !scoreStr) continue;
				const score = Number.parseInt(scoreStr.slice(1), 10);
				const pathPart = parts.slice(9).join(" ");
				const [path, origPath] = pathPart.split("\t");
				if (!path) continue;

				statusMap.set(path, { path, xy, origPath, score });
			} else if (type === "u") {
				// Unmerged entries (conflicts)
				// Format: u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
				const parts = line.split(" ");
				const xy = parts[1];
				if (!xy) continue;
				const path = parts.slice(10).join(" ");

				statusMap.set(path, { path, xy });
			} else if (type === "?") {
				// Untracked entries
				// Format: ? <path>
				const path = line.slice(2);
				statusMap.set(path, { path, xy: "??" });
			} else if (type === "!") {
			}
		}

		return statusMap;
	}

	/**
	 * Check if file is modified after staging
	 *
	 * Detection: XY = 'MM' (modified in both index and working tree)
	 *
	 * User requirement: MM files should appear in unstaged only
	 *
	 * @param status - Git file status
	 * @returns true if modified after staging
	 */
	isModifiedAfterStaging(status: GitFileStatus): boolean {
		return status.xy === "MM";
	}

	/**
	 * Categorize file status
	 *
	 * Categories:
	 * - staged: X != ' ' and Y == ' '
	 * - unstaged: Y != ' ' (including MM)
	 * - conflict: XY in ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']
	 * - untracked: XY == '??'
	 *
	 * @param status - Git file status
	 * @returns Category
	 */
	categorizeStatus(
		status: GitFileStatus,
	): "staged" | "unstaged" | "conflict" | "untracked" {
		const xy = status.xy;

		// Conflicts
		if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) {
			return "conflict";
		}

		// Untracked
		if (xy === "??") {
			return "untracked";
		}

		// Modified after staging (MM) → unstaged
		if (xy === "MM") {
			return "unstaged";
		}

		// Staged (index changed, working tree clean)
		const X = xy[0];
		const Y = xy[1];
		if (X !== " " && X !== "." && Y === " ") {
			return "staged";
		}

		// Unstaged (working tree changed)
		return "unstaged";
	}

	/**
	 * Invalidate cache for repository
	 *
	 * Call when Git events indicate changes.
	 *
	 * @param repoUri - Repository root URI
	 */
	invalidate(repoUri: Uri): void {
		const key = repoUri.toString();
		this.cache.delete(key);
		this.logger.debug(`Cache invalidated for ${repoUri.fsPath}`);
	}

	/**
	 * Get cache metrics
	 *
	 * For monitoring and performance analysis.
	 *
	 * @returns Cache metrics
	 */
	getMetrics(): CacheMetrics {
		return { ...this.metrics };
	}

	/**
	 * Clear all cache and reset metrics
	 */
	clear(): void {
		this.cache.clear();
		this.metrics = { hits: 0, misses: 0, total: 0 };
	}

	/**
	 * Dispose resources
	 */
	dispose(): void {
		this.clear();
	}
}
