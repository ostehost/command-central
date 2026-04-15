/**
 * handoff-file-health helper unit tests (slice 4)
 *
 * Verifies the conservative fail-open contract of `checkDeclaredHandoff`:
 *  - `"absent"`  when nothing was declared (null/undefined/empty/whitespace).
 *  - `"present"` when the declared file exists as a regular file.
 *  - `"missing"` only on confirmed ENOENT or directory-at-path.
 *  - `"unknown"` for traversal rejects and any other stat error.
 *
 * Tests use real tmp dirs (via the cached real `node:fs` from preload) and
 * mock only `statSync` for the non-ENOENT error case. Mirrors the pattern
 * from test/services/review-tracker.test.ts and test/utils/tmux-pane-health.test.ts.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type * as _fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Use real node:fs cached by the preload in global-test-cleanup.ts to avoid
// bleed from other test files that mock node:fs.
const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof _fs;

// Swappable statSync. Default impl passes through to real fs. The non-ENOENT
// test reassigns via mockImplementation to simulate EACCES.
const statSyncMock = mock((...args: unknown[]) =>
	(realFs.statSync as unknown as (...a: unknown[]) => unknown)(...args),
);

mock.module("node:fs", () => ({
	...realFs,
	statSync: statSyncMock,
}));

const { checkDeclaredHandoff } = await import(
	"../../src/utils/handoff-file-health.js"
);

// Track every tmp dir created during the suite so afterAll can clean them up.
const tmpDirs: string[] = [];
function makeTmp(): string {
	const dir = realFs.mkdtempSync(path.join(os.tmpdir(), "handoff-health-"));
	tmpDirs.push(dir);
	return dir;
}

describe("checkDeclaredHandoff", () => {
	beforeEach(() => {
		// Re-register the node:fs mock (global afterEach calls mock.restore()).
		mock.module("node:fs", () => ({
			...realFs,
			statSync: statSyncMock,
		}));
		// Reset statSync to its real pass-through between tests.
		statSyncMock.mockImplementation((...args: unknown[]) =>
			(realFs.statSync as unknown as (...a: unknown[]) => unknown)(...args),
		);
	});

	afterAll(() => {
		for (const dir of tmpDirs) {
			try {
				realFs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});

	// ── 1. handoff_file=null → absent ───────────────────────────────────────
	test("handoff_file=null → absent", () => {
		const dir = makeTmp();
		expect(checkDeclaredHandoff({ project_dir: dir, handoff_file: null })).toBe(
			"absent",
		);
	});

	// ── 2. empty / whitespace strings → absent ──────────────────────────────
	test("handoff_file='' → absent", () => {
		const dir = makeTmp();
		expect(checkDeclaredHandoff({ project_dir: dir, handoff_file: "" })).toBe(
			"absent",
		);
	});

	test("handoff_file whitespace-only → absent", () => {
		const dir = makeTmp();
		expect(
			checkDeclaredHandoff({ project_dir: dir, handoff_file: "   \t\n" }),
		).toBe("absent");
	});

	// ── 3. property missing → absent ───────────────────────────────────────
	test("handoff_file undefined (property missing) → absent", () => {
		const dir = makeTmp();
		expect(checkDeclaredHandoff({ project_dir: dir })).toBe("absent");
	});

	// ── 4. relative path, file present → present ──────────────────────────
	test("relative path, file present → present", () => {
		const dir = makeTmp();
		realFs.writeFileSync(path.join(dir, "HANDOFF.md"), "# done\n");
		expect(
			checkDeclaredHandoff({ project_dir: dir, handoff_file: "HANDOFF.md" }),
		).toBe("present");
	});

	// ── 5. relative path, file missing → missing ──────────────────────────
	test("relative path, file missing → missing", () => {
		const dir = makeTmp();
		expect(
			checkDeclaredHandoff({
				project_dir: dir,
				handoff_file: "NOT-THERE.md",
			}),
		).toBe("missing");
	});

	// ── 6. absolute path, file present → present ──────────────────────────
	test("absolute path, file present → present", () => {
		const dir = makeTmp();
		const abs = path.join(dir, "report.md");
		realFs.writeFileSync(abs, "report\n");
		// project_dir is unused when path is absolute.
		expect(
			checkDeclaredHandoff({ project_dir: "/unused", handoff_file: abs }),
		).toBe("present");
	});

	// ── 7. directory at path → missing ─────────────────────────────────────
	test("path pointing at a directory → missing", () => {
		const dir = makeTmp();
		const subdir = path.join(dir, "reports-dir");
		realFs.mkdirSync(subdir);
		expect(
			checkDeclaredHandoff({
				project_dir: dir,
				handoff_file: "reports-dir",
			}),
		).toBe("missing");
	});

	// ── 8. path traversal rejected → unknown ───────────────────────────────
	test("relative path traversal '../outside.md' → unknown", () => {
		const dir = makeTmp();
		// The helper must reject by resolve+relative check BEFORE calling statSync,
		// so we don't need to create any file outside the project root.
		expect(
			checkDeclaredHandoff({
				project_dir: dir,
				handoff_file: "../outside.md",
			}),
		).toBe("unknown");
	});

	// ── 9. nested subdir file present → present ────────────────────────────
	test("nested subdir file present → present", () => {
		const dir = makeTmp();
		const nested = path.join(dir, "deep", "nested");
		realFs.mkdirSync(nested, { recursive: true });
		realFs.writeFileSync(path.join(nested, "hand.md"), "nested\n");
		expect(
			checkDeclaredHandoff({
				project_dir: dir,
				handoff_file: "deep/nested/hand.md",
			}),
		).toBe("present");
	});

	// ── 10. fresh stat each call — present → missing after delete ─────────
	test("file becomes missing after being present → stat fresh each call", () => {
		const dir = makeTmp();
		const file = path.join(dir, "vanishing.md");
		realFs.writeFileSync(file, "here\n");
		expect(
			checkDeclaredHandoff({
				project_dir: dir,
				handoff_file: "vanishing.md",
			}),
		).toBe("present");

		realFs.unlinkSync(file);
		expect(
			checkDeclaredHandoff({
				project_dir: dir,
				handoff_file: "vanishing.md",
			}),
		).toBe("missing");
	});

	// ── 11. non-ENOENT statSync throw → unknown ────────────────────────────
	test("non-ENOENT throw from statSync (e.g. EACCES) → unknown", () => {
		const dir = makeTmp();
		// A real file exists on disk, but our mocked statSync raises EACCES.
		// The helper must classify this as "unknown", NOT "missing" — an
		// unreadable-but-extant file is not the same as a confirmed absence.
		realFs.writeFileSync(path.join(dir, "h.md"), "x\n");
		statSyncMock.mockImplementation(() => {
			throw Object.assign(new Error("permission denied"), {
				code: "EACCES",
			});
		});
		expect(
			checkDeclaredHandoff({ project_dir: dir, handoff_file: "h.md" }),
		).toBe("unknown");
	});
});
