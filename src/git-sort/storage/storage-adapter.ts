/**
 * Storage Adapter Interface
 *
 * Defines the contract for persistent storage of deleted file tracking data.
 * Implementations can use different backends (SQLite, IndexedDB, JSON files, etc.)
 * while maintaining a consistent API.
 */

import type { DeletedFileRecord } from "../deleted-file-tracker.js";

/**
 * Database statistics for monitoring and maintenance
 */
export interface DatabaseStats {
	/** Total number of repositories tracked */
	totalRepositories: number;
	/** Total number of file deletions across all repositories */
	totalDeletions: number;
	/** Database size in bytes */
	databaseSizeBytes: number;
	/** Unix timestamp of oldest deletion (undefined if no deletions) */
	oldestDeletion?: number;
	/** Unix timestamp of newest deletion (undefined if no deletions) */
	newestDeletion?: number;
}

/**
 * Storage adapter interface for persistent deleted file tracking
 */
export interface StorageAdapter {
	/**
	 * Initialize the storage backend.
	 * Called once during extension activation.
	 *
	 * @throws Error if initialization fails (database corruption, permissions, etc.)
	 */
	initialize(): Promise<void>;

	/**
	 * Close the storage backend and flush any pending writes.
	 * Called during extension deactivation.
	 */
	close(): Promise<void>;

	/**
	 * Ensure a repository exists in the database.
	 * Creates a new repository if it doesn't exist, or returns existing ID.
	 *
	 * @param path - Absolute path to repository (/Users/jane/project)
	 * @param name - Display name of repository (project)
	 * @returns Repository ID (auto-incremented integer)
	 */
	ensureRepository(path: string, name: string): Promise<number>;

	/**
	 * Save deleted file records for a repository.
	 * Replaces all existing records for this repository (full sync).
	 *
	 * @param repoId - Repository ID from ensureRepository()
	 * @param records - Array of deleted file records to persist
	 */
	save(repoId: number, records: DeletedFileRecord[]): Promise<void>;

	/**
	 * Load all deleted file records for a repository.
	 *
	 * @param repoId - Repository ID
	 * @returns Array of deleted file records, sorted by order
	 */
	load(repoId: number): Promise<DeletedFileRecord[]>;

	/**
	 * Query deleted files by repository path.
	 *
	 * @param repoPath - Absolute path to repository
	 * @returns Array of deleted file records from this repository
	 */
	queryByRepository(repoPath: string): Promise<DeletedFileRecord[]>;

	/**
	 * Query deleted files within a time range.
	 *
	 * @param start - Start timestamp (Unix milliseconds, inclusive)
	 * @param end - End timestamp (Unix milliseconds, inclusive)
	 * @returns Array of deleted file records, sorted by timestamp (newest first)
	 */
	queryByTimeRange(start: number, end: number): Promise<DeletedFileRecord[]>;

	/**
	 * Query most recent deleted files across all repositories.
	 *
	 * @param limit - Maximum number of records to return
	 * @returns Array of most recent deletions, sorted newest first
	 */
	queryRecent(limit: number): Promise<DeletedFileRecord[]>;

	/**
	 * Create a binary backup of the entire database.
	 * Can be used for manual backups or export functionality.
	 *
	 * @returns Database as binary buffer (can be saved to file)
	 */
	backup(): Promise<Uint8Array>;

	/**
	 * Compact the database to reclaim space.
	 * Equivalent to SQLite's VACUUM operation.
	 */
	compact(): Promise<void>;

	/**
	 * Get database statistics for monitoring and diagnostics.
	 *
	 * @returns Current database statistics
	 */
	getStats(): Promise<DatabaseStats>;
}
