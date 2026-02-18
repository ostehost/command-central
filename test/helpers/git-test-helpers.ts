/**
 * Git Test Helpers
 *
 * Provides realistic Git API mocks for testing Git status grouping functionality.
 * Simulates porcelain v2 output format and common Git workflows.
 */

import type * as vscode from "vscode";

/**
 * Mock Git change for test setup
 */
export interface MockChange {
	path: string;
	xy: string; // Porcelain v2 XY status code
	status?:
		| "staged"
		| "unstaged"
		| "modified-after-staging"
		| "conflict"
		| "untracked";
	timestamp?: number;
}

/**
 * Mock Git repository
 */
export interface MockRepository {
	rootUri: vscode.Uri;
	changes: MockChange[];
	state: {
		indexChanges: MockGitChange[];
		workingTreeChanges: MockGitChange[];
		mergeChanges: MockGitChange[];
	};
}

/**
 * Mock Git change (VS Code Git API format)
 */
export interface MockGitChange {
	uri: vscode.Uri;
	status: number;
	renameUri?: vscode.Uri;
}

/**
 * Mock Git API
 *
 * Provides realistic Git repository simulation for testing.
 * Supports porcelain v2 output format and common Git workflows.
 *
 * Example:
 * ```typescript
 * const mockGit = new MockGitAPI();
 * const repo = mockGit.createRepository('/test', [
 *   { path: 'file.ts', xy: 'M ', status: 'staged' },
 *   { path: 'modified.ts', xy: 'MM', status: 'modified-after-staging' }
 * ]);
 * ```
 */
export class MockGitAPI {
	private repositories = new Map<string, MockRepository>();
	private callCount = 0;

	/**
	 * Create a mock Git repository with changes
	 *
	 * @param path - Repository root path
	 * @param changes - Initial changes in repository
	 * @returns Mock repository
	 */
	createRepository(path: string, changes: MockChange[] = []): MockRepository {
		const rootUri = this.createMockUri(path);

		const repo: MockRepository = {
			rootUri,
			changes: changes.map((c) => ({
				...c,
				timestamp: c.timestamp || Date.now(),
			})),
			state: {
				indexChanges: [],
				workingTreeChanges: [],
				mergeChanges: [],
			},
		};

		// Populate state from changes
		for (const change of repo.changes) {
			const uri = this.createMockUri(`${path}/${change.path}`);

			// Index changes (staged)
			if (change.xy[0] !== " " && change.xy[0] !== "?") {
				repo.state.indexChanges.push({
					uri,
					status: this.xyToVSCodeStatus(change.xy[0] ?? "??"),
				});
			}

			// Working tree changes (unstaged)
			if (change.xy[1] !== " ") {
				repo.state.workingTreeChanges.push({
					uri,
					status: this.xyToVSCodeStatus(change.xy[1] ?? "??"),
				});
			}

			// Merge conflicts
			if (this.isConflict(change.xy)) {
				repo.state.mergeChanges.push({
					uri,
					status: 14, // CONFLICT
				});
			}
		}

		this.repositories.set(rootUri.toString(), repo);
		return repo;
	}

	/**
	 * Add file to repository (simulate git add)
	 *
	 * @param repo - Repository
	 * @param filePath - File path relative to repo root
	 * @param xy - XY status code (default 'M ' for staged modified)
	 */
	addFile(repo: MockRepository, filePath: string, xy = "M "): void {
		const change: MockChange = {
			path: filePath,
			xy,
			status: xy === "M " ? "staged" : "unstaged",
			timestamp: Date.now(),
		};

		repo.changes.push(change);

		// Update state
		const uri = this.createMockUri(`${repo.rootUri.fsPath}/${filePath}`);
		if (xy[0] !== " ") {
			repo.state.indexChanges.push({
				uri,
				status: this.xyToVSCodeStatus(xy[0] ?? "??"),
			});
		}
	}

	/**
	 * Modify file after staging (simulate MM status)
	 *
	 * @param repo - Repository
	 * @param filePath - File path relative to repo root
	 */
	modifyFile(repo: MockRepository, filePath: string): void {
		// Find existing change
		const change = repo.changes.find((c) => c.path === filePath);
		if (!change) {
			throw new Error(`File ${filePath} not found in repository`);
		}

		// Update to MM (modified in both index and working tree)
		change.xy = "MM";
		change.status = "modified-after-staging";
		change.timestamp = Date.now();

		// Update working tree changes
		const uri = this.createMockUri(`${repo.rootUri.fsPath}/${filePath}`);
		if (
			!repo.state.workingTreeChanges.some(
				(c) => c.uri.toString() === uri.toString(),
			)
		) {
			repo.state.workingTreeChanges.push({
				uri,
				status: this.xyToVSCodeStatus("M"),
			});
		}
	}

	/**
	 * Add modified-after-staging file directly
	 *
	 * @param repo - Repository
	 * @param filePath - File path relative to repo root
	 */
	addModifiedAfterStaging(repo: MockRepository, filePath: string): void {
		// Add staged first
		this.addFile(repo, filePath, "M ");
		// Then modify
		this.modifyFile(repo, filePath);
	}

	/**
	 * Add merge conflict
	 *
	 * @param repo - Repository
	 * @param filePath - File path
	 * @param conflictType - Type of conflict (UU, AU, UA, etc.)
	 */
	addConflict(
		repo: MockRepository,
		filePath: string,
		conflictType = "UU",
	): void {
		const change: MockChange = {
			path: filePath,
			xy: conflictType,
			status: "conflict",
			timestamp: Date.now(),
		};

		repo.changes.push(change);

		// Add to merge changes
		const uri = this.createMockUri(`${repo.rootUri.fsPath}/${filePath}`);
		repo.state.mergeChanges.push({
			uri,
			status: 14, // CONFLICT
		});
	}

	/**
	 * Generate realistic porcelain v2 output
	 *
	 * @param changes - Changes to include
	 * @returns Porcelain v2 formatted output
	 */
	mockPorcelainV2Output(changes: MockChange[]): string {
		const lines: string[] = [];

		for (const change of changes) {
			if (change.xy === "??") {
				// Untracked files
				lines.push(`? ${change.path}`);
			} else if (this.isConflict(change.xy)) {
				// Unmerged entries
				// Format: u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
				lines.push(
					`u ${change.xy} N... 100644 100644 100644 100644 abc123 def456 ghi789 ${change.path}`,
				);
			} else {
				// Ordinary changed entries
				// Format: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
				lines.push(
					`1 ${change.xy} N... 100644 100644 100644 abc123 def456 ${change.path}`,
				);
			}
		}

		return lines.join("\n");
	}

	/**
	 * Get number of Git calls made
	 *
	 * For testing cache effectiveness
	 *
	 * @returns Call count
	 */
	getCallCount(): number {
		return this.callCount;
	}

	/**
	 * Reset call count
	 */
	resetCallCount(): void {
		this.callCount = 0;
	}

	/**
	 * Increment call count (simulates Git query)
	 */
	incrementCallCount(): void {
		this.callCount++;
	}

	/**
	 * Check if XY code represents a conflict
	 */
	private isConflict(xy: string): boolean {
		return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy);
	}

	/**
	 * Convert XY character to VS Code status code
	 */
	private xyToVSCodeStatus(char: string): number {
		const statusMap: Record<string, number> = {
			M: 5, // MODIFIED
			A: 1, // INDEX_ADDED
			D: 6, // DELETED
			R: 3, // INDEX_RENAMED
			C: 2, // INDEX_COPIED
			"?": 7, // UNTRACKED
			U: 14, // CONFLICT
		};
		return statusMap[char] || 0;
	}

	/**
	 * Create mock VS Code URI
	 */
	private createMockUri(path: string): vscode.Uri {
		return {
			scheme: "file",
			authority: "",
			path,
			query: "",
			fragment: "",
			fsPath: path,
			with: () => this.createMockUri(path),
			toString: () => `file://${path}`,
			toJSON: () => ({ path }),
		} as vscode.Uri;
	}
}

/**
 * Performance test helper for large repositories
 */
export class PerformanceTestHelper {
	/**
	 * Create large repository for performance testing
	 *
	 * @param fileCount - Number of files to create
	 * @returns Mock repository
	 */
	static createLargeRepository(fileCount: number): MockRepository {
		const mockGit = new MockGitAPI();
		const changes: MockChange[] = [];

		for (let i = 0; i < fileCount; i++) {
			const types = ["M ", " M", "A ", "??", "MM"];
			const randomType = types[i % types.length];

			changes.push({
				path: `src/file${i}.ts`,
				xy: randomType ?? "??",
				timestamp: Date.now() - i * 1000, // Spread over time
			});
		}

		return mockGit.createRepository("/large-repo", changes);
	}

	/**
	 * Measure async operation execution time
	 *
	 * @param operation - Async operation to measure
	 * @param maxMs - Maximum allowed time in ms
	 * @returns Measurement result
	 */
	static async measureAsync<T>(
		operation: () => Promise<T>,
		maxMs: number,
	): Promise<{ elapsed: number; passed: boolean; result: T }> {
		const start = performance.now();
		const result = await operation();
		const elapsed = performance.now() - start;
		const passed = elapsed < maxMs;

		return { elapsed, passed, result };
	}
}
