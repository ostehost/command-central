/**
 * Tests for WorkspaceStateStorageAdapter
 *
 * Validates the VS Code workspaceState-backed storage implementation.
 * Runs the core StorageAdapter contract to ensure compatibility,
 * plus adapter-specific tests for persistence behavior.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { DeletedFileRecord } from "../../src/git-sort/deleted-file-tracker.js";
import type { StorageAdapter } from "../../src/git-sort/storage/storage-adapter.js";
import { WorkspaceStateStorageAdapter } from "../../src/git-sort/storage/workspace-state-storage-adapter.js";

/**
 * Minimal Memento mock that behaves like VS Code's workspaceState.
 * Backs data in a plain Map — tests verify the adapter, not VS Code.
 */
function createMockMemento(): import("vscode").Memento {
	const store = new Map<string, unknown>();
	return {
		keys: () => [...store.keys()],
		get<T>(key: string, defaultValue?: T): T {
			return (store.get(key) as T) ?? (defaultValue as T);
		},
		update: mock(async (key: string, value: unknown) => {
			store.set(key, value);
		}),
	};
}

describe("WorkspaceStateStorageAdapter", () => {
	let adapter: StorageAdapter;
	let memento: ReturnType<typeof createMockMemento>;

	beforeEach(async () => {
		memento = createMockMemento();
		adapter = await WorkspaceStateStorageAdapter.create(memento);
	});

	// ─── Core Contract (same as StorageAdapter interface tests) ───

	describe("Lifecycle", () => {});

	describe("Repository Management", () => {
		test("creates new repo with incrementing IDs", async () => {
			const id1 = await adapter.ensureRepository("/project-a", "a");
			const id2 = await adapter.ensureRepository("/project-b", "b");
			expect(id1).toBe(1);
			expect(id2).toBe(2);
		});
	});

	describe("Save / Load Round-Trip", () => {
		test("saves and loads records", async () => {
			const repoId = await adapter.ensureRepository("/repo", "r");
			const records: DeletedFileRecord[] = [
				{ filePath: "/repo/a.ts", order: 1, timestamp: 1000, isVisible: true },
				{ filePath: "/repo/b.ts", order: 2, timestamp: 2000, isVisible: true },
			];

			await adapter.save(repoId, records);
			const loaded = await adapter.load(repoId);

			expect(loaded).toHaveLength(2);
			expect(loaded[0]?.filePath).toBe("/repo/a.ts");
			expect(loaded[1]?.filePath).toBe("/repo/b.ts");
		});

		test("full-state replace on save (tracker always sends complete state)", async () => {
			const repoId = await adapter.ensureRepository("/repo", "r");

			await adapter.save(repoId, [
				{ filePath: "/repo/a.ts", order: 1, timestamp: 1000, isVisible: true },
				{ filePath: "/repo/b.ts", order: 2, timestamp: 2000, isVisible: true },
			]);

			// Tracker sends updated full state (b removed, c added)
			await adapter.save(repoId, [
				{ filePath: "/repo/a.ts", order: 1, timestamp: 1000, isVisible: true },
				{ filePath: "/repo/c.ts", order: 2, timestamp: 3000, isVisible: true },
			]);

			const loaded = await adapter.load(repoId);
			expect(loaded).toHaveLength(2);
			expect(loaded.map((r) => r.filePath)).toEqual([
				"/repo/a.ts",
				"/repo/c.ts",
			]);
		});
	});

	describe("Queries", () => {
		const now = Date.now();
		const oneHourAgo = now - 3600_000;
		const oneDayAgo = now - 86400_000;

		beforeEach(async () => {
			const r1 = await adapter.ensureRepository("/repo1", "r1");
			const r2 = await adapter.ensureRepository("/repo2", "r2");

			await adapter.save(r1, [
				{
					filePath: "/repo1/old.ts",
					order: 1,
					timestamp: oneDayAgo,
					isVisible: true,
				},
				{
					filePath: "/repo1/recent.ts",
					order: 2,
					timestamp: oneHourAgo,
					isVisible: true,
				},
			]);
			await adapter.save(r2, [
				{
					filePath: "/repo2/new.ts",
					order: 1,
					timestamp: now,
					isVisible: true,
				},
			]);
		});

		test("queryByRepository returns only that repo's files", async () => {
			const results = await adapter.queryByRepository("/repo1");
			expect(results).toHaveLength(2);
			expect(results.every((r) => r.filePath.startsWith("/repo1/"))).toBe(true);
		});

		test("queryByTimeRange filters correctly", async () => {
			const twoHoursAgo = now - 7200_000;
			const results = await adapter.queryByTimeRange(twoHoursAgo, now);
			expect(results).toHaveLength(2); // oneHourAgo + now
			// Sorted newest first
			expect(results[0]!.timestamp ?? 0).toBeGreaterThanOrEqual(
				results[1]!.timestamp ?? 0,
			);
		});

		test("queryByTimeRange returns empty for future range", async () => {
			const future = now + 1_000_000;
			expect(
				await adapter.queryByTimeRange(future, future + 1000),
			).toHaveLength(0);
		});

		test("queryRecent respects limit", async () => {
			const results = await adapter.queryRecent(1);
			expect(results).toHaveLength(1);
			expect(results[0]!.timestamp).toBe(now); // Most recent
		});
	});

	describe("Stats", () => {
		test("returns accurate stats", async () => {
			const r1 = await adapter.ensureRepository("/repo1", "r1");
			const r2 = await adapter.ensureRepository("/repo2", "r2");

			await adapter.save(r1, [
				{ filePath: "/repo1/a.ts", order: 1, timestamp: 1000, isVisible: true },
				{ filePath: "/repo1/b.ts", order: 2, timestamp: 3000, isVisible: true },
			]);
			await adapter.save(r2, [
				{ filePath: "/repo2/c.ts", order: 1, timestamp: 2000, isVisible: true },
			]);

			const stats = await adapter.getStats();
			expect(stats.totalRepositories).toBe(2);
			expect(stats.totalDeletions).toBe(3);
			expect(stats.oldestDeletion).toBe(1000);
			expect(stats.newestDeletion).toBe(3000);
		});

		test("empty adapter has zero stats", async () => {
			const stats = await adapter.getStats();
			expect(stats.totalRepositories).toBe(0);
			expect(stats.totalDeletions).toBe(0);
			expect(stats.oldestDeletion).toBeUndefined();
			expect(stats.newestDeletion).toBeUndefined();
		});
	});

	describe("Backup", () => {
		test("produces non-empty binary", async () => {
			const repoId = await adapter.ensureRepository("/repo", "r");
			await adapter.save(repoId, [
				{ filePath: "/repo/a.ts", order: 1, timestamp: 1000, isVisible: true },
			]);
			const backup = await adapter.backup();
			expect(backup).toBeInstanceOf(Uint8Array);
			expect(backup.length).toBeGreaterThan(0);

			// Verify it's valid JSON
			const parsed = JSON.parse(new TextDecoder().decode(backup));
			expect(parsed.repos).toBeDefined();
		});
	});

	// ─── Persistence across instances (the whole point) ───

	describe("Persistence via Memento", () => {
		test("new adapter instance recovers state from same memento", async () => {
			// First instance writes data
			const repoId = await adapter.ensureRepository("/project", "p");
			await adapter.save(repoId, [
				{
					filePath: "/project/x.ts",
					order: 1,
					timestamp: 5000,
					isVisible: true,
				},
			]);

			// Second instance from same memento
			const adapter2 = await WorkspaceStateStorageAdapter.create(memento);
			const id2 = await adapter2.ensureRepository("/project", "p");
			expect(id2).toBe(repoId); // Same ID recovered

			const loaded = await adapter2.load(id2);
			expect(loaded).toHaveLength(1);
			expect(loaded[0]?.filePath).toBe("/project/x.ts");
		});

		test("repo ID counter survives restart", async () => {
			await adapter.ensureRepository("/a", "a"); // id=1
			await adapter.ensureRepository("/b", "b"); // id=2

			const adapter2 = await WorkspaceStateStorageAdapter.create(memento);
			const id3 = await adapter2.ensureRepository("/c", "c");
			expect(id3).toBe(3); // Continues from 3, not 1
		});
	});

	// ─── Integration: matches how DeletedFileTracker actually uses storage ───

	describe("Tracker Integration Pattern", () => {
		test("tracker pattern: full-state flush on every save", async () => {
			const repoId = await adapter.ensureRepository("/workspace", "ws");

			// Tracker detects file1 deleted
			await adapter.save(repoId, [
				{
					filePath: "/workspace/file1.ts",
					order: 1,
					timestamp: 1000,
					isVisible: true,
				},
			]);

			// Tracker detects file2 deleted, sends complete state
			await adapter.save(repoId, [
				{
					filePath: "/workspace/file1.ts",
					order: 1,
					timestamp: 1000,
					isVisible: true,
				},
				{
					filePath: "/workspace/file2.ts",
					order: 2,
					timestamp: 2000,
					isVisible: true,
				},
			]);

			// Tracker detects file1 restored (re-added), sends state without it
			await adapter.save(repoId, [
				{
					filePath: "/workspace/file2.ts",
					order: 1,
					timestamp: 2000,
					isVisible: true,
				},
			]);

			const loaded = await adapter.load(repoId);
			expect(loaded).toHaveLength(1);
			expect(loaded[0]?.filePath).toBe("/workspace/file2.ts");
		});
	});
});
