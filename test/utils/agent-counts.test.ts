import { describe, expect, test } from "bun:test";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";
import {
	type AgentCounts,
	countAgentStatuses,
	formatCountSummary,
} from "../../src/utils/agent-counts.js";

function makeTask(id: string, status: AgentTask["status"]): AgentTask {
	return {
		id,
		status,
		project_dir: "/tmp/project",
		project_name: "project",
		session_id: `session-${id}`,
		bundle_path: "",
		prompt_file: "",
		started_at: new Date().toISOString(),
		attempts: 0,
		max_attempts: 3,
	};
}

describe("countAgentStatuses", () => {
	test("counts all known status types into the right buckets", () => {
		const tasks: AgentTask[] = [
			makeTask("r1", "running"),
			makeTask("r2", "running"),
			makeTask("c1", "completed"),
			makeTask("c2", "completed_stale"),
			makeTask("f1", "failed"),
			makeTask("f2", "killed"),
			makeTask("f3", "contract_failure"),
			makeTask("s1", "stopped"),
		];

		expect(countAgentStatuses(tasks)).toEqual({
			running: 2,
			completed: 2,
			failed: 3,
			stopped: 1,
			total: 8,
		});
	});

	test("returns zeros for an empty task list", () => {
		expect(countAgentStatuses([])).toEqual({
			running: 0,
			completed: 0,
			failed: 0,
			stopped: 0,
			total: 0,
		});
	});
});

describe("formatCountSummary", () => {
	test("formats non-zero buckets in stable order", () => {
		const counts: AgentCounts = {
			running: 2,
			completed: 3,
			failed: 1,
			stopped: 4,
			total: 10,
		};

		expect(formatCountSummary(counts)).toBe(
			"2 running · 3 completed · 1 failed · 4 stopped",
		);
	});

	test("omits zero buckets", () => {
		const counts: AgentCounts = {
			running: 0,
			completed: 5,
			failed: 0,
			stopped: 1,
			total: 6,
		};

		expect(formatCountSummary(counts)).toBe("5 completed · 1 stopped");
	});

	test("returns fallback text when all buckets are zero", () => {
		const counts: AgentCounts = {
			running: 0,
			completed: 0,
			failed: 0,
			stopped: 0,
			total: 0,
		};

		expect(formatCountSummary(counts)).toBe("No agents");
	});
});
