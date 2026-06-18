import { describe, expect, test } from "bun:test";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";
import {
	getTaskDiffEndCommit,
	getTaskDiffStartCommit,
} from "../../src/providers/git-diff.js";

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "t1",
		status: "completed",
		project_dir: "/repo",
		project_name: "repo",
		session_id: "agent-x",
		bundle_path: "",
		prompt_file: "",
		started_at: "2026-01-01T00:00:00Z",
		attempts: 0,
		max_attempts: 0,
		...overrides,
	} as AgentTask;
}

describe("git-diff commit-boundary resolution", () => {
	test("getTaskDiffStartCommit returns undefined for running tasks (working-tree diff)", () => {
		expect(
			getTaskDiffStartCommit(makeTask({ status: "running" })),
		).toBeUndefined();
	});

	test("getTaskDiffStartCommit prefers explicit start_commit, then start_sha", () => {
		expect(getTaskDiffStartCommit(makeTask({ start_commit: "abc123" }))).toBe(
			"abc123",
		);
		expect(
			getTaskDiffStartCommit(
				makeTask({ start_commit: "unknown", start_sha: "def456" }),
			),
		).toBe("def456");
	});

	test("getTaskDiffStartCommit ignores 'unknown' sentinels", () => {
		// With no real commit and no started_at, it falls back to HEAD~1
		// (avoids shelling out to git in this unit test).
		expect(
			getTaskDiffStartCommit(
				makeTask({
					start_commit: "unknown",
					start_sha: "unknown",
					started_at: "",
				}),
			),
		).toBe("HEAD~1");
	});

	test("getTaskDiffEndCommit returns end_commit or undefined, ignoring 'unknown'", () => {
		expect(getTaskDiffEndCommit(makeTask({ end_commit: "fff999" }))).toBe(
			"fff999",
		);
		expect(
			getTaskDiffEndCommit(makeTask({ end_commit: "unknown" })),
		).toBeUndefined();
		expect(getTaskDiffEndCommit(makeTask())).toBeUndefined();
	});
});
