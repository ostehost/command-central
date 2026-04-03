/**
 * Tests for file diff temp directory management
 *
 * Verifies:
 * - Temp dir is derived from taskId (stable per task, not random per click)
 * - Same taskId reuses the same temp dir
 * - Different taskIds produce different temp dirs
 * - Safe relative paths replace slashes to avoid nested-dir collisions
 * - Cleanup removes all tracked directories
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("file diff temp dir management", () => {
	const createdDirs: string[] = [];

	/** Mirror of the stable-dir logic in extension.ts */
	function taskTempDir(taskId: string | undefined): string {
		return path.join(
			os.tmpdir(),
			`command-central-diff-${taskId ?? "unknown"}`,
		);
	}

	/** Mirror of the safeRelPath logic in extension.ts */
	function safeRelPath(relativePath: string): string {
		return relativePath.replace(/\//g, "__");
	}

	afterEach(() => {
		for (const dir of createdDirs) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// ignore cleanup errors in tests
			}
		}
		createdDirs.length = 0;
	});

	test("same taskId yields the same temp dir path", () => {
		const dir1 = taskTempDir("task-abc");
		const dir2 = taskTempDir("task-abc");
		expect(dir1).toBe(dir2);
	});

	test("different taskIds yield different temp dirs", () => {
		const dir1 = taskTempDir("task-abc");
		const dir2 = taskTempDir("task-xyz");
		expect(dir1).not.toBe(dir2);
	});

	test("undefined taskId falls back to 'unknown'", () => {
		const dir = taskTempDir(undefined);
		expect(dir).toContain("command-central-diff-unknown");
	});

	test("temp dir path contains the taskId", () => {
		const dir = taskTempDir("my-task-123");
		expect(dir).toContain("command-central-diff-my-task-123");
	});

	test("safeRelPath replaces slashes to avoid subdirectory collisions", () => {
		expect(safeRelPath("src/utils/helper.ts")).toBe("src__utils__helper.ts");
		expect(safeRelPath("file.ts")).toBe("file.ts");
		expect(safeRelPath("a/b/c/d.ts")).toBe("a__b__c__d.ts");
	});

	test("before and after filenames are distinct for the same relative path", () => {
		const rel = safeRelPath("src/foo.ts");
		const before = `before-${rel}`;
		const after = `after-${rel}`;
		expect(before).not.toBe(after);
		expect(before).toBe("before-src__foo.ts");
		expect(after).toBe("after-src__foo.ts");
	});

	test("creating the same temp dir twice is idempotent", () => {
		const dir = taskTempDir("idempotent-task");
		createdDirs.push(dir);

		fs.mkdirSync(dir, { recursive: true });
		expect(fs.existsSync(dir)).toBe(true);

		// Second call should not throw
		fs.mkdirSync(dir, { recursive: true });
		expect(fs.existsSync(dir)).toBe(true);
	});

	test("cleanup removes a tracked temp dir", () => {
		const dir = taskTempDir("cleanup-task");
		fs.mkdirSync(dir, { recursive: true });
		expect(fs.existsSync(dir)).toBe(true);

		fs.rmSync(dir, { recursive: true, force: true });
		expect(fs.existsSync(dir)).toBe(false);
		// (no push to createdDirs — we cleaned it ourselves)
	});

	test("stale temp dir names match the cleanup prefix patterns", () => {
		const staleNew = "command-central-diff-old-task";
		const staleOld = "command-central-file-diff-XYZ123";
		const unrelated = "some-other-tool-dir";

		const shouldClean = (name: string) =>
			name.startsWith("command-central-file-diff-") ||
			name.startsWith("command-central-diff-");

		expect(shouldClean(staleNew)).toBe(true);
		expect(shouldClean(staleOld)).toBe(true);
		expect(shouldClean(unrelated)).toBe(false);
	});
});
