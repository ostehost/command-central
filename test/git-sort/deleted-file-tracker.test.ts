/**
 * TDD Tests for DeletedFileTracker Service
 * Tests ordering and persistence of deleted files across git refreshes
 */

import { beforeEach, describe, expect, test } from "bun:test";

// Import will fail initially - that's expected in TDD
import {
	type DeletedFileRecord,
	DeletedFileTracker,
} from "../../src/git-sort/deleted-file-tracker.js";
import {
	createMockDeletedFileRecord,
	createMockLogger,
	createMockStorageAdapter,
} from "../helpers/typed-mocks.js";

describe("DeletedFileTracker", () => {
	let tracker: DeletedFileTracker;

	beforeEach(() => {
		tracker = new DeletedFileTracker();
	});

	describe("Order Assignment", () => {
		test("should assign order 1 to first deleted file", () => {
			const order = tracker.markAsDeleted("/project/src/file1.ts");

			expect(order).toBe(1);
		});

		test("should assign sequential orders to multiple files", () => {
			const order1 = tracker.markAsDeleted("/project/src/file1.ts");
			const order2 = tracker.markAsDeleted("/project/src/file2.ts");
			const order3 = tracker.markAsDeleted("/project/src/file3.ts");

			expect(order1).toBe(1);
			expect(order2).toBe(2);
			expect(order3).toBe(3);
		});

		test("should maintain existing order across refreshes", () => {
			const firstOrder = tracker.markAsDeleted("/project/src/file1.ts");

			// Simulate git refresh - same file appears again
			const secondOrder = tracker.markAsDeleted("/project/src/file1.ts");

			expect(firstOrder).toBe(secondOrder);
			expect(secondOrder).toBe(1);
		});

		test("should assign next available order to new deleted files", () => {
			tracker.markAsDeleted("/project/src/file1.ts"); // order 1
			tracker.markAsDeleted("/project/src/file2.ts"); // order 2

			// Simulate refresh with existing + new file
			tracker.markAsDeleted("/project/src/file1.ts"); // still order 1
			const newFileOrder = tracker.markAsDeleted("/project/src/file3.ts"); // order 3

			expect(newFileOrder).toBe(3);
		});

		test("should include timestamp when provided", () => {
			const timestamp = Date.now();
			tracker.markAsDeleted("/project/src/file1.ts", timestamp);

			const files = tracker.getVisibleDeletedFiles();
			expect(files[0]?.timestamp).toBe(timestamp);
		});
	});

	describe("File Tracking", () => {
		test("should return true for tracked files", () => {
			tracker.markAsDeleted("/project/src/file1.ts");

			expect(tracker.hasFile("/project/src/file1.ts")).toBe(true);
		});

		test("should return false for untracked files", () => {
			expect(tracker.hasFile("/project/src/unknown.ts")).toBe(false);
		});

		test("should return order for tracked files", () => {
			tracker.markAsDeleted("/project/src/file1.ts");

			expect(tracker.getOrder("/project/src/file1.ts")).toBe(1);
		});

		test("should return undefined for untracked files", () => {
			expect(tracker.getOrder("/project/src/unknown.ts")).toBeUndefined();
		});
	});

	describe("Visibility Management", () => {
		test("should keep file in database when hidden from view", () => {
			tracker.markAsDeleted("/project/src/file1.ts");

			tracker.hideFromView("/project/src/file1.ts");

			// File should still exist in database
			expect(tracker.hasFile("/project/src/file1.ts")).toBe(true);
			// But not in visible list
			expect(tracker.getVisibleDeletedFiles()).toHaveLength(0);
		});

		test("should return all files including hidden ones", () => {
			tracker.markAsDeleted("/project/src/file1.ts");
			tracker.markAsDeleted("/project/src/file2.ts");
			tracker.hideFromView("/project/src/file1.ts");

			const allFiles = tracker.getAllDeletedFiles();
			const visibleFiles = tracker.getVisibleDeletedFiles();

			expect(allFiles).toHaveLength(2);
			expect(visibleFiles).toHaveLength(1);
			expect(visibleFiles[0]?.filePath).toBe("/project/src/file2.ts");
		});

		test("should mark file as visible again if deleted after being restored", () => {
			tracker.markAsDeleted("/project/src/file1.ts"); // order 1
			tracker.hideFromView("/project/src/file1.ts"); // restored

			// File deleted again - should become visible but keep same order
			const order = tracker.markAsDeleted("/project/src/file1.ts");

			expect(order).toBe(1); // Same order
			expect(tracker.getVisibleDeletedFiles()).toHaveLength(1);
		});
	});

	describe("Delete → Restore → Delete Scenario", () => {
		test("should maintain same order when file deleted again after restore", () => {
			// First deletion
			const firstOrder = tracker.markAsDeleted("/project/src/file1.ts");
			expect(firstOrder).toBe(1);

			// File restored (hidden from view)
			tracker.hideFromView("/project/src/file1.ts");
			expect(tracker.getVisibleDeletedFiles()).toHaveLength(0);

			// File deleted again
			const secondOrder = tracker.markAsDeleted("/project/src/file1.ts");

			// Should keep same order
			expect(secondOrder).toBe(1);
			expect(tracker.getVisibleDeletedFiles()).toHaveLength(1);
		});

		test("should handle complex deletion/restoration patterns", () => {
			// Delete 3 files
			tracker.markAsDeleted("/project/src/file1.ts"); // order 1
			tracker.markAsDeleted("/project/src/file2.ts"); // order 2
			tracker.markAsDeleted("/project/src/file3.ts"); // order 3

			// Restore file2
			tracker.hideFromView("/project/src/file2.ts");

			// Add new file4
			const file4Order = tracker.markAsDeleted("/project/src/file4.ts");
			expect(file4Order).toBe(4); // Next sequential order

			// Restore file2 again
			const file2Order = tracker.markAsDeleted("/project/src/file2.ts");
			expect(file2Order).toBe(2); // Original order maintained

			// Verify visible files
			const visible = tracker.getVisibleDeletedFiles();
			expect(visible).toHaveLength(4);

			// Verify orders are preserved
			const orderMap = new Map(visible.map((f) => [f.filePath, f.order]));
			expect(orderMap.get("/project/src/file1.ts")).toBe(1);
			expect(orderMap.get("/project/src/file2.ts")).toBe(2);
			expect(orderMap.get("/project/src/file3.ts")).toBe(3);
			expect(orderMap.get("/project/src/file4.ts")).toBe(4);
		});
	});

	describe("Concurrent Operations", () => {
		test("should handle multiple files marked as deleted in quick succession", () => {
			const files = [
				"/project/src/file1.ts",
				"/project/src/file2.ts",
				"/project/src/file3.ts",
				"/project/src/file4.ts",
				"/project/src/file5.ts",
			];

			// Mark all as deleted
			const orders = files.map((f) => tracker.markAsDeleted(f));

			// All should have unique sequential orders
			expect(orders).toEqual([1, 2, 3, 4, 5]);

			// All should be visible
			expect(tracker.getVisibleDeletedFiles()).toHaveLength(5);
		});

		test("should maintain order consistency across rapid refresh events", () => {
			// Initial deletion
			tracker.markAsDeleted("/project/src/file1.ts");
			tracker.markAsDeleted("/project/src/file2.ts");

			// Simulate 10 rapid refresh events (git state changes)
			for (let i = 0; i < 10; i++) {
				tracker.markAsDeleted("/project/src/file1.ts");
				tracker.markAsDeleted("/project/src/file2.ts");
			}

			// Orders should remain stable
			expect(tracker.getOrder("/project/src/file1.ts")).toBe(1);
			expect(tracker.getOrder("/project/src/file2.ts")).toBe(2);

			// Should still have exactly 2 visible files
			expect(tracker.getVisibleDeletedFiles()).toHaveLength(2);
		});
	});

	describe("Data Retrieval", () => {
		test("should return deleted files sorted by order", () => {
			// Add files in non-sequential pattern
			tracker.markAsDeleted("/project/src/file3.ts");
			tracker.markAsDeleted("/project/src/file1.ts");
			tracker.markAsDeleted("/project/src/file2.ts");

			const visible = tracker.getVisibleDeletedFiles();

			// Should be sorted by order (1, 2, 3)
			expect(visible[0]?.filePath).toBe("/project/src/file3.ts");
			expect(visible[0]?.order).toBe(1);
			expect(visible[1]?.filePath).toBe("/project/src/file1.ts");
			expect(visible[1]?.order).toBe(2);
			expect(visible[2]?.filePath).toBe("/project/src/file2.ts");
			expect(visible[2]?.order).toBe(3);
		});

		test("should return empty array when no files tracked", () => {
			expect(tracker.getVisibleDeletedFiles()).toEqual([]);
			expect(tracker.getAllDeletedFiles()).toEqual([]);
		});

		test("should include all metadata in returned records", () => {
			const timestamp = Date.now();
			tracker.markAsDeleted("/project/src/file1.ts", timestamp);

			const visible = tracker.getVisibleDeletedFiles();
			const record = visible[0];

			expect(record).toEqual({
				filePath: "/project/src/file1.ts",
				order: 1,
				timestamp,
				isVisible: true,
			});
		});
	});

	/**
	 * EXPANSION: Storage Integration
	 * Target uncovered lines 70-121, 141-143, 285-286, 295, 304-305
	 */
	describe("Storage Integration", () => {
		test("should initialize with storage and load existing records", async () => {
			// Mock storage adapter with test data
			const mockStorage = createMockStorageAdapter({
				ensureRepository: async () => 1,
				load: async () => [
					createMockDeletedFileRecord("/test/file1.ts", 1, { timestamp: 1000 }),
					createMockDeletedFileRecord("/test/file2.ts", 2, { timestamp: 2000 }),
				],
			});

			const trackerWithStorage = new DeletedFileTracker({
				storage: mockStorage,
				workspaceRoot: "/test/workspace",
			});

			await trackerWithStorage.initialize();

			// Should load existing records
			expect(trackerWithStorage.hasFile("/test/file1.ts")).toBe(true);
			expect(trackerWithStorage.hasFile("/test/file2.ts")).toBe(true);
			expect(trackerWithStorage.getOrder("/test/file1.ts")).toBe(1);
			expect(trackerWithStorage.getOrder("/test/file2.ts")).toBe(2);

			// Next order should be 3
			const newOrder = trackerWithStorage.markAsDeleted("/test/file3.ts");
			expect(newOrder).toBe(3);
		});

		test("should handle initialize without storage (in-memory mode)", async () => {
			const trackerNoStorage = new DeletedFileTracker();

			await trackerNoStorage.initialize();

			// Should work in memory
			const order = trackerNoStorage.markAsDeleted("/test/file.ts");
			expect(order).toBe(1);
		});

		test("should handle storage initialization errors gracefully", async () => {
			const mockStorage = createMockStorageAdapter({
				ensureRepository: async () => {
					throw new Error("Storage unavailable");
				},
			});

			const mockLogger = createMockLogger();

			const trackerWithFailingStorage = new DeletedFileTracker({
				storage: mockStorage,
				workspaceRoot: "/test/workspace",
				logger: mockLogger,
			});

			// Should not throw
			await trackerWithFailingStorage.initialize();

			// Should fall back to in-memory mode
			const order = trackerWithFailingStorage.markAsDeleted("/test/file.ts");
			expect(order).toBe(1);
		});

		test("should not re-initialize if already initialized", async () => {
			let ensureRepoCallCount = 0;
			const mockStorage = createMockStorageAdapter({
				ensureRepository: async () => {
					ensureRepoCallCount++;
					return 1;
				},
			});

			const trackerWithStorage = new DeletedFileTracker({
				storage: mockStorage,
				workspaceRoot: "/test/workspace",
			});

			await trackerWithStorage.initialize();
			await trackerWithStorage.initialize();
			await trackerWithStorage.initialize();

			// Should only initialize once
			expect(ensureRepoCallCount).toBe(1);
		});

		test("should flush immediately on dispose", async () => {
			let saveCallCount = 0;
			const mockStorage = createMockStorageAdapter({
				ensureRepository: async () => 1,
				save: async () => {
					saveCallCount++;
				},
			});

			const trackerWithStorage = new DeletedFileTracker({
				storage: mockStorage,
				workspaceRoot: "/test/workspace",
			});

			await trackerWithStorage.initialize();

			trackerWithStorage.markAsDeleted("/test/file1.ts");

			// Dispose should flush immediately (no 5 second wait)
			await trackerWithStorage.dispose();

			// Save should have been called
			expect(saveCallCount).toBe(1);
		});

		test("should handle flush errors during dispose gracefully", async () => {
			const mockStorage = createMockStorageAdapter({
				ensureRepository: async () => 1,
				save: async () => {
					throw new Error("Flush failed");
				},
			});

			const mockLogger = createMockLogger();

			const trackerWithStorage = new DeletedFileTracker({
				storage: mockStorage,
				workspaceRoot: "/test/workspace",
				logger: mockLogger,
			});

			await trackerWithStorage.initialize();

			trackerWithStorage.markAsDeleted("/test/file1.ts");

			// Should not throw
			await trackerWithStorage.dispose();
			expect(true).toBe(true);
		});

		test("should persist timestamp updates for existing files", async () => {
			let savedRecords: DeletedFileRecord[] = [];
			const mockStorage = createMockStorageAdapter({
				ensureRepository: async () => 1,
				load: async () => [
					createMockDeletedFileRecord("/test/file1.ts", 1, { timestamp: 1000 }),
				],
				save: async (_repoId: number, records: DeletedFileRecord[]) => {
					savedRecords = records;
				},
			});

			const trackerWithStorage = new DeletedFileTracker({
				storage: mockStorage,
				workspaceRoot: "/test/workspace",
			});

			await trackerWithStorage.initialize();

			// Update timestamp on existing file
			trackerWithStorage.markAsDeleted("/test/file1.ts", 5000);

			// Force flush
			await trackerWithStorage.dispose();

			// Should save updated timestamp
			const record = savedRecords.find((r) => r.filePath === "/test/file1.ts");
			expect(record?.timestamp).toBe(5000);
		});
	});

	/**
	 * EXPANSION: Additional Coverage
	 */
	describe("Additional Methods", () => {
		test("should clear all tracked files", () => {
			tracker.markAsDeleted("/test/file1.ts");
			tracker.markAsDeleted("/test/file2.ts");

			expect(tracker.getTotalCount()).toBe(2);

			tracker.clear();

			expect(tracker.getTotalCount()).toBe(0);
			expect(tracker.getVisibleDeletedFiles()).toHaveLength(0);
		});

		test("should return total count including hidden files", () => {
			tracker.markAsDeleted("/test/file1.ts");
			tracker.markAsDeleted("/test/file2.ts");
			tracker.markAsDeleted("/test/file3.ts");

			tracker.hideFromView("/test/file2.ts");

			// Total count includes hidden
			expect(tracker.getTotalCount()).toBe(3);
			// Visible excludes hidden
			expect(tracker.getVisibleDeletedFiles()).toHaveLength(2);
		});
	});
});
