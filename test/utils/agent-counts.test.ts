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
			makeTask("c3", "completed_dirty"),
			makeTask("c2", "completed_stale"),
			makeTask("f1", "failed"),
			makeTask("f2", "killed"),
			makeTask("f3", "contract_failure"),
			makeTask("s1", "stopped"),
		];

		expect(countAgentStatuses(tasks)).toEqual({
			working: 2,
			attention: 4,
			limbo: 2,
			done: 1,
			total: 9,
		});
	});

	test("returns zeros for an empty task list", () => {
		expect(countAgentStatuses([])).toEqual({
			working: 0,
			attention: 0,
			limbo: 0,
			done: 0,
			total: 0,
		});
	});
});

describe("formatCountSummary", () => {
	test("formats non-zero buckets in stable order", () => {
		const counts: AgentCounts = {
			working: 2,
			attention: 5,
			limbo: 0,
			done: 3,
			total: 10,
		};

		expect(formatCountSummary(counts)).toBe("2 working · 3 done");
	});

	test("omits zero buckets", () => {
		const counts: AgentCounts = {
			working: 0,
			attention: 0,
			limbo: 0,
			done: 5,
			total: 6,
		};

		expect(formatCountSummary(counts)).toBe("5 done");
	});

	test("returns fallback text when all buckets are zero", () => {
		const counts: AgentCounts = {
			working: 0,
			attention: 0,
			limbo: 0,
			done: 0,
			total: 0,
		};

		expect(formatCountSummary(counts)).toBe("No agents");
	});

	test("can include attention rollup in formatted summary", () => {
		const counts: AgentCounts = {
			working: 2,
			attention: 7,
			limbo: 0,
			done: 1,
			total: 10,
		};

		expect(formatCountSummary(counts, { includeAttention: true })).toBe(
			"2 working · 7 attention · 1 done",
		);
	});

	test("includes limbo count in summary when non-zero", () => {
		const counts: AgentCounts = {
			working: 1,
			attention: 0,
			limbo: 2,
			done: 3,
			total: 6,
		};

		expect(formatCountSummary(counts)).toBe("1 working · 2 limbo · 3 done");
	});

	test("limbo appears between attention and done in summary", () => {
		const counts: AgentCounts = {
			working: 1,
			attention: 2,
			limbo: 3,
			done: 4,
			total: 10,
		};

		expect(formatCountSummary(counts, { includeAttention: true })).toBe(
			"1 working · 2 attention · 3 limbo · 4 done",
		);
	});
});
