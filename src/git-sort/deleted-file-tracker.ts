/**
 * Deleted File Tracker Service
 *
 * Maintains stable ordering for deleted files across git refresh events.
 * Files that are deleted get assigned a sequential order number that persists
 * even if the file is restored and deleted again.
 *
 * Design:
 * - Each deleted file gets a unique, sequential order number
 * - Order is preserved across git refreshes
 * - Files can be hidden from view (when restored) but remain in database
 * - Hidden files retain their order if deleted again
 *
 * Storage Integration (Phase 2.3):
 * - Optional persistent storage via StorageAdapter interface
 * - Loads existing records on initialize()
 * - Debounced saves (5 second delay) on mutations
 * - Force flush on dispose()
 * - Graceful fallback to in-memory if storage fails
 */

import * as path from "node:path";
import type { LoggerService } from "../services/logger-service.js";
import type { StorageAdapter } from "./storage/storage-adapter.js";

/** Delay in milliseconds before flushing changes to disk (debounced) */
const DEBOUNCE_SAVE_MS = 5000;

export interface DeletedFileRecord {
	/** Absolute file path */
	filePath: string;
	/** Sequential order number (1-based) */
	order: number;
	/** Optional timestamp of deletion */
	timestamp?: number;
	/** Whether file should appear in view (false when restored) */
	isVisible: boolean;
}

export class DeletedFileTracker {
	/** Map of file paths to their deletion records */
	private deletedFiles: Map<string, DeletedFileRecord> = new Map();

	/** Next order number to assign */
	private nextOrder = 1;

	// Storage integration fields
	private storage?: StorageAdapter;
	private workspaceRoot?: string;
	private repoId?: number;
	private saveTimer?: NodeJS.Timeout;
	private isInitialized = false;
	private logger?: LoggerService;

	/**
	 * Creates a new DeletedFileTracker.
	 *
	 * @param options - Optional configuration
	 * @param options.storage - Storage adapter for persistence
	 * @param options.workspaceRoot - Workspace root path (required if storage provided)
	 * @param options.logger - Logger for diagnostic messages
	 */
	constructor(options?: {
		storage?: StorageAdapter;
		workspaceRoot?: string;
		logger?: LoggerService;
	}) {
		this.storage = options?.storage;
		this.workspaceRoot = options?.workspaceRoot;
		this.logger = options?.logger;
	}

	/**
	 * Initializes the tracker and loads existing records from storage if configured.
	 * Must be called before using the tracker when storage is provided.
	 *
	 * @returns Promise that resolves when initialization is complete
	 */
	async initialize(): Promise<void> {
		if (this.isInitialized) {
			return; // Already initialized
		}

		if (!this.storage || !this.workspaceRoot) {
			// No storage or workspace root - use in-memory only
			this.isInitialized = true;
			return;
		}

		try {
			// Get or create repository ID
			const repoName = path.basename(this.workspaceRoot);
			this.repoId = await this.storage.ensureRepository(
				this.workspaceRoot,
				repoName,
			);

			// Load existing records from storage
			const storedRecords = await this.storage.load(this.repoId);

			// Populate in-memory map
			for (const record of storedRecords) {
				this.deletedFiles.set(record.filePath, {
					...record,
					isVisible: true, // All loaded records start visible
				});

				// Update nextOrder to max + 1
				this.nextOrder = Math.max(this.nextOrder, record.order + 1);
			}

			this.isInitialized = true;
		} catch (error) {
			// Log error but don't fail - fallback to in-memory
			this.logger?.error(
				"Failed to initialize deleted file tracker storage:",
				error,
			);
			// Disable storage to prevent further errors
			this.storage = undefined;
			this.repoId = undefined;
			this.isInitialized = true;
		}
	}

	/**
	 * Schedules a debounced save to storage.
	 * Saves are delayed by 5 seconds to batch multiple mutations.
	 */
	private scheduleSave(): void {
		if (!this.storage || !this.repoId) {
			return; // No storage configured
		}

		// Clear existing timer
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}

		// Schedule save after debounce delay
		this.saveTimer = setTimeout(() => {
			this.flush().catch((error) => {
				this.logger?.error("Failed to save deleted files to storage:", error);
			});
		}, DEBOUNCE_SAVE_MS);
	}

	/**
	 * Forces an immediate flush of pending changes to storage.
	 * Clears any pending debounced saves.
	 */
	private async flush(): Promise<void> {
		if (!this.storage || !this.repoId) {
			return; // No storage configured
		}

		try {
			// Save all records (storage handles INSERT OR IGNORE for duplicates)
			const allRecords = Array.from(this.deletedFiles.values());
			await this.storage.save(this.repoId, allRecords);
		} catch (error) {
			this.logger?.error("Failed to flush deleted files to storage:", error);
			throw error;
		}
	}

	/**
	 * Cleans up resources and forces a final save to storage.
	 * Should be called when the tracker is no longer needed.
	 */
	async dispose(): Promise<void> {
		// Cancel pending debounced saves
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}

		// Force final flush to storage
		try {
			await this.flush();
		} catch (error) {
			this.logger?.error("Failed final flush during dispose:", error);
			// Don't throw - best effort cleanup
		}
	}

	/**
	 * Marks a file as deleted and assigns it an order number.
	 * If file was previously deleted, returns existing order and marks as visible.
	 *
	 * @param filePath - Absolute path to the deleted file
	 * @param timestamp - Optional timestamp of deletion
	 * @returns The order number assigned to this file
	 */
	markAsDeleted(filePath: string, timestamp?: number): number {
		const existing = this.deletedFiles.get(filePath);

		if (existing) {
			// File already tracked - update visibility and timestamp
			existing.isVisible = true;
			if (timestamp !== undefined) {
				existing.timestamp = timestamp;
			}
			// Schedule save to persist changes
			this.scheduleSave();
			return existing.order;
		}

		// New deleted file - assign next order
		const order = this.nextOrder++;
		this.deletedFiles.set(filePath, {
			filePath,
			order,
			timestamp,
			isVisible: true,
		});

		// Schedule save to persist new deletion
		this.scheduleSave();

		return order;
	}

	/**
	 * Gets the order number for a file.
	 *
	 * @param filePath - Absolute path to the file
	 * @returns Order number if file is tracked, undefined otherwise
	 */
	getOrder(filePath: string): number | undefined {
		return this.deletedFiles.get(filePath)?.order;
	}

	/**
	 * Checks if a file is tracked (regardless of visibility).
	 *
	 * @param filePath - Absolute path to the file
	 * @returns true if file has been deleted at least once
	 */
	hasFile(filePath: string): boolean {
		return this.deletedFiles.has(filePath);
	}

	/**
	 * Hides a file from the view (when restored) but keeps it in database.
	 * The file retains its order number and can be made visible again.
	 *
	 * @param filePath - Absolute path to the file
	 */
	hideFromView(filePath: string): void {
		const record = this.deletedFiles.get(filePath);
		if (record) {
			record.isVisible = false;
		}
	}

	/**
	 * Gets all deleted files that should be visible in the view.
	 * Returns files sorted by order number (ascending).
	 *
	 * @returns Array of visible deleted file records, sorted by order
	 */
	getVisibleDeletedFiles(): DeletedFileRecord[] {
		return Array.from(this.deletedFiles.values())
			.filter((record) => record.isVisible)
			.sort((a, b) => a.order - b.order);
	}

	/**
	 * Gets all deleted files ever tracked, including hidden ones.
	 * Returns files sorted by order number (ascending).
	 *
	 * @returns Array of all deleted file records, sorted by order
	 */
	getAllDeletedFiles(): DeletedFileRecord[] {
		return Array.from(this.deletedFiles.values()).sort(
			(a, b) => a.order - b.order,
		);
	}

	/**
	 * Clears all tracked files (useful for testing).
	 * Not typically used in production.
	 */
	clear(): void {
		this.deletedFiles.clear();
		this.nextOrder = 1;
	}

	/**
	 * Gets the total count of tracked files (including hidden).
	 *
	 * @returns Total number of files ever deleted
	 */
	getTotalCount(): number {
		return this.deletedFiles.size;
	}
}
