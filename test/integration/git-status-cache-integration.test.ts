/**
 * Git Status Cache Integration Tests
 *
 * Tests real git operations with actual repositories.
 * Validates caching, TTL, and real git status --porcelain=v2 parsing.
 *
 * Coverage target: Lines 82-176 (queryGitStatus and getBatchStatus)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GitStatusCache } from "../../src/services/git-status-cache.js";
import { LogLevel } from "../../src/services/logger-service.js";
import type { ILoggerService } from "../../src/types/service-interfaces.js";
import {
	commitFile,
	createTempGitRepo,
	type GitRepo,
	git,
	modifyFile,
} from "../helpers/git-integration-helpers.js";

describe("GitStatusCache - Integration Tests (REAL GIT)", () => {
	let repo: GitRepo;
	let cache: GitStatusCache;
	let mockLogger: ILoggerService;

	beforeEach(async () => {
		repo = await createTempGitRepo("git-status-cache-test-");

		mockLogger = {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {},
			setLogLevel: () => {},
			getLogLevel: () => LogLevel.INFO,
		};

		// Cast to LoggerService since constructor expects class, not interface
		cache = new GitStatusCache(null, mockLogger);
	});

	afterEach(async () => {
		cache.dispose();
		await repo.cleanup();
	});

	/**
	 * Test real git status query
	 */
	test("getBatchStatus executes real git and returns status map", async () => {
		// Create some files with different statuses
		await commitFile(repo, {
			relativePath: "committed.ts",
			content: "// committed",
		});

		await modifyFile(repo, {
			relativePath: "committed.ts",
			content: "// modified",
		});

		git(repo.path, "add", "committed.ts");

		// Create unstaged file
		await modifyFile(repo, {
			relativePath: "unstaged.ts",
			content: "// unstaged",
		});

		// Create untracked file
		await modifyFile(repo, {
			relativePath: "untracked.ts",
			content: "// untracked",
		});

		// Query git status
		const mockUri = {
			scheme: "file",
			authority: "",
			path: repo.path,
			query: "",
			fragment: "",
			fsPath: repo.path,
			with: () => mockUri,
			toString: () => `file://${repo.path}`,
			toJSON: () => ({ path: repo.path }),
		};

		const statusMap = await cache.getBatchStatus(mockUri);

		// Verify results
		expect(statusMap.size).toBeGreaterThan(0);

		// committed.ts should be staged (M in index)
		const committedStatus = statusMap.get("committed.ts");
		expect(committedStatus).toBeDefined();
		expect(committedStatus?.xy[0]).toBe("M"); // Modified in index

		// untracked.ts should be untracked
		const untrackedStatus = statusMap.get("untracked.ts");
		expect(untrackedStatus).toBeDefined();
		expect(untrackedStatus?.xy).toBe("??");
	});

	/**
	 * Test caching behavior
	 */
	test("getBatchStatus caches results within TTL", async () => {
		// Create a file
		await commitFile(repo, {
			relativePath: "test.ts",
			content: "// test",
		});

		const mockUri = {
			scheme: "file",
			authority: "",
			path: repo.path,
			query: "",
			fragment: "",
			fsPath: repo.path,
			with: () => mockUri,
			toString: () => `file://${repo.path}`,
			toJSON: () => ({ path: repo.path }),
		};

		// First call - cache miss
		const metrics1 = cache.getMetrics();
		expect(metrics1.misses).toBe(0);

		const status1 = await cache.getBatchStatus(mockUri);

		const metrics2 = cache.getMetrics();
		expect(metrics2.misses).toBe(1);
		expect(metrics2.total).toBe(1);

		// Second call within TTL - cache hit
		const status2 = await cache.getBatchStatus(mockUri);

		const metrics3 = cache.getMetrics();
		expect(metrics3.hits).toBe(1);
		expect(metrics3.misses).toBe(1);
		expect(metrics3.total).toBe(2);

		// Both results should be identical
		expect(status1.size).toBe(status2.size);
	});

	/**
	 * Test cache invalidation after TTL
	 */
	test("getBatchStatus invalidates cache after TTL expires", async () => {
		// Create a file
		await commitFile(repo, {
			relativePath: "test.ts",
			content: "// test",
		});

		const mockUri = {
			scheme: "file",
			authority: "",
			path: repo.path,
			query: "",
			fragment: "",
			fsPath: repo.path,
			with: () => mockUri,
			toString: () => `file://${repo.path}`,
			toJSON: () => ({ path: repo.path }),
		};

		// First call
		await cache.getBatchStatus(mockUri);

		// Wait for TTL to expire (100ms + buffer)
		await Bun.sleep(150);

		// Second call should be cache miss
		const metricsBefore = cache.getMetrics();
		await cache.getBatchStatus(mockUri);
		const metricsAfter = cache.getMetrics();

		// Should have one more miss (cache expired)
		expect(metricsAfter.misses).toBe(metricsBefore.misses + 1);
	});

	/**
	 * Test manual cache invalidation
	 */
	test("invalidate() clears cache for repository", async () => {
		// Create a file
		await commitFile(repo, {
			relativePath: "test.ts",
			content: "// test",
		});

		const mockUri = {
			scheme: "file",
			authority: "",
			path: repo.path,
			query: "",
			fragment: "",
			fsPath: repo.path,
			with: () => mockUri,
			toString: () => `file://${repo.path}`,
			toJSON: () => ({ path: repo.path }),
		};

		// First call - populate cache
		await cache.getBatchStatus(mockUri);

		// Invalidate cache
		cache.invalidate(mockUri);

		// Next call should be cache miss
		const metricsBefore = cache.getMetrics();
		await cache.getBatchStatus(mockUri);
		const metricsAfter = cache.getMetrics();

		expect(metricsAfter.misses).toBe(metricsBefore.misses + 1);
	});

	/**
	 * Test performance target: <100ms per query
	 */
	test("getBatchStatus query completes in <100ms", async () => {
		// Create multiple files
		for (let i = 0; i < 10; i++) {
			await commitFile(repo, {
				relativePath: `file${i}.ts`,
				content: `// file ${i}`,
			});
		}

		const mockUri = {
			scheme: "file",
			authority: "",
			path: repo.path,
			query: "",
			fragment: "",
			fsPath: repo.path,
			with: () => mockUri,
			toString: () => `file://${repo.path}`,
			toJSON: () => ({ path: repo.path }),
		};

		const start = performance.now();
		await cache.getBatchStatus(mockUri);
		const elapsed = performance.now() - start;

		// Should complete in <100ms
		expect(elapsed).toBeLessThan(100);
	});

	/**
	 * Test cache hit rate target: >90%
	 */
	test("cache achieves >90% hit rate for repeated queries", async () => {
		// Create a file
		await commitFile(repo, {
			relativePath: "test.ts",
			content: "// test",
		});

		const mockUri = {
			scheme: "file",
			authority: "",
			path: repo.path,
			query: "",
			fragment: "",
			fsPath: repo.path,
			with: () => mockUri,
			toString: () => `file://${repo.path}`,
			toJSON: () => ({ path: repo.path }),
		};

		// Clear metrics
		cache.clear();

		// First query - miss
		await cache.getBatchStatus(mockUri);

		// 9 more queries within TTL - hits
		for (let i = 0; i < 9; i++) {
			await cache.getBatchStatus(mockUri);
		}

		const metrics = cache.getMetrics();

		// 1 miss + 9 hits = 10 total
		expect(metrics.total).toBe(10);
		expect(metrics.misses).toBe(1);
		expect(metrics.hits).toBe(9);

		// Hit rate = 9/10 = 90%
		const hitRate = metrics.hits / metrics.total;
		expect(hitRate).toBeGreaterThanOrEqual(0.9);
	});

	/**
	 * Test error handling - invalid repository
	 */
	test("getBatchStatus handles invalid repository gracefully", async () => {
		const invalidUri = {
			scheme: "file",
			authority: "",
			path: "/nonexistent/path",
			query: "",
			fragment: "",
			fsPath: "/nonexistent/path",
			with: () => invalidUri,
			toString: () => "file:///nonexistent/path",
			toJSON: () => ({ path: "/nonexistent/path" }),
		};

		// Should not throw, should return empty map
		const statusMap = await cache.getBatchStatus(invalidUri);

		expect(statusMap.size).toBe(0);
	});

	/**
	 * Test modified after staging (MM status)
	 */
	test("detects modified-after-staging files correctly", async () => {
		// Create and stage a file
		await commitFile(repo, {
			relativePath: "staged.ts",
			content: "// initial",
		});

		await modifyFile(repo, {
			relativePath: "staged.ts",
			content: "// modified once",
		});

		git(repo.path, "add", "staged.ts");

		// Modify again after staging
		await modifyFile(repo, {
			relativePath: "staged.ts",
			content: "// modified twice",
		});

		const mockUri = {
			scheme: "file",
			authority: "",
			path: repo.path,
			query: "",
			fragment: "",
			fsPath: repo.path,
			with: () => mockUri,
			toString: () => `file://${repo.path}`,
			toJSON: () => ({ path: repo.path }),
		};

		const statusMap = await cache.getBatchStatus(mockUri);

		const stagedStatus = statusMap.get("staged.ts");
		expect(stagedStatus).toBeDefined();

		// Should be MM (modified in index and working tree)
		if (!stagedStatus) throw new Error("stagedStatus should be defined");
		expect(stagedStatus.xy).toBe("MM");

		// Should be categorized as unstaged (per user requirement)
		const category = cache.categorizeStatus(stagedStatus);
		expect(category).toBe("unstaged");

		// Should be detected as modified-after-staging
		expect(cache.isModifiedAfterStaging(stagedStatus)).toBe(true);
	});

	/**
	 * Test parsing git status output
	 */
	test("parses git status output correctly", async () => {
		// Create committed file
		await commitFile(repo, {
			relativePath: "file1.ts",
			content: "// initial",
		});

		// Modify to create unstaged change
		await modifyFile(repo, {
			relativePath: "file1.ts",
			content: "// modified",
		});

		// Untracked
		await modifyFile(repo, {
			relativePath: "untracked.ts",
			content: "// untracked",
		});

		const mockUri = {
			scheme: "file",
			authority: "",
			path: repo.path,
			query: "",
			fragment: "",
			fsPath: repo.path,
			with: () => mockUri,
			toString: () => `file://${repo.path}`,
			toJSON: () => ({ path: repo.path }),
		};

		const statusMap = await cache.getBatchStatus(mockUri);

		// Verify parsing works
		expect(statusMap.size).toBeGreaterThan(0);

		// Untracked file exists
		const untracked = statusMap.get("untracked.ts");
		expect(untracked).toBeDefined();
		if (!untracked) throw new Error("untracked should be defined");
		expect(cache.categorizeStatus(untracked)).toBe("untracked");

		// Modified file exists
		const modified = statusMap.get("file1.ts");
		expect(modified).toBeDefined();
		if (!modified) throw new Error("modified should be defined");
		// Modified in working tree should be unstaged
		expect(cache.categorizeStatus(modified)).toBe("unstaged");
	});

	/**
	 * Test performance with many files
	 */
	test("handles repositories with many files efficiently", async () => {
		// Create and commit 50 files first
		for (let i = 0; i < 50; i++) {
			await commitFile(repo, {
				relativePath: `file${i}.ts`,
				content: `// file ${i}`,
			});
		}

		// Now modify some to create actual git status changes
		for (let i = 0; i < 10; i++) {
			await modifyFile(repo, {
				relativePath: `file${i}.ts`,
				content: `// modified file ${i}`,
			});
		}

		const mockUri = {
			scheme: "file",
			authority: "",
			path: repo.path,
			query: "",
			fragment: "",
			fsPath: repo.path,
			with: () => mockUri,
			toString: () => `file://${repo.path}`,
			toJSON: () => ({ path: repo.path }),
		};

		const start = performance.now();
		const statusMap = await cache.getBatchStatus(mockUri);
		const elapsed = performance.now() - start;

		// Should have at least 10 modified files
		expect(statusMap.size).toBeGreaterThanOrEqual(10);

		// Should still be fast (<200ms relaxed for CI)
		expect(elapsed).toBeLessThan(200);
	});
});
