/**
 * TDD Tests for StorageAdapter Interface
 * Tests the contract that all storage implementations must follow
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { DeletedFileRecord } from "../../src/git-sort/deleted-file-tracker.js";
// Test with mock implementation (will create next)
import { MockStorageAdapter } from "../../src/git-sort/storage/mock-storage-adapter.js";
import type { StorageAdapter } from "../../src/git-sort/storage/storage-adapter.js";

describe("StorageAdapter Interface Contract", () => {
	let adapter: StorageAdapter;

	beforeEach(async () => {
		adapter = new MockStorageAdapter();
		await adapter.initialize();
	});

	describe("Lifecycle Management", () => {});

	describe("Repository Management", () => {
		test("should create new repository and return ID", async () => {
			const repoId = await adapter.ensureRepository(
				"/Users/test/project",
				"project",
			);
			expect(repoId).toBeGreaterThan(0);
		});
	});

	describe("Persistence Operations", () => {
		test("should save and load deleted file records", async () => {
			const repoId = await adapter.ensureRepository("/test/repo", "repo");

			const records: DeletedFileRecord[] = [
				{
					filePath: "/test/repo/file1.ts",
					order: 1,
					timestamp: Date.now(),
					isVisible: true,
				},
				{
					filePath: "/test/repo/file2.ts",
					order: 2,
					timestamp: Date.now(),
					isVisible: true,
				},
			];

			await adapter.save(repoId, records);
			const loaded = await adapter.load(repoId);

			expect(loaded).toHaveLength(2);
			expect(loaded[0]?.filePath).toBe("/test/repo/file1.ts");
			expect(loaded[1]?.filePath).toBe("/test/repo/file2.ts");
		});

		// Overwrite / removal semantics live in the
		// "Full-State Sync Behavior" section below.
	});

	describe("Query Operations", () => {
		beforeEach(async () => {
			// Setup test data
			const repo1 = await adapter.ensureRepository("/test/repo1", "repo1");
			const repo2 = await adapter.ensureRepository("/test/repo2", "repo2");

			const now = Date.now();
			const oneHourAgo = now - 60 * 60 * 1000;
			const oneDayAgo = now - 24 * 60 * 60 * 1000;

			await adapter.save(repo1, [
				{
					filePath: "/test/repo1/src/file1.ts",
					order: 1,
					timestamp: oneDayAgo,
					isVisible: true,
				},
				{
					filePath: "/test/repo1/test/file1.test.ts",
					order: 2,
					timestamp: oneHourAgo,
					isVisible: true,
				},
			]);

			await adapter.save(repo2, [
				{
					filePath: "/test/repo2/src/file2.ts",
					order: 1,
					timestamp: now,
					isVisible: true,
				},
			]);
		});

		test("should query files by repository path", async () => {
			const results = await adapter.queryByRepository("/test/repo1");

			expect(results).toHaveLength(2);
			expect(results[0]?.filePath).toContain("/test/repo1/");
			expect(results[1]?.filePath).toContain("/test/repo1/");
		});

		// Pattern matching removed - defer to Phase 2.4 if needed

		test("should query files by time range", async () => {
			const now = Date.now();
			const twoHoursAgo = now - 2 * 60 * 60 * 1000;

			const results = await adapter.queryByTimeRange(twoHoursAgo, now);

			expect(results).toHaveLength(2); // Last two files
			// Should be sorted by time (newest first)
			expect(results[0]?.timestamp).toBeGreaterThan(results[1]?.timestamp || 0);
		});

		test("should query recent files with limit", async () => {
			const results = await adapter.queryRecent(1);

			expect(results).toHaveLength(1);
			// Should be the most recent file
		});
	});

	describe("Maintenance Operations", () => {
		test("should create backup as binary buffer", async () => {
			const repoId = await adapter.ensureRepository("/test/repo", "repo");
			await adapter.save(repoId, [
				{
					filePath: "/test/repo/file.ts",
					order: 1,
					timestamp: Date.now(),
					isVisible: true,
				},
			]);

			const backup = await adapter.backup();

			expect(backup).toBeInstanceOf(Uint8Array);
			expect(backup.length).toBeGreaterThan(0);
		});

		test("should compact database without data loss", async () => {
			const repoId = await adapter.ensureRepository("/test/repo", "repo");
			const records: DeletedFileRecord[] = [
				{
					filePath: "/test/repo/file.ts",
					order: 1,
					timestamp: Date.now(),
					isVisible: true,
				},
			];

			await adapter.save(repoId, records);
			await adapter.compact();

			const loaded = await adapter.load(repoId);
			expect(loaded).toHaveLength(1);
		});

		test("should return accurate database statistics", async () => {
			const repo1 = await adapter.ensureRepository("/test/repo1", "repo1");
			const repo2 = await adapter.ensureRepository("/test/repo2", "repo2");

			await adapter.save(repo1, [
				{
					filePath: "/test/repo1/file1.ts",
					order: 1,
					timestamp: 1000,
					isVisible: true,
				},
				{
					filePath: "/test/repo1/file2.ts",
					order: 2,
					timestamp: 3000,
					isVisible: true,
				},
			]);

			await adapter.save(repo2, [
				{
					filePath: "/test/repo2/file3.ts",
					order: 1,
					timestamp: 2000,
					isVisible: true,
				},
			]);

			const stats = await adapter.getStats();

			expect(stats.totalRepositories).toBe(2);
			expect(stats.totalDeletions).toBe(3);
			expect(stats.oldestDeletion).toBe(1000);
			expect(stats.newestDeletion).toBe(3000);
			expect(stats.databaseSizeBytes).toBeGreaterThan(0);
		});
	});

	describe("Full-State Sync Behavior (matches save contract)", () => {
		test("should insert new record on first save", async () => {
			const repoId = await adapter.ensureRepository("/test/repo", "repo");

			await adapter.save(repoId, [
				{
					filePath: "/test/repo/file.ts",
					order: 1,
					timestamp: 1000,
					isVisible: true, // ignored during save
				},
			]);

			const loaded = await adapter.load(repoId);
			expect(loaded).toHaveLength(1);
			expect(loaded[0]?.order).toBe(1);
			expect(loaded[0]?.timestamp).toBe(1000);
		});

		test("should overwrite existing record on second save (full sync)", async () => {
			const repoId = await adapter.ensureRepository("/test/repo", "repo");

			// First save
			await adapter.save(repoId, [
				{
					filePath: "/test/repo/file.ts",
					order: 1,
					timestamp: 1000,
					isVisible: true,
				},
			]);

			// Second save with DIFFERENT data for the same path:
			// the full-sync contract replaces, it does not skip.
			await adapter.save(repoId, [
				{
					filePath: "/test/repo/file.ts",
					order: 999, // Different order
					timestamp: 9999, // Different timestamp
					isVisible: false, // Different visibility (not persisted)
				},
			]);

			const loaded = await adapter.load(repoId);
			expect(loaded).toHaveLength(1);
			expect(loaded[0]?.order).toBe(999); // New order applied
			expect(loaded[0]?.timestamp).toBe(9999); // New timestamp applied
		});

		test("should drop records absent from the new full-state set", async () => {
			const repoId = await adapter.ensureRepository("/test/repo", "repo");

			// First save - 2 files
			await adapter.save(repoId, [
				{
					filePath: "/test/repo/file1.ts",
					order: 1,
					timestamp: 1000,
					isVisible: true,
				},
				{
					filePath: "/test/repo/file2.ts",
					order: 2,
					timestamp: 2000,
					isVisible: true,
				},
			]);

			// Second save - file1 restored (gone), file2 kept, file3 added.
			// Full sync: result is exactly the records sent.
			await adapter.save(repoId, [
				{
					filePath: "/test/repo/file2.ts",
					order: 1,
					timestamp: 2000,
					isVisible: true,
				},
				{
					filePath: "/test/repo/file3.ts",
					order: 2,
					timestamp: 3000,
					isVisible: true,
				},
			]);

			const loaded = await adapter.load(repoId);
			expect(loaded).toHaveLength(2);
			expect(loaded.map((f) => f.filePath)).toEqual([
				"/test/repo/file2.ts",
				"/test/repo/file3.ts",
			]);

			// file1 was dropped (restored / absent from new state)
			expect(
				loaded.find((f) => f.filePath === "/test/repo/file1.ts"),
			).toBeUndefined();

			// file2 reflects its new order; file3 was inserted
			const file2 = loaded.find((f) => f.filePath === "/test/repo/file2.ts");
			expect(file2?.order).toBe(1);
			const file3 = loaded.find((f) => f.filePath === "/test/repo/file3.ts");
			expect(file3?.order).toBe(2);
			expect(file3?.timestamp).toBe(3000);
		});

		test("should clear all records when saving an empty set", async () => {
			const repoId = await adapter.ensureRepository("/test/repo", "repo");

			await adapter.save(repoId, [
				{
					filePath: "/test/repo/file.ts",
					order: 1,
					timestamp: 1000,
					isVisible: true,
				},
			]);

			// All tracked files restored → tracker flushes an empty set.
			await adapter.save(repoId, []);

			const loaded = await adapter.load(repoId);
			expect(loaded).toHaveLength(0);
		});

		test("should load records with default isVisible=true", async () => {
			const repoId = await adapter.ensureRepository("/test/repo", "repo");

			// Save with isVisible=false
			await adapter.save(repoId, [
				{
					filePath: "/test/repo/file.ts",
					order: 1,
					timestamp: 1000,
					isVisible: false, // This is NOT persisted
				},
			]);

			const loaded = await adapter.load(repoId);
			// Load returns default visible=true
			// Actual visibility set later by DeletedFileTracker based on git status
			expect(loaded[0]?.isVisible).toBe(true);
		});
	});

	describe("Error Handling", () => {
		test("should handle save with invalid repository ID gracefully", async () => {
			const invalidRepoId = -1;
			const records: DeletedFileRecord[] = [
				{
					filePath: "/test/file.ts",
					order: 1,
					timestamp: Date.now(),
					isVisible: true,
				},
			];

			// Should complete without throwing (saves to non-existent repo ID)
			await adapter.save(invalidRepoId, records);
			// If we get here, it didn't throw - success
			expect(true).toBe(true);
		});

		test("should handle concurrent saves atomically (full sync)", async () => {
			const repoId = await adapter.ensureRepository("/test/repo", "repo");

			// Under full-sync semantics each save replaces the prior state.
			// Concurrent full-state flushes must not tear: the final state
			// must equal exactly one of the saved sets, never a merge.
			const promises = Array.from({ length: 10 }, (_, i) =>
				adapter.save(repoId, [
					{
						filePath: `/test/repo/file${i}.ts`,
						order: i + 1,
						timestamp: Date.now(),
						isVisible: true,
					},
				]),
			);

			// Should complete without throwing
			await Promise.all(promises);

			// Each flush carried exactly one record, so the winning state
			// is a single record — not an accumulated merge of all ten.
			const loaded = await adapter.load(repoId);
			expect(loaded).toHaveLength(1);
			expect(loaded[0]?.filePath).toMatch(/^\/test\/repo\/file\d\.ts$/);
		});
	});
});
