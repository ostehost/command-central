/**
 * Session Resolver — transcript heuristic tests (PAR-52 / CP-10).
 *
 * Regression coverage for the timestamp fallback in
 * `selectClaudeSessionCandidateForTask`: when a task has no explicit
 * `claude_session_id`, the resolver must pick the transcript created
 * at/just after the task's `started_at`, NOT the newest later session.
 *
 * Uses real filesystem fixtures under a tmp `claudeBaseDir` (the function
 * accepts `claudeBaseDir` precisely for this) instead of mocking fs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveClaudeTranscriptPathForTask } from "../../src/discovery/session-resolver.js";

const MINUTE_MS = 60_000;

/** Claude Code escapes a project dir by replacing every `/` with `-`. */
function escapeProjectPath(projectDir: string): string {
	return projectDir.replace(/\//g, "-");
}

describe("resolveClaudeTranscriptPathForTask — task-start heuristic", () => {
	let baseDir: string;
	const projectDir = "/Users/tester/projects/demo";
	let sessionsDir: string;

	/**
	 * Write a `.jsonl` transcript whose effective createdAt (min of
	 * birthtime/mtime — see getSessionCreatedAtMs) equals `createdAtMs` by
	 * pinning mtime to that past instant.
	 */
	function writeSession(sessionId: string, createdAtMs: number): string {
		const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
		fs.writeFileSync(transcriptPath, `{"sessionId":"${sessionId}"}\n`);
		const seconds = createdAtMs / 1000;
		fs.utimesSync(transcriptPath, seconds, seconds);
		return transcriptPath;
	}

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-session-resolver-"));
		sessionsDir = path.join(baseDir, escapeProjectPath(projectDir));
		fs.mkdirSync(sessionsDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	test("picks the session created just after started_at, not the newest later one (running task)", async () => {
		const startedAtMs = Date.parse("2026-06-01T12:00:00.000Z");
		// Task-start session: created 30s after the task started.
		const taskStartPath = writeSession(
			"task-start-session",
			startedAtMs + 30_000,
		);
		// A much-later, unrelated session (e.g. a fresh Claude run hours later).
		// completed_at is absent (running task), which previously let this win.
		writeSession("much-later-session", startedAtMs + 6 * 60 * MINUTE_MS);

		const resolved = await resolveClaudeTranscriptPathForTask(
			{
				project_dir: projectDir,
				started_at: new Date(startedAtMs).toISOString(),
				completed_at: null,
				claude_session_id: null,
			},
			baseDir,
		);

		expect(resolved).toBe(taskStartPath);
	});

	test("prefers the earliest in-window session when the task has a completed_at window", async () => {
		const startedAtMs = Date.parse("2026-06-01T12:00:00.000Z");
		const completedAtMs = startedAtMs + 60 * MINUTE_MS;
		const earliestPath = writeSession("in-window-early", startedAtMs + 30_000);
		writeSession("in-window-late", startedAtMs + 45 * MINUTE_MS);

		const resolved = await resolveClaudeTranscriptPathForTask(
			{
				project_dir: projectDir,
				started_at: new Date(startedAtMs).toISOString(),
				completed_at: new Date(completedAtMs).toISOString(),
				claude_session_id: null,
			},
			baseDir,
		);

		expect(resolved).toBe(earliestPath);
	});

	test("honors an explicit claude_session_id over the timestamp heuristic", async () => {
		const startedAtMs = Date.parse("2026-06-01T12:00:00.000Z");
		writeSession("task-start-session", startedAtMs + 30_000);
		const explicitPath = writeSession(
			"explicit-session",
			startedAtMs + 6 * 60 * MINUTE_MS,
		);

		const resolved = await resolveClaudeTranscriptPathForTask(
			{
				project_dir: projectDir,
				started_at: new Date(startedAtMs).toISOString(),
				completed_at: null,
				claude_session_id: "explicit-session",
			},
			baseDir,
		);

		expect(resolved).toBe(explicitPath);
	});

	test("returns null when no transcripts exist for the project", async () => {
		const startedAtMs = Date.parse("2026-06-01T12:00:00.000Z");

		const resolved = await resolveClaudeTranscriptPathForTask(
			{
				project_dir: "/Users/tester/projects/empty",
				started_at: new Date(startedAtMs).toISOString(),
				completed_at: null,
				claude_session_id: null,
			},
			baseDir,
		);

		expect(resolved).toBeNull();
	});
});
