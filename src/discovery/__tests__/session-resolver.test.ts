import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	escapeProjectPath,
	resolveClaudeSessionId,
	resolveClaudeSessionIdForTask,
	resolveClaudeTranscriptPathForTask,
} from "../session-resolver.js";

describe("escapeProjectPath", () => {
	test("replaces all slashes with dashes", () => {
		expect(escapeProjectPath("/Users/ostemini/projects/command-central")).toBe(
			"-Users-ostemini-projects-command-central",
		);
	});

	test("handles root path", () => {
		expect(escapeProjectPath("/")).toBe("-");
	});

	test("handles path with no leading slash", () => {
		expect(escapeProjectPath("relative/path")).toBe("relative-path");
	});
});

describe("resolveClaudeSessionId", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-resolver-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("returns most recent session UUID for known project", async () => {
		const projectDir = "/Users/ostemini/projects/command-central";
		const escaped = "-Users-ostemini-projects-command-central";
		const sessionsDir = path.join(tmpDir, escaped);
		fs.mkdirSync(sessionsDir, { recursive: true });

		const oldFile = path.join(sessionsDir, "old-uuid-1111.jsonl");
		const newFile = path.join(sessionsDir, "new-uuid-2222.jsonl");

		fs.writeFileSync(oldFile, "");
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(oldFile, past, past);

		fs.writeFileSync(newFile, "");

		const result = await resolveClaudeSessionId(projectDir, tmpDir);
		expect(result).toBe("new-uuid-2222");
	});

	test("returns null for unknown project", async () => {
		const result = await resolveClaudeSessionId("/nonexistent/project", tmpDir);
		expect(result).toBeNull();
	});

	test("returns null for missing base directory", async () => {
		const result = await resolveClaudeSessionId(
			"/some/project",
			path.join(tmpDir, "nonexistent"),
		);
		expect(result).toBeNull();
	});

	test("returns null for empty session directory", async () => {
		const projectDir = "/Users/ostemini/projects/empty-project";
		const escaped = "-Users-ostemini-projects-empty-project";
		const sessionsDir = path.join(tmpDir, escaped);
		fs.mkdirSync(sessionsDir, { recursive: true });

		const result = await resolveClaudeSessionId(projectDir, tmpDir);
		expect(result).toBeNull();
	});

	test("ignores non-jsonl files", async () => {
		const projectDir = "/Users/ostemini/projects/mixed-project";
		const escaped = "-Users-ostemini-projects-mixed-project";
		const sessionsDir = path.join(tmpDir, escaped);
		fs.mkdirSync(sessionsDir, { recursive: true });

		fs.writeFileSync(path.join(sessionsDir, "notes.txt"), "");
		fs.writeFileSync(path.join(sessionsDir, "abc-def-123.jsonl"), "");

		const result = await resolveClaudeSessionId(projectDir, tmpDir);
		expect(result).toBe("abc-def-123");
	});

	test("resolveClaudeSessionIdForTask prefers stored claude_session_id", async () => {
		const projectDir = "/Users/ostemini/projects/command-central";
		const escaped = escapeProjectPath(projectDir);
		const sessionsDir = path.join(tmpDir, escaped);
		fs.mkdirSync(sessionsDir, { recursive: true });

		fs.writeFileSync(path.join(sessionsDir, "first.jsonl"), "");
		fs.writeFileSync(path.join(sessionsDir, "stored.jsonl"), "");

		const result = await resolveClaudeSessionIdForTask(
			{
				project_dir: projectDir,
				started_at: "2026-04-01T10:00:00Z",
				completed_at: "2026-04-01T10:30:00Z",
				claude_session_id: "stored",
			},
			tmpDir,
		);
		expect(result).toBe("stored");
	});

	test("resolveClaudeSessionIdForTask narrows candidates to the task time window", async () => {
		const projectDir = "/Users/ostemini/projects/command-central";
		const escaped = escapeProjectPath(projectDir);
		const sessionsDir = path.join(tmpDir, escaped);
		fs.mkdirSync(sessionsDir, { recursive: true });

		const beforeTask = path.join(sessionsDir, "before-task.jsonl");
		const duringTask = path.join(sessionsDir, "during-task.jsonl");
		const afterTask = path.join(sessionsDir, "after-task.jsonl");

		fs.writeFileSync(beforeTask, "");
		fs.writeFileSync(duringTask, "");
		fs.writeFileSync(afterTask, "");

		const before = new Date("2026-04-01T09:59:00Z");
		const during = new Date("2026-04-01T10:05:00Z");
		const after = new Date("2026-04-01T10:35:00Z");
		fs.utimesSync(beforeTask, before, before);
		fs.utimesSync(duringTask, during, during);
		fs.utimesSync(afterTask, after, after);

		const result = await resolveClaudeSessionIdForTask(
			{
				project_dir: projectDir,
				started_at: "2026-04-01T10:00:00Z",
				completed_at: "2026-04-01T10:30:00Z",
				claude_session_id: null,
			},
			tmpDir,
		);
		expect(result).toBe("during-task");
	});

	test("resolveClaudeTranscriptPathForTask returns the matched transcript path", async () => {
		const projectDir = "/Users/ostemini/projects/command-central";
		const escaped = escapeProjectPath(projectDir);
		const sessionsDir = path.join(tmpDir, escaped);
		fs.mkdirSync(sessionsDir, { recursive: true });

		const transcriptPath = path.join(sessionsDir, "resume-me.jsonl");
		fs.writeFileSync(transcriptPath, "{}\n");

		const result = await resolveClaudeTranscriptPathForTask(
			{
				project_dir: projectDir,
				started_at: "2026-04-01T10:00:00Z",
				completed_at: "2026-04-01T10:30:00Z",
				claude_session_id: "resume-me",
			},
			tmpDir,
		);
		expect(result).toBe(transcriptPath);
	});
});
