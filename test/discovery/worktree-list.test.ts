import { describe, expect, test } from "bun:test";
import { parseWorktreeListPorcelain } from "../../src/discovery/worktree-list.js";

describe("parseWorktreeListPorcelain", () => {
	test("parses branch-based worktrees", () => {
		const output = [
			"worktree /Users/test/repo",
			"HEAD 0123456789abcdef",
			"branch refs/heads/main",
			"",
			"worktree /Users/test/repo-feature-auth",
			"HEAD fedcba9876543210",
			"branch refs/heads/feature/auth",
			"",
		].join("\n");

		const entries = parseWorktreeListPorcelain(output);
		expect(entries).toHaveLength(2);
		expect(entries[0]?.path).toBe("/Users/test/repo");
		expect(entries[0]?.branch).toBe("main");
		expect(entries[1]?.path).toBe("/Users/test/repo-feature-auth");
		expect(entries[1]?.branch).toBe("feature/auth");
	});

	test("parses detached worktrees", () => {
		const output = [
			"worktree /Users/test/repo-detached",
			"HEAD abcdef0123456789",
			"detached",
			"",
		].join("\n");

		const entries = parseWorktreeListPorcelain(output);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.path).toBe("/Users/test/repo-detached");
		expect(entries[0]?.isDetached).toBe(true);
		expect(entries[0]?.branch).toBe("detached");
	});
});
