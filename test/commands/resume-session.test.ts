import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";

const realFs = require("node:fs") as typeof import("node:fs");
mock.module("node:fs", () => realFs);

const {
	buildResumeCommand,
	canShowResumeAction,
	resolveResumeBackend,
	resolveTaskTranscriptPath,
	supportsInteractiveResume,
} = await import("../../src/commands/resume-session.js");

function createTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "resume-task",
		status: "completed",
		project_dir: "/tmp/project",
		project_name: "project",
		session_id: "agent-project",
		bundle_path: "/Applications/Projects/project.app",
		prompt_file: "/tmp/prompt.md",
		started_at: "2026-04-01T10:00:00Z",
		attempts: 1,
		max_attempts: 1,
		...overrides,
	};
}

describe("resume-session helpers", () => {
	test("ACP backends hide resume actions", () => {
		const task = createTask({ agent_backend: "acp-shell" });
		expect(resolveResumeBackend(task)).toBe("acp");
		expect(canShowResumeAction(task)).toBe(false);
		expect(supportsInteractiveResume(task)).toBe(false);
	});

	test("codex uses codex resume --last", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "resume-session-test-"),
		);
		const task = createTask({ agent_backend: "codex" });
		try {
			expect(await buildResumeCommand(task, tmpDir)).toBe(
				"codex resume --last",
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("gemini uses gemini interactive resume", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "resume-session-test-"),
		);
		const task = createTask({ agent_backend: "gemini" });
		try {
			expect(await buildResumeCommand(task, tmpDir)).toBe(
				"gemini -p --resume latest",
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("claude prefers task-specific session ids when available", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "resume-session-test-"),
		);
		const projectDir = "/tmp/project";
		const sessionsDir = path.join(tmpDir, "-tmp-project");
		fs.mkdirSync(sessionsDir, { recursive: true });
		fs.writeFileSync(path.join(sessionsDir, "claude-task-123.jsonl"), "{}\n");

		const task = createTask({
			project_dir: projectDir,
			agent_backend: "claude",
			claude_session_id: "claude-task-123",
		});
		try {
			expect(await buildResumeCommand(task, tmpDir)).toBe(
				"claude --resume 'claude-task-123'",
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("claude falls back to --continue when no task-specific transcript exists", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "resume-session-test-"),
		);
		const task = createTask({
			project_dir: "/tmp/missing-project",
			agent_backend: "claude",
		});
		try {
			expect(await buildResumeCommand(task, tmpDir)).toBe("claude --continue");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("transcript resolution prefers Claude transcripts for Claude tasks", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "resume-session-test-"),
		);
		const projectDir = "/tmp/project";
		const sessionsDir = path.join(tmpDir, "-tmp-project");
		const streamPath = path.join(tmpDir, "claude-stream.jsonl");
		fs.mkdirSync(sessionsDir, { recursive: true });
		fs.writeFileSync(path.join(sessionsDir, "claude-task-123.jsonl"), "{}\n");
		fs.writeFileSync(streamPath, "{}\n");

		const task = createTask({
			project_dir: projectDir,
			agent_backend: "claude",
			claude_session_id: "claude-task-123",
			stream_file: streamPath,
		});
		try {
			expect(await resolveTaskTranscriptPath(task, tmpDir)).toBe(
				path.join(sessionsDir, "claude-task-123.jsonl"),
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("transcript resolution uses stream_file for codex tasks", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "resume-session-test-"),
		);
		const streamPath = path.join(tmpDir, "codex-stream.jsonl");
		fs.writeFileSync(streamPath, "{}\n");

		const task = createTask({
			agent_backend: "codex",
			stream_file: streamPath,
		});
		try {
			expect(await resolveTaskTranscriptPath(task, tmpDir)).toBe(streamPath);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
