import { describe, expect, mock, test } from "bun:test";

const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof import("node:fs");
mock.module("node:fs", () => realFs);

import * as os from "node:os";
import * as path from "node:path";
import { canonicalizeProjectDir } from "../../src/utils/project-scope.js";

describe("canonicalizeProjectDir", () => {
	test("resolves symlinked project directories to their canonical path", () => {
		const tmpDir = realFs.mkdtempSync(
			path.join(os.tmpdir(), "project-scope-symlink-"),
		);
		const realProjectDir = path.join(tmpDir, "real-project");
		const aliasedProjectDir = path.join(tmpDir, "alias-project");
		realFs.mkdirSync(realProjectDir);
		realFs.symlinkSync(realProjectDir, aliasedProjectDir, "dir");

		try {
			expect(canonicalizeProjectDir(aliasedProjectDir)).toBe(
				realFs.realpathSync(aliasedProjectDir),
			);
		} finally {
			realFs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("normalizes tmp aliases to the same canonical path", () => {
		const tmpDir = realFs.mkdtempSync("/tmp/project-scope-tmp-");
		const resolvedTmpDir = realFs.realpathSync(tmpDir);

		try {
			expect(canonicalizeProjectDir(tmpDir)).toBe(
				canonicalizeProjectDir(resolvedTmpDir),
			);
		} finally {
			realFs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("falls back to the raw path when the directory no longer exists", () => {
		const missingDir = path.join(
			os.tmpdir(),
			`project-scope-missing-${Date.now()}`,
		);
		realFs.rmSync(missingDir, { recursive: true, force: true });

		expect(canonicalizeProjectDir(missingDir)).toBe(missingDir);
	});

	test("returns already-canonical directories unchanged", () => {
		const tmpDir = realFs.mkdtempSync(
			path.join(os.tmpdir(), "project-scope-canonical-"),
		);
		const canonicalDir = realFs.realpathSync(tmpDir);

		try {
			expect(canonicalizeProjectDir(canonicalDir)).toBe(canonicalDir);
		} finally {
			realFs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
