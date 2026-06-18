import { describe, expect, test } from "bun:test";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";
import {
	extractSourceTaskId,
	isAutoReviewLane,
	isReviewOnlyLane,
	partitionAutoReviewLanes,
} from "../../src/utils/auto-review-lane.js";

function makeTask(overrides: Partial<AgentTask> & { id: string }): AgentTask {
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
	project_dir: "/tmp/config-config-linear-conductor-snapshot-20260526-review",
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
	project_dir: "/tmp/command-central-cc-badge-launcher-polish-20260526-review",
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

	test("review- id + reviewer role in a real dir is NOT filtered", () => {
		const realDirReviewer = makeTask({
			id: "review-something",
			project_dir: "/Users/ostehost/projects/real-project",
			role: "reviewer",
		});
		expect(isAutoReviewLane(realDirReviewer)).toBe(false);
	});

	test("all three non-dir signals in a real dir are NOT filtered", () => {
		const allThree = makeTask({
			id: "review-something",
			project_dir: "/Users/ostehost/projects/real-project",
			role: "reviewer",
			handoff_file: "/some/path/REVIEW-something.md",
		});
		expect(isAutoReviewLane(allThree)).toBe(false);
	});

	test("review- id alone (no /tmp dir) is not enough", () => {
		const singleSignal = makeTask({
			id: "review-something",
			project_dir: "/Users/ostehost/projects/real-project",
			role: "developer",
		});
		expect(isAutoReviewLane(singleSignal)).toBe(false);
	});

	test("/tmp/-review dir + review- id suffices", () => {
		const tmpWithId = makeTask({
			id: "review-something",
			project_dir: "/tmp/proj-something-review",
		});
		expect(isAutoReviewLane(tmpWithId)).toBe(true);
	});

	test("/tmp/-review dir + reviewer role suffices", () => {
		const tmpWithRole = makeTask({
			id: "some-other-task",
			project_dir: "/tmp/proj-something-review",
			role: "reviewer",
		});
		expect(isAutoReviewLane(tmpWithRole)).toBe(true);
	});

	test("/tmp/-review dir + REVIEW- handoff suffices", () => {
		const tmpWithHandoff = makeTask({
			id: "some-other-task",
			project_dir: "/tmp/proj-something-review",
			handoff_file: "/tmp/proj-something-review/research/REVIEW-foo.md",
		});
		expect(isAutoReviewLane(tmpWithHandoff)).toBe(true);
	});

	test("/tmp/-review dir alone (no corroborating signal) is not enough", () => {
		const tmpDirOnly = makeTask({
			id: "some-other-task",
			project_dir: "/tmp/proj-something-review",
			role: "developer",
		});
		expect(isAutoReviewLane(tmpDirOnly)).toBe(false);
	});
});

describe("isReviewOnlyLane", () => {
	test("flags a reviewer-role lane in a REAL project dir (unlike isAutoReviewLane)", () => {
		// The defining contrast: a reviewer lane that ran in the real repo is
		// never an auto-review lane (not hidden), but IS a review-only lane (its
		// lifecycle is no_review_expected).
		expect(isAutoReviewLane(manualReviewerTask)).toBe(false);
		expect(isReviewOnlyLane(manualReviewerTask)).toBe(true);
	});

	test("flags a lane_kind=review lane with no role field", () => {
		const laneKindOnly = makeTask({
			id: "review-symphony-visible-claude-entrypoint-20260616",
			project_dir: "/Users/ostehost/projects/symphony-daemon",
			lane_kind: "review",
		});
		expect(isReviewOnlyLane(laneKindOnly)).toBe(true);
	});

	test("flags review- id corroborated by a /REVIEW- handoff artifact", () => {
		const idPlusHandoff = makeTask({
			id: "review-symphony-visible-claude-entrypoint-20260616",
			project_dir: "/Users/ostehost/projects/symphony-daemon",
			role: "developer",
			handoff_file:
				"research/REVIEW-symphony-visible-claude-entrypoint-20260616.md",
		});
		expect(isReviewOnlyLane(idPlusHandoff)).toBe(true);
	});

	test("does NOT flag a normal developer task", () => {
		expect(isReviewOnlyLane(normalDeveloperTask)).toBe(false);
	});

	test("review- id ALONE (no review handoff) is not enough — avoids misclassifying impl tasks", () => {
		const implNamedReview = makeTask({
			id: "review-queue-health-refactor-20260616",
			project_dir: "/Users/ostehost/projects/command-central",
			role: "developer",
			handoff_file: "research/QUEUE-HEALTH-REFACTOR.md",
		});
		expect(isReviewOnlyLane(implNamedReview)).toBe(false);
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

describe("isReviewOnlyLane", () => {
	test("treats real-project reviewer lanes as review-only without filtering them", () => {
		expect(isAutoReviewLane(manualReviewerTask)).toBe(false);
		expect(isReviewOnlyLane(manualReviewerTask)).toBe(true);
	});

	test("recognizes canonical review lane_kind", () => {
		expect(
			isReviewOnlyLane(
				makeTask({
					id: "lane-kind-review",
					role: "developer",
					lane_kind: "review",
				}),
			),
		).toBe(true);
	});

	test("does not classify review-prefixed implementation tasks without a review handoff", () => {
		expect(
			isReviewOnlyLane(
				makeTask({
					id: "review-implementation-task",
					role: "developer",
					project_dir: "/Users/ostehost/projects/real-project",
				}),
			),
		).toBe(false);
	});
});
