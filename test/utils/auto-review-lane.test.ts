import { describe, expect, test } from "bun:test";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";
import {
	extractSourceTaskId,
	isAutoReviewLane,
	partitionAutoReviewLanes,
} from "../../src/utils/auto-review-lane.js";

function makeTask(
	overrides: Partial<AgentTask> & { id: string },
): AgentTask {
	return {
		status: "completed",
		project_dir: "/tmp/project",
		project_name: "project",
		session_id: `session-${overrides.id}`,
		bundle_path: "",
		prompt_file: "",
		started_at: new Date().toISOString(),
		attempts: 0,
		max_attempts: 3,
		...overrides,
	};
}

// ── Fixture tasks matching the four rows from the bug report ────────

const reviewGhosttyLauncher = makeTask({
	id: "review-ghostty-launcher-signing-fix-20260526",
	status: "completed",
	role: "reviewer",
	project_id: "config",
	project_dir:
		"/tmp/ghostty-launcher-ghostty-launcher-signing-fix-20260526-review",
	handoff_file:
		"/tmp/ghostty-launcher-ghostty-launcher-signing-fix-20260526-review/research/REVIEW-ghostty-launcher-signing-fix-20260526.md",
});

const reviewConfigLinear = makeTask({
	id: "review-config-linear-conductor-snapshot-20260526",
	status: "completed",
	role: "reviewer",
	project_id: "config",
	project_dir:
		"/tmp/config-config-linear-conductor-snapshot-20260526-review",
	handoff_file:
		"/tmp/config-config-linear-conductor-snapshot-20260526-review/research/REVIEW-config-linear-conductor-snapshot-20260526.md",
});

const reviewCcTreeTerminal = makeTask({
	id: "review-cc-tree-terminal-ux-20260526",
	status: "completed",
	role: "reviewer",
	project_id: "config",
	project_dir: "/tmp/command-central-cc-tree-terminal-ux-20260526-review",
	handoff_file:
		"/tmp/command-central-cc-tree-terminal-ux-20260526-review/research/REVIEW-cc-tree-terminal-ux-20260526.md",
});

const reviewCcBadgeLauncher = makeTask({
	id: "review-cc-badge-launcher-polish-20260526",
	status: "completed",
	role: "reviewer",
	project_id: "config",
	project_dir:
		"/tmp/command-central-cc-badge-launcher-polish-20260526-review",
	handoff_file:
		"/tmp/command-central-cc-badge-launcher-polish-20260526-review/research/REVIEW-cc-badge-launcher-polish-20260526.md",
});

const autoReviewFixtures = [
	reviewGhosttyLauncher,
	reviewConfigLinear,
	reviewCcTreeTerminal,
	reviewCcBadgeLauncher,
];

// ── Normal tasks that should NOT be filtered ────────────────────────

const normalDeveloperTask = makeTask({
	id: "cc-tree-terminal-ux-20260526",
	status: "running",
	role: "developer",
	project_dir: "/Users/ostehost/projects/command-central",
	project_name: "command-central",
});

const manualReviewerTask = makeTask({
	id: "manual-review-task",
	status: "running",
	role: "reviewer",
	project_dir: "/Users/ostehost/projects/command-central",
	project_name: "command-central",
});

describe("isAutoReviewLane", () => {
	test("detects all four bug-report fixture rows as auto-review lanes", () => {
		for (const fixture of autoReviewFixtures) {
			expect(isAutoReviewLane(fixture)).toBe(true);
		}
	});

	test("does NOT flag a normal developer task", () => {
		expect(isAutoReviewLane(normalDeveloperTask)).toBe(false);
	});

	test("does NOT flag a manually launched reviewer in a real project dir", () => {
		expect(isAutoReviewLane(manualReviewerTask)).toBe(false);
	});

	test("requires at least two signals — review- id alone is not enough", () => {
		const singleSignal = makeTask({
			id: "review-something",
			project_dir: "/Users/ostehost/projects/real-project",
			role: "developer",
		});
		expect(isAutoReviewLane(singleSignal)).toBe(false);
	});

	test("two signals suffice: review- id + reviewer role", () => {
		const twoSignals = makeTask({
			id: "review-something",
			project_dir: "/Users/ostehost/projects/real-project",
			role: "reviewer",
		});
		expect(isAutoReviewLane(twoSignals)).toBe(true);
	});

	test("two signals suffice: review- id + /tmp/-review dir", () => {
		const twoSignals = makeTask({
			id: "review-something",
			project_dir: "/tmp/proj-something-review",
		});
		expect(isAutoReviewLane(twoSignals)).toBe(true);
	});
});

describe("extractSourceTaskId", () => {
	test("extracts source task ID from auto-review lanes", () => {
		expect(extractSourceTaskId(reviewGhosttyLauncher)).toBe(
			"ghostty-launcher-signing-fix-20260526",
		);
		expect(extractSourceTaskId(reviewCcTreeTerminal)).toBe(
			"cc-tree-terminal-ux-20260526",
		);
		expect(extractSourceTaskId(reviewCcBadgeLauncher)).toBe(
			"cc-badge-launcher-polish-20260526",
		);
		expect(extractSourceTaskId(reviewConfigLinear)).toBe(
			"config-linear-conductor-snapshot-20260526",
		);
	});

	test("returns null for a non-review task", () => {
		expect(extractSourceTaskId(normalDeveloperTask)).toBeNull();
	});

	test("returns null for review- prefix with empty remainder", () => {
		const edge = makeTask({ id: "review-" });
		expect(extractSourceTaskId(edge)).toBeNull();
	});
});

describe("partitionAutoReviewLanes", () => {
	test("separates auto-review lanes from primary tasks", () => {
		const allTasks = [
			normalDeveloperTask,
			...autoReviewFixtures,
			manualReviewerTask,
		];
		const { primary, reviewLanes } = partitionAutoReviewLanes(allTasks);

		expect(primary).toHaveLength(2);
		expect(primary.map((t) => t.id)).toEqual([
			normalDeveloperTask.id,
			manualReviewerTask.id,
		]);

		expect(reviewLanes).toHaveLength(4);
		expect(reviewLanes.map((t) => t.id)).toEqual(
			autoReviewFixtures.map((t) => t.id),
		);
	});

	test("auto-review lanes do not inflate primary task counts", () => {
		const allTasks = [normalDeveloperTask, ...autoReviewFixtures];
		const { primary } = partitionAutoReviewLanes(allTasks);
		expect(primary).toHaveLength(1);
	});

	test("returns empty reviewLanes when no auto-review lanes exist", () => {
		const { primary, reviewLanes } = partitionAutoReviewLanes([
			normalDeveloperTask,
			manualReviewerTask,
		]);
		expect(primary).toHaveLength(2);
		expect(reviewLanes).toHaveLength(0);
	});
});
