import { beforeAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";

// Use the cached reference saved by the preload (global-test-cleanup.ts)
// because require("node:fs") would return the already-mocked version.
const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof fs;
let buildResumeCommand: typeof import("../../src/commands/resume-session.js")["buildResumeCommand"];
let canShowResumeAction: typeof import("../../src/commands/resume-session.js")["canShowResumeAction"];
let isProjectBundleAvailable: typeof import("../../src/commands/resume-session.js")["isProjectBundleAvailable"];
let resolveProjectBundlePath: typeof import("../../src/commands/resume-session.js")["resolveProjectBundlePath"];
let resolveResumeBackend: typeof import("../../src/commands/resume-session.js")["resolveResumeBackend"];
let resolveTaskTranscriptPath: typeof import("../../src/commands/resume-session.js")["resolveTaskTranscriptPath"];
let supportsInteractiveResume: typeof import("../../src/commands/resume-session.js")["supportsInteractiveResume"];

beforeAll(async () => {
	mock.module("node:fs", () => realFs);
	({
		buildResumeCommand,
		canShowResumeAction,
		isProjectBundleAvailable,
		resolveProjectBundlePath,
		resolveResumeBackend,
		resolveTaskTranscriptPath,
		supportsInteractiveResume,
	} = await import("../../src/commands/resume-session.js"));
});

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

describe("project bundle availability", () => {
	test("resolveProjectBundlePath returns explicit bundle_path when it exists on disk", () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "resume-bundle-test-"),
		);
		const fakeBundlePath = path.join(tmpDir, "my-project.app");
		fs.mkdirSync(fakeBundlePath);
		try {
			const task = createTask({ bundle_path: fakeBundlePath });
			expect(resolveProjectBundlePath(task)).toBe(fakeBundlePath);
			expect(isProjectBundleAvailable(task)).toBe(true);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("resolveProjectBundlePath ignores sentinel bundle_path values", () => {
		const task = createTask({ bundle_path: "(test-mode)" });
		expect(resolveProjectBundlePath(task)).toBeNull();
		expect(isProjectBundleAvailable(task)).toBe(false);
	});

	test("resolveProjectBundlePath returns null for missing explicit bundle", () => {
		const task = createTask({
			bundle_path: "/nonexistent/path/to/bundle.app",
		});
		expect(resolveProjectBundlePath(task)).toBeNull();
		expect(isProjectBundleAvailable(task)).toBe(false);
	});

	test("resolveProjectBundlePath falls back to /Applications/Projects convention", () => {
		// This test verifies the convention path logic without requiring the
		// actual /Applications/Projects directory. It checks the null fallback.
		const task = createTask({
			project_dir: "/tmp/unlikely-project-name-abc123",
			bundle_path: "(tmux-mode)",
		});
		// Unless /Applications/Projects/unlikely-project-name-abc123.app exists,
		// this should return null.
		expect(resolveProjectBundlePath(task)).toBeNull();
		expect(isProjectBundleAvailable(task)).toBe(false);
	});
});

describe("dead-session resume decision logic", () => {
	test("completed claude task is resumable", () => {
		const task = createTask({
			status: "completed",
			agent_backend: "claude",
		});
		expect(canShowResumeAction(task)).toBe(true);
		expect(supportsInteractiveResume(task)).toBe(true);
	});

	test("failed claude task is resumable", () => {
		const task = createTask({
			status: "failed",
			agent_backend: "claude",
		});
		expect(canShowResumeAction(task)).toBe(true);
		expect(supportsInteractiveResume(task)).toBe(true);
	});

	test("completed_stale claude task is resumable", () => {
		const task = createTask({
			status: "completed_stale",
			agent_backend: "claude",
		});
		expect(canShowResumeAction(task)).toBe(true);
		expect(supportsInteractiveResume(task)).toBe(true);
	});

	test("completed_dirty claude task is resumable", () => {
		const task = createTask({
			status: "completed_dirty",
			agent_backend: "claude",
		});
		expect(canShowResumeAction(task)).toBe(true);
		expect(supportsInteractiveResume(task)).toBe(true);
	});

	test("ACP task is never resumable", () => {
		const task = createTask({
			status: "completed",
			agent_backend: "acp-shell",
		});
		expect(canShowResumeAction(task)).toBe(false);
		expect(supportsInteractiveResume(task)).toBe(false);
	});

	test("codex and gemini tasks are resumable", () => {
		const codexTask = createTask({
			status: "completed",
			agent_backend: "codex",
		});
		const geminiTask = createTask({
			status: "completed",
			agent_backend: "gemini",
		});
		expect(canShowResumeAction(codexTask)).toBe(true);
		expect(supportsInteractiveResume(codexTask)).toBe(true);
		expect(canShowResumeAction(geminiTask)).toBe(true);
		expect(supportsInteractiveResume(geminiTask)).toBe(true);
	});

	test("unknown backend with session data is resumable", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "resume-session-test-"),
		);
		const task = createTask({
			status: "completed",
			agent_backend: undefined,
			cli_name: undefined,
			project_dir: "/tmp/unknown-project",
		});
		try {
			expect(canShowResumeAction(task)).toBe(true);
			expect(supportsInteractiveResume(task)).toBe(true);
			// Falls back to claude --continue when no session file found
			expect(await buildResumeCommand(task, tmpDir)).toBe("claude --continue");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
