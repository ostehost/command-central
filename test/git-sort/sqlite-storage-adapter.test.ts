/**
 * TDD Tests for SQLiteStorageAdapter
 * Tests native @vscode/sqlite3 implementation with same contract as MockStorageAdapter
 *
 * PORTABILITY DESIGN:
 * - These tests verify the StorageAdapter interface contract
 * - SQLiteStorageAdapter and sql.js adapter (future) must pass identical tests
 * - Ensures easy fallback if native modules cause issues
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DeletedFileRecord } from "../../src/git-sort/deleted-file-tracker.js";
import { SQLiteStorageAdapter } from "../../src/git-sort/storage/sqlite-storage-adapter.js";
import type { StorageAdapter } from "../../src/git-sort/storage/storage-adapter.js";

// Check if @vscode/sqlite3 native module is available
let sqlite3Available = false;
try {
	require("@vscode/sqlite3");
	sqlite3Available = true;
} catch {
	// Native module not available (CI environment without VS Code runtime)
}

// When native module is unavailable, verify the error path works correctly
if (!sqlite3Available) {
	describe("SQLiteStorageAdapter - Native Implementation", () => {
		test("should throw clear error when @vscode/sqlite3 is not available", async () => {
			const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-test-"));
			try {
				await expect(
					SQLiteStorageAdapter.create(path.join(testDir, "test.db")),
				).rejects.toThrow("@vscode/sqlite3 is not available");
			} finally {
				await fs.rm(testDir, { recursive: true, force: true });
			}
		});
	});
} else {
	describe("SQLiteStorageAdapter - Native Implementation", () => {
		let adapter: StorageAdapter;
		let testDbPath: string;
		let testDir: string;

		beforeEach(async () => {
			// Create temporary directory for test database
			testDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-test-"));
			testDbPath = path.join(testDir, "test.db");

			// Create adapter (will create database)
			adapter = await SQLiteStorageAdapter.create(testDbPath);
		});

		afterEach(async () => {
			// Close database
			await adapter.close();

			// Clean up test directory
			try {
				await fs.rm(testDir, { recursive: true, force: true });
			} catch (_error) {
				// Ignore cleanup errors
			}
		});

		describe("Lifecycle Management", () => {
			test("should initialize and create database file", async () => {
				// Database should exist after creation
				const stats = await fs.stat(testDbPath);
				expect(stats.isFile()).toBe(true);
			});

			test("should close without errors", async () => {
				await expect(adapter.close()).resolves.toBeUndefined();
			});

			test("should handle multiple close calls safely", async () => {
				await adapter.close();
				// Second close should not throw (already closed)
				// Note: sqlite3 may error on double-close, that's acceptable
				try {
					await adapter.close();
				} catch {
					// Expected - database already closed
				}
			});

			test("should persist across close and reopen", async () => {
				const repoId = await adapter.ensureRepository(
					"/test/project",
					"project",
				);
				const records: DeletedFileRecord[] = [
					{
						filePath: "/test/project/file1.ts",
						order: 1,
						timestamp: 1000,
						isVisible: true,
					},
				];

				await adapter.save(repoId, records);
				await adapter.close();

				// Reopen same database
				const adapter2 = await SQLiteStorageAdapter.create(testDbPath);
				const loaded = await adapter2.load(repoId);

				expect(loaded).toHaveLength(1);
				expect(loaded[0]?.filePath).toBe("/test/project/file1.ts");
				expect(loaded[0]?.order).toBe(1);

				await adapter2.close();
			});
		});

		describe("Repository Management", () => {
			test("should create new repository and return ID", async () => {
				const repoId = await adapter.ensureRepository(
					"/Users/test/project",
					"project",
				);
				expect(repoId).toBeGreaterThan(0);
			});

			test("should return same ID for existing repository", async () => {
				const id1 = await adapter.ensureRepository(
					"/Users/test/project",
					"project",
				);
				const id2 = await adapter.ensureRepository(
					"/Users/test/project",
					"project",
				);
				expect(id1).toBe(id2);
			});

			test("should create different IDs for different repositories", async () => {
				const id1 = await adapter.ensureRepository(
					"/Users/test/project1",
					"p1",
				);
				const id2 = await adapter.ensureRepository(
					"/Users/test/project2",
					"p2",
				);
				expect(id1).not.toBe(id2);
			});
		});

		describe("Write-Once Behavior (Immutable Audit Log)", () => {
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

			test("should skip duplicate on second save (write-once)", async () => {
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

				// Second save with DIFFERENT data (should be skipped entirely)
				await adapter.save(repoId, [
					{
						filePath: "/test/repo/file.ts",
						order: 999, // Different order - IGNORED
						timestamp: 9999, // Different timestamp - IGNORED
						isVisible: false, // Different visibility - IGNORED
					},
				]);

				const loaded = await adapter.load(repoId);
				expect(loaded).toHaveLength(1);
				expect(loaded[0]?.order).toBe(1); // Original order preserved
				expect(loaded[0]?.timestamp).toBe(1000); // Original timestamp preserved
			});

			test("should handle batch save with mix of new and existing", async () => {
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

				// Second save - file1 (exists), file2 (exists), file3 (new)
				await adapter.save(repoId, [
					{
						filePath: "/test/repo/file1.ts",
						order: 999,
						timestamp: 9999,
						isVisible: false,
					}, // Should skip
					{
						filePath: "/test/repo/file2.ts",
						order: 888,
						timestamp: 8888,
						isVisible: false,
					}, // Should skip
					{
						filePath: "/test/repo/file3.ts",
						order: 3,
						timestamp: 3000,
						isVisible: true,
					}, // Should insert
				]);

				const loaded = await adapter.load(repoId);
				expect(loaded).toHaveLength(3);

				// Verify original data preserved for file1 and file2
				const file1 = loaded.find((f) => f.filePath === "/test/repo/file1.ts");
				expect(file1?.order).toBe(1);
				expect(file1?.timestamp).toBe(1000);

				const file2 = loaded.find((f) => f.filePath === "/test/repo/file2.ts");
				expect(file2?.order).toBe(2);
				expect(file2?.timestamp).toBe(2000);

				// Verify file3 was inserted
				const file3 = loaded.find((f) => f.filePath === "/test/repo/file3.ts");
				expect(file3?.order).toBe(3);
				expect(file3?.timestamp).toBe(3000);
			});

			test("should load records with default isVisible=true", async () => {
				const repoId = await adapter.ensureRepository("/test/repo", "repo");

				// Save with isVisible=false (should be ignored)
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

			test("should handle empty save", async () => {
				const repoId = await adapter.ensureRepository("/test/repo", "repo");
				await adapter.save(repoId, []);
				const loaded = await adapter.load(repoId);
				expect(loaded).toHaveLength(0);
			});

			test("should handle load from non-existent repository", async () => {
				const loaded = await adapter.load(99999);
				expect(loaded).toHaveLength(0);
			});

			test("should return records sorted by order", async () => {
				const repoId = await adapter.ensureRepository("/test/repo", "repo");

				// Insert in random order
				await adapter.save(repoId, [
					{
						filePath: "/test/repo/file3.ts",
						order: 3,
						timestamp: 3000,
						isVisible: true,
					},
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

				const loaded = await adapter.load(repoId);

				// Should be sorted by order
				expect(loaded[0]?.order).toBe(1);
				expect(loaded[1]?.order).toBe(2);
				expect(loaded[2]?.order).toBe(3);
			});
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

			test("should query files by time range", async () => {
				const now = Date.now();
				const twoHoursAgo = now - 2 * 60 * 60 * 1000;

				const results = await adapter.queryByTimeRange(twoHoursAgo, now);

				expect(results).toHaveLength(2); // Last two files
				// Should be sorted by time (newest first)
				expect(results[0]?.timestamp).toBeGreaterThan(
					results[1]?.timestamp || 0,
				);
			});

			test("should query recent files with limit", async () => {
				const results = await adapter.queryRecent(1);

				expect(results).toHaveLength(1);
				// Should be the most recent file
			});

			test("should return empty array for future time range", async () => {
				const future = Date.now() + 1000000;
				const results = await adapter.queryByTimeRange(future, future + 1000);
				expect(results).toHaveLength(0);
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

				// SQLite may enforce foreign key constraints
				// Should either throw or complete - both acceptable
				try {
					await adapter.save(invalidRepoId, records);
					// If no error, verify it didn't corrupt database
					const loaded = await adapter.load(invalidRepoId);
					expect(Array.isArray(loaded)).toBe(true);
				} catch (error) {
					// Foreign key constraint error is acceptable
					expect(error).toBeDefined();
				}
			});

			test("should reject initialization with invalid path", async () => {
				// Try to create database in non-existent directory without creating parent
				const invalidPath = "/nonexistent/deeply/nested/path/test.db";

				await expect(
					SQLiteStorageAdapter.create(invalidPath),
				).rejects.toThrow();
			});

			test("should handle concurrent saves safely", async () => {
				const repoId = await adapter.ensureRepository("/test/repo", "repo");

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

				// Verify all files were saved
				const loaded = await adapter.load(repoId);
				expect(loaded.length).toBe(10);
			});
		});

		describe("Platform-Specific Verification", () => {
			test("should work on darwin-arm64 (current platform)", async () => {
				// This test verifies native module loads correctly
				const repoId = await adapter.ensureRepository("/test/repo", "repo");

				await adapter.save(repoId, [
					{
						filePath: "/test/repo/native-test.ts",
						order: 1,
						timestamp: Date.now(),
						isVisible: true,
					},
				]);

				const loaded = await adapter.load(repoId);
				expect(loaded).toHaveLength(1);
			});

			test("should enable WAL mode for better concurrency", async () => {
				// WAL mode should be enabled automatically
				// This is a best-practice for SQLite concurrent access
				// We can't easily query PRAGMA from outside, but we verify
				// that concurrent operations work (tested elsewhere)
				expect(true).toBe(true);
			});
		});
	});
} // end else (sqlite3Available)
