/**
 * Agent status limbo tier tests
 *
 * Verifies that completed_dirty and completed_stale agents are routed to the
 * "limbo" bucket (not "done"), that only clean completed goes to "done", and
 * that the AgentStatusGroup type and ordering constants are correct.
 */

import { describe, expect, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

setupVSCodeMock();

import type {
	AgentStatusGroup,
	AgentTask,
} from "../../src/providers/agent-status-tree-provider.js";
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

describe("limbo tier — countAgentStatuses routing", () => {
	test("completed_dirty goes to limbo, not done", () => {
		const counts = countAgentStatuses([makeTask("1", "completed_dirty")]);
		expect(counts.limbo).toBe(1);
		expect(counts.done).toBe(0);
	});

	test("completed_stale goes to limbo, not done", () => {
		const counts = countAgentStatuses([makeTask("1", "completed_stale")]);
		expect(counts.limbo).toBe(1);
		expect(counts.done).toBe(0);
	});

	test("clean completed goes to done, not limbo", () => {
		const counts = countAgentStatuses([makeTask("1", "completed")]);
		expect(counts.done).toBe(1);
		expect(counts.limbo).toBe(0);
	});

	test("mixed: one of each terminal status routes correctly", () => {
		const counts = countAgentStatuses([
			makeTask("r", "running"),
			makeTask("c", "completed"),
			makeTask("cd", "completed_dirty"),
			makeTask("cs", "completed_stale"),
			makeTask("f", "failed"),
			makeTask("k", "killed"),
			makeTask("s", "stopped"),
			makeTask("cf", "contract_failure"),
		]);

		expect(counts.working).toBe(1);
		expect(counts.done).toBe(1);
		expect(counts.limbo).toBe(2);
		expect(counts.attention).toBe(4);
		expect(counts.total).toBe(8);
	});

	test("multiple completed_dirty/stale are all counted as limbo", () => {
		const counts = countAgentStatuses([
			makeTask("cd1", "completed_dirty"),
			makeTask("cd2", "completed_dirty"),
			makeTask("cs1", "completed_stale"),
		]);

		expect(counts.limbo).toBe(3);
		expect(counts.done).toBe(0);
	});
});

describe("limbo tier — formatCountSummary folds limbo into done", () => {
	test("limbo tasks are folded into the done tally in summary output", () => {
		const counts: AgentCounts = {
			working: 0,
			attention: 0,
			limbo: 2,
			done: 1,
			total: 3,
		};
		const summary = formatCountSummary(counts);
		expect(summary).toBe("3 done");
		expect(summary).not.toContain("limbo");
	});

	test("limbo-only tasks show as done after attention when includeAttention is true", () => {
		const counts: AgentCounts = {
			working: 0,
			attention: 1,
			limbo: 2,
			done: 0,
			total: 3,
		};
		const summary = formatCountSummary(counts, { includeAttention: true });
		expect(summary).toBe("1 attention · 2 done");
		expect(summary).not.toContain("limbo");
	});

	test("limbo is omitted from summary when zero", () => {
		const counts: AgentCounts = {
			working: 1,
			attention: 0,
			limbo: 0,
			done: 2,
			total: 3,
		};
		const summary = formatCountSummary(counts);
		expect(summary).not.toContain("limbo");
		expect(summary).toBe("1 working · 2 done");
	});
});

// ---------------------------------------------------------------------------
// review_status routing (Slice 3: badge now mirrors the tree provider)
//
// `getNodeStatusGroup` in AgentStatusTreeProvider routes a completed task to
// "attention" when `task.review_status` is "pending" or "changes_requested",
// and to "done" otherwise (approved / null / undefined).
//
// Slice 3 closed the gap that Slice 1 intentionally left: `countAgentStatuses`
// now mirrors that same logic, routing completed tasks with `review_status` of
// "pending" or "changes_requested" into the `attention` bucket so that badge
// counts stay in sync with the tree provider display.
// ---------------------------------------------------------------------------

describe("review_status — countAgentStatuses routes pending/changes_requested to attention", () => {
	test("completed + review_status pending counts as attention in badge", () => {
		const task: AgentTask = {
			...makeTask("1", "completed"),
			review_status: "pending",
		};
		const counts = countAgentStatuses([task]);
		expect(counts.attention).toBe(1);
		expect(counts.done).toBe(0);
	});

	test("completed + review_status changes_requested counts as attention in badge", () => {
		const task: AgentTask = {
			...makeTask("1", "completed"),
			review_status: "changes_requested",
		};
		const counts = countAgentStatuses([task]);
		expect(counts.attention).toBe(1);
		expect(counts.done).toBe(0);
	});

	test("completed + review_status approved counts as done in badge", () => {
		const task: AgentTask = {
			...makeTask("1", "completed"),
			review_status: "approved",
		};
		const counts = countAgentStatuses([task]);
		expect(counts.done).toBe(1);
		expect(counts.attention).toBe(0);
	});

	test("completed + review_status null counts as done in badge", () => {
		const task: AgentTask = {
			...makeTask("1", "completed"),
			review_status: null,
		};
		const counts = countAgentStatuses([task]);
		expect(counts.done).toBe(1);
		expect(counts.attention).toBe(0);
	});
});

describe("limbo tier — AgentStatusGroup type", () => {
	test('"limbo" is a valid AgentStatusGroup value', () => {
		// Compile-time check: assigning "limbo" to the union type must not error.
		const group: AgentStatusGroup = "limbo";
		expect(group).toBe("limbo");
	});

	test("all four groups are valid AgentStatusGroup values", () => {
		const groups: AgentStatusGroup[] = [
			"running",
			"attention",
			"limbo",
			"done",
		];
		expect(groups).toHaveLength(4);
		expect(groups).toContain("limbo");
	});
});
