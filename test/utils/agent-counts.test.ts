import { describe, expect, test } from "bun:test";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";
import {
	type AgentCounts,
	countAgentStatuses,
	formatCountSummary,
} from "../../src/utils/agent-counts.js";

function makeTask(
	id: string,
	status: AgentTask["status"],
	review_status?: AgentTask["review_status"],
): AgentTask {
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
		...(review_status !== undefined ? { review_status } : {}),
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

describe("countAgentStatuses — review_status routing", () => {
	test("completed + review_status pending → attention, not done", () => {
		const tasks = [makeTask("t1", "completed", "pending")];
		expect(countAgentStatuses(tasks)).toEqual({
			working: 0,
			attention: 1,
			limbo: 0,
			done: 0,
			total: 1,
		});
	});

	test("completed + review_status changes_requested → attention, not done", () => {
		const tasks = [makeTask("t1", "completed", "changes_requested")];
		expect(countAgentStatuses(tasks)).toEqual({
			working: 0,
			attention: 1,
			limbo: 0,
			done: 0,
			total: 1,
		});
	});

	test("completed + review_status approved → done", () => {
		const tasks = [makeTask("t1", "completed", "approved")];
		expect(countAgentStatuses(tasks)).toEqual({
			working: 0,
			attention: 0,
			limbo: 0,
			done: 1,
			total: 1,
		});
	});

	test("completed + no review_status → done (preserves existing behavior)", () => {
		const tasks = [makeTask("t1", "completed")];
		expect(countAgentStatuses(tasks)).toEqual({
			working: 0,
			attention: 0,
			limbo: 0,
			done: 1,
			total: 1,
		});
	});

	test("mixed scenario routes each task to the correct bucket", () => {
		const tasks = [
			makeTask("r1", "running"),
			makeTask("c1", "completed", "approved"),
			makeTask("c2", "completed", "pending"),
			makeTask("d1", "completed_dirty"),
		];
		expect(countAgentStatuses(tasks)).toEqual({
			working: 1,
			attention: 1,
			limbo: 1,
			done: 1,
			total: 4,
		});
	});

	// ── Joint regression: review_status + declared handoff_file ──────────────
	// `countAgentStatuses` is stateless — it cannot stat the filesystem, so it
	// routes purely on `status` and `review_status`. These cases pin down that
	// presence of a `handoff_file` field on the task does NOT change the
	// badge-count routing, which keeps the badge aligned with the tree provider
	// whenever review_status is the deciding signal (pending / changes_requested).
	// For approved+missing-handoff the badge and tree provider intentionally
	// diverge — the tree provider demotes to limbo, but the badge has no way to
	// know the handoff is missing and stays at `done`. This is the
	// badge-count path proved by these tests.
	test("joint: completed + review_status=pending + handoff_file declared → attention", () => {
		const task: AgentTask = {
			...makeTask("t1", "completed", "pending"),
			handoff_file: "MISSING.md",
		};
		expect(countAgentStatuses([task])).toEqual({
			working: 0,
			attention: 1,
			limbo: 0,
			done: 0,
			total: 1,
		});
	});

	test("joint: completed + review_status=changes_requested + handoff_file declared → attention", () => {
		const task: AgentTask = {
			...makeTask("t1", "completed", "changes_requested"),
			handoff_file: "MISSING.md",
		};
		expect(countAgentStatuses([task])).toEqual({
			working: 0,
			attention: 1,
			limbo: 0,
			done: 0,
			total: 1,
		});
	});

	test("joint: completed + review_status=approved + handoff_file declared → done (badge is fs-blind)", () => {
		const task: AgentTask = {
			...makeTask("t1", "completed", "approved"),
			handoff_file: "MISSING.md",
		};
		expect(countAgentStatuses([task])).toEqual({
			working: 0,
			attention: 0,
			limbo: 0,
			done: 1,
			total: 1,
		});
	});

	test("formatCountSummary with includeAttention shows attention segment for mixed scenario", () => {
		const counts = countAgentStatuses([
			makeTask("r1", "running"),
			makeTask("c1", "completed", "approved"),
			makeTask("c2", "completed", "pending"),
			makeTask("d1", "completed_dirty"),
		]);
		expect(formatCountSummary(counts, { includeAttention: true })).toBe(
			"1 working · 1 attention · 2 done",
		);
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

	test("folds limbo into done count in summary when non-zero", () => {
		const counts: AgentCounts = {
			working: 1,
			attention: 0,
			limbo: 2,
			done: 3,
			total: 6,
		};

		expect(formatCountSummary(counts)).toBe("1 working · 5 done");
	});

	test("limbo folds into done after attention in summary", () => {
		const counts: AgentCounts = {
			working: 1,
			attention: 2,
			limbo: 3,
			done: 4,
			total: 10,
		};

		expect(formatCountSummary(counts, { includeAttention: true })).toBe(
			"1 working · 2 attention · 7 done",
		);
	});
});
