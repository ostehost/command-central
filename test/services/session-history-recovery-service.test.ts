/**
 * Tests for SessionHistoryRecoveryService — read-only audit of OpenClaw
 * session-history archive/recovery risk.
 *
 * Uses the real filesystem against a temp OpenClaw home so the scan exercises
 * the genuine `.jsonl.deleted.*` archive layout. The service must NEVER mutate
 * any session file; the "read-only" regression test asserts the tree is byte-
 * for-byte unchanged after a scan.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type * as _fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Restore real node:fs to undo mock bleed from sibling service test files.
const fs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof _fs;
mock.module("node:fs", () => fs);

const { SessionHistoryRecoveryService } = await import(
	"../../src/services/session-history-recovery-service.js"
);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function makeSessionsDir(openClawDir: string, agent: string): string {
	const dir = path.join(openClawDir, "agents", agent, "sessions");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function writeFile(filePath: string, contents: string, mtimeMs?: number): void {
	fs.writeFileSync(filePath, contents);
	if (mtimeMs !== undefined) {
		const seconds = mtimeMs / 1000;
		fs.utimesSync(filePath, seconds, seconds);
	}
}

describe("SessionHistoryRecoveryService", () => {
	let tmpDir: string;
	let openClawDir: string;

	beforeEach(() => {
		mock.module("node:fs", () => fs);
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-recovery-test-"));
		openClawDir = path.join(tmpDir, ".openclaw");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("returns an empty, zero-risk report when ~/.openclaw is missing", () => {
		const service = new SessionHistoryRecoveryService({
			openClawDir: path.join(tmpDir, "does-not-exist"),
		});
		const report = service.scan();
		expect(report.archivedTranscripts).toHaveLength(0);
		expect(report.orphanSessionFiles).toHaveLength(0);
		expect(report.atRisk).toBe(false);
		expect(report.oldestAgeDays).toBeNull();
	});

	test("counts archived .jsonl.deleted.* transcripts across agent dirs", () => {
		const sessions = makeSessionsDir(openClawDir, "coder");
		writeFile(path.join(sessions, "live-session.jsonl"), "{}\n");
		writeFile(
			path.join(sessions, "a.jsonl.deleted.2026-06-10T16-20-01.571Z"),
			"{}\n",
		);
		writeFile(
			path.join(
				sessions,
				"b.jsonl.codex-app-server.json.deleted.20260601T080003Z",
			),
			"{}\n",
		);

		const report = new SessionHistoryRecoveryService({ openClawDir }).scan();
		expect(report.archivedTranscripts).toHaveLength(2);
		// The live transcript must NOT be treated as archived.
		expect(
			report.archivedTranscripts.every((entry) =>
				entry.filePath.includes(".deleted."),
			),
		).toBe(true);
	});

	test("also scans the archive/sessions-* sweep directories", () => {
		const archive = path.join(
			openClawDir,
			"archive",
			"sessions-main-20260330-145824",
		);
		fs.mkdirSync(archive, { recursive: true });
		writeFile(
			path.join(archive, "x.jsonl.deleted.2026-03-30T05-26-53.786Z"),
			"{}\n",
		);

		const report = new SessionHistoryRecoveryService({ openClawDir }).scan();
		expect(report.archivedTranscripts).toHaveLength(1);
		expect(report.scannedRoots.some((r) => r.includes("archive"))).toBe(true);
	});

	test("flags transcripts past the retention window as prune risk (REGRESSION)", () => {
		const sessions = makeSessionsDir(openClawDir, "main");
		const now = Date.UTC(2026, 5, 23); // fixed clock
		// 40 days old → past a 30-day window.
		writeFile(
			path.join(sessions, "old.jsonl.deleted.20260514T080000Z"),
			"{}\n",
			now - 40 * MS_PER_DAY,
		);
		// 5 days old → within the window.
		writeFile(
			path.join(sessions, "fresh.jsonl.deleted.20260618T080000Z"),
			"{}\n",
			now - 5 * MS_PER_DAY,
		);

		const report = new SessionHistoryRecoveryService({
			openClawDir,
			retentionDays: 30,
			now: () => now,
		}).scan();

		expect(report.archivedTranscripts).toHaveLength(2);
		expect(report.pastRetentionCount).toBe(1);
		expect(report.atRisk).toBe(true);
		// Newest-first ordering: fresh (5d) before old (40d).
		expect(report.newestAgeDays).toBe(5);
		expect(report.oldestAgeDays).toBe(40);
	});

	test("detects orphan trajectory files with no surviving base transcript", () => {
		const sessions = makeSessionsDir(openClawDir, "coder");
		// Paired: base + trajectory → NOT an orphan.
		writeFile(path.join(sessions, "paired.jsonl"), "{}\n");
		writeFile(path.join(sessions, "paired.trajectory.jsonl"), "{}\n");
		// Trajectory without a base transcript → orphan.
		writeFile(path.join(sessions, "lonely.trajectory.jsonl"), "{}\n");

		const report = new SessionHistoryRecoveryService({ openClawDir }).scan();
		expect(report.orphanSessionFiles).toHaveLength(1);
		expect(report.orphanSessionFiles[0]?.filePath).toContain(
			"lonely.trajectory.jsonl",
		);
	});

	test("is strictly read-only: scan never mutates the session tree", () => {
		const sessions = makeSessionsDir(openClawDir, "director");
		const archivedPath = path.join(
			sessions,
			"keep.jsonl.deleted.2026-06-01T00-00-00.000Z",
		);
		writeFile(archivedPath, "important transcript bytes\n");

		const before = fs.readdirSync(sessions).sort();
		const beforeBytes = fs.readFileSync(archivedPath, "utf-8");
		const beforeMtime = fs.statSync(archivedPath).mtimeMs;

		new SessionHistoryRecoveryService({ openClawDir }).scan();

		expect(fs.readdirSync(sessions).sort()).toEqual(before);
		expect(fs.readFileSync(archivedPath, "utf-8")).toBe(beforeBytes);
		expect(fs.statSync(archivedPath).mtimeMs).toBe(beforeMtime);
	});
});
