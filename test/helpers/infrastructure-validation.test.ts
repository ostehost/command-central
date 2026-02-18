/**
 * Test Infrastructure Validation
 *
 * Validates that our test helpers and builders work correctly
 * before proceeding to Phase 1 implementation.
 */

import { describe, expect, test } from "bun:test";
import {
	GitChangeItemBuilder,
	GitStatusGroupBuilder,
	TimeGroupBuilder,
} from "../builders/tree-element-builder.js";
import { MockGitAPI } from "./git-test-helpers.js";
import { PerformanceTestHelper as PerfHelper } from "./performance-test-helper.js";

describe("Test Infrastructure Validation", () => {
	describe("MockGitAPI", () => {
		test("creates repository with changes", () => {
			const mockGit = new MockGitAPI();
			const repo = mockGit.createRepository("/test", [
				{ path: "file1.ts", xy: "M ", status: "staged" },
				{ path: "file2.ts", xy: " M", status: "unstaged" },
			]);

			expect(repo.changes).toHaveLength(2);
			expect(repo.changes[0]?.path).toBe("file1.ts");
			expect(repo.changes[0]?.xy).toBe("M ");
		});

		test("generates porcelain v2 output", () => {
			const mockGit = new MockGitAPI();
			const output = mockGit.mockPorcelainV2Output([
				{ path: "file.ts", xy: "M ", status: "staged", timestamp: Date.now() },
				{
					path: "new.ts",
					xy: "??",
					status: "untracked",
					timestamp: Date.now(),
				},
			]);

			expect(output).toContain("1 M ");
			expect(output).toContain("file.ts");
			expect(output).toContain("? new.ts");
		});

		test("simulates modified-after-staging", () => {
			const mockGit = new MockGitAPI();
			const repo = mockGit.createRepository("/test");

			// Add and stage file
			mockGit.addFile(repo, "file.ts", "M ");
			expect(repo.changes[0]?.xy).toBe("M ");

			// Modify after staging
			mockGit.modifyFile(repo, "file.ts");
			expect(repo.changes[0]?.xy).toBe("MM");
			expect(repo.changes[0]?.status).toBe("modified-after-staging");
		});

		test("tracks Git call count for cache testing", () => {
			const mockGit = new MockGitAPI();
			expect(mockGit.getCallCount()).toBe(0);

			mockGit.incrementCallCount();
			mockGit.incrementCallCount();

			expect(mockGit.getCallCount()).toBe(2);

			mockGit.resetCallCount();
			expect(mockGit.getCallCount()).toBe(0);
		});
	});

	describe("GitChangeItemBuilder", () => {
		test("builds staged file", () => {
			const file = new GitChangeItemBuilder()
				.withUri("/src/file.ts")
				.staged()
				.withTimestamp(123456)
				.build();

			expect(file.uri.fsPath).toBe("/src/file.ts");
			expect(file.isStaged).toBe(true);
			expect(file.timestamp).toBe(123456);
		});

		test("builds modified-after-staging file", () => {
			const file = new GitChangeItemBuilder()
				.withUri("/file.ts")
				.modifiedAfterStaging()
				.build();

			expect(file.status).toBe("MM");
			expect(file.isStaged).toBe(false); // Should be in unstaged
		});

		test("builds conflicted file", () => {
			const file = new GitChangeItemBuilder().conflicted("UU").build();

			expect(file.status).toBe("UU");
			expect(file.isStaged).toBe(false);
		});
	});

	describe("TimeGroupBuilder", () => {
		test("builds time group with files", () => {
			const files = [
				new GitChangeItemBuilder().withUri("/file1.ts").build(),
				new GitChangeItemBuilder().withUri("/file2.ts").build(),
			];

			const timeGroup = new TimeGroupBuilder().today().withFiles(files).build();

			expect(timeGroup.label).toBe("Today");
			expect(timeGroup.timePeriod).toBe("today");
			expect(timeGroup.children).toHaveLength(2);
			expect(timeGroup.contextValue).toBe("timeGroup");
		});
	});

	describe("GitStatusGroupBuilder", () => {
		test("builds status group with time groups", () => {
			const todayGroup = new TimeGroupBuilder()
				.today()
				.withFiles([
					new GitChangeItemBuilder().build(),
					new GitChangeItemBuilder().build(),
				])
				.build();

			const statusGroup = new GitStatusGroupBuilder()
				.staged()
				.withTimeGroups([todayGroup])
				.build();

			expect(statusGroup.label).toBe("Staged Changes");
			expect(statusGroup.statusType).toBe("staged");
			expect(statusGroup.totalCount).toBe(2);
			expect(statusGroup.contextValue).toBe("gitStatusGroup");
		});
	});

	describe("PerformanceTestHelper", () => {
		test("measures async operation", async () => {
			const operation = async () => {
				await Bun.sleep(10);
				return "result";
			};

			const { elapsed, passed, result } = await PerfHelper.measureAsync(
				operation,
				50, // 50ms target
			);

			expect(result).toBe("result");
			expect(elapsed).toBeGreaterThan(9);
			expect(elapsed).toBeLessThan(50);
			expect(passed).toBe(true);
		});

		test("detects performance failure", async () => {
			const slowOperation = async () => {
				await Bun.sleep(100);
				return "slow";
			};

			const { passed } = await PerfHelper.measureAsync(
				slowOperation,
				50, // 50ms target - will fail
			);

			expect(passed).toBe(false);
		});

		test("measures cache hit rate", async () => {
			let hits = 0;
			let misses = 0;
			let total = 0;

			const operation = async () => {
				// Simulate cache behavior
				if (total % 2 === 0) {
					misses++;
				} else {
					hits++;
				}
				total++;
			};

			const getCacheStats = () => ({ hits, misses, total });

			const stats = await PerfHelper.measureCacheHitRate(
				operation,
				10, // 10 iterations
				getCacheStats,
			);

			expect(stats.total).toBe(10);
			expect(stats.hitRate).toBeGreaterThan(0);
		});

		test("formats benchmark results", async () => {
			const result = await PerfHelper.benchmark(
				"Test Operation",
				async () => await Bun.sleep(1),
				5,
			);

			const formatted = PerfHelper.formatBenchmark(result);

			expect(formatted).toContain("Test Operation");
			expect(formatted).toContain("Iterations: 5");
			expect(result.avgMs).toBeGreaterThan(0);
		});
	});
});
