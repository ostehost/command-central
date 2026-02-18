/**
 * Mock Storage Adapter
 *
 * In-memory implementation of StorageAdapter for testing.
 * Provides full interface compliance without file I/O overhead.
 *
 * Design: Write-Once Audit Log
 * - Records are inserted only on first occurrence
 * - Duplicate saves are silently skipped (no updates)
 * - isVisible is NOT persisted (always returns true on load)
 */

import type { DeletedFileRecord } from "../deleted-file-tracker.js";
import type { DatabaseStats, StorageAdapter } from "./storage-adapter.js";

interface Repository {
	id: number;
	path: string;
	name: string;
	firstSeen: number;
}

export class MockStorageAdapter implements StorageAdapter {
	private repositories: Map<string, Repository> = new Map();
	private deletedFiles: Map<number, DeletedFileRecord[]> = new Map();
	private nextRepoId = 1;

	async initialize(): Promise<void> {
		// Mark as initialized (idempotent)
	}

	async close(): Promise<void> {
		// No-op for in-memory storage
	}

	async ensureRepository(repoPath: string, name: string): Promise<number> {
		const existing = this.repositories.get(repoPath);
		if (existing) {
			return existing.id;
		}

		const id = this.nextRepoId++;
		this.repositories.set(repoPath, {
			id,
			path: repoPath,
			name,
			firstSeen: Date.now(),
		});

		return id;
	}

	async save(repoId: number, records: DeletedFileRecord[]): Promise<void> {
		const existing = this.deletedFiles.get(repoId) || [];
		const existingPaths = new Set(existing.map((r) => r.filePath));

		// INSERT only NEW records (skip duplicates - write-once behavior)
		const newRecords = records.filter((r) => !existingPaths.has(r.filePath));

		if (newRecords.length > 0) {
			this.deletedFiles.set(repoId, [...existing, ...newRecords]);
		}
	}

	async load(repoId: number): Promise<DeletedFileRecord[]> {
		const records = this.deletedFiles.get(repoId) || [];

		// Return with default isVisible=true
		// Actual visibility determined by DeletedFileTracker based on git status
		return records
			.map((r) => ({
				...r,
				isVisible: true, // Always return true - visibility is runtime-only
			}))
			.sort((a, b) => a.order - b.order);
	}

	async queryByRepository(repoPath: string): Promise<DeletedFileRecord[]> {
		const repo = this.repositories.get(repoPath);
		if (!repo) {
			return [];
		}

		return this.load(repo.id);
	}

	async queryByTimeRange(
		start: number,
		end: number,
	): Promise<DeletedFileRecord[]> {
		const allRecords: DeletedFileRecord[] = [];

		// Collect all records from all repositories
		for (const records of this.deletedFiles.values()) {
			allRecords.push(...records);
		}

		// Filter by time range
		const filtered = allRecords.filter((record) => {
			const timestamp = record.timestamp || 0;
			return timestamp >= start && timestamp <= end;
		});

		// Sort by timestamp (newest first)
		return filtered
			.map((r) => ({ ...r, isVisible: true }))
			.sort((a, b) => {
				const aTime = a.timestamp || 0;
				const bTime = b.timestamp || 0;
				return bTime - aTime;
			});
	}

	async queryRecent(limit: number): Promise<DeletedFileRecord[]> {
		const allRecords: DeletedFileRecord[] = [];

		// Collect all records from all repositories
		for (const records of this.deletedFiles.values()) {
			allRecords.push(...records);
		}

		// Sort by timestamp (newest first)
		allRecords.sort((a, b) => {
			const aTime = a.timestamp || 0;
			const bTime = b.timestamp || 0;
			return bTime - aTime;
		});

		// Return top N with default visibility
		return allRecords.slice(0, limit).map((r) => ({ ...r, isVisible: true }));
	}

	async backup(): Promise<Uint8Array> {
		// Convert entire state to JSON and encode as binary
		const state = {
			repositories: Array.from(this.repositories.values()),
			deletedFiles: Array.from(this.deletedFiles.entries()),
		};

		const json = JSON.stringify(state);
		const encoder = new TextEncoder();
		return encoder.encode(json);
	}

	async compact(): Promise<void> {
		// No-op for in-memory storage (no fragmentation)
	}

	async getStats(): Promise<DatabaseStats> {
		let totalDeletions = 0;
		let oldestDeletion: number | undefined;
		let newestDeletion: number | undefined;

		// Count all deletions and find time range
		for (const records of this.deletedFiles.values()) {
			totalDeletions += records.length;

			for (const record of records) {
				if (record.timestamp) {
					if (
						oldestDeletion === undefined ||
						record.timestamp < oldestDeletion
					) {
						oldestDeletion = record.timestamp;
					}
					if (
						newestDeletion === undefined ||
						record.timestamp > newestDeletion
					) {
						newestDeletion = record.timestamp;
					}
				}
			}
		}

		// Estimate size (rough approximation)
		const jsonSize = JSON.stringify({
			repositories: Array.from(this.repositories.values()),
			deletedFiles: Array.from(this.deletedFiles.entries()),
		}).length;

		return {
			totalRepositories: this.repositories.size,
			totalDeletions,
			databaseSizeBytes: jsonSize,
			oldestDeletion,
			newestDeletion,
		};
	}
}
