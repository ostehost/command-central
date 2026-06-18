import { describe, expect, test } from "bun:test";
import {
	formatDurationPrecise,
	formatTaskElapsedDescription,
	getStatusDisplayLabel,
	getStatusThemeIcon,
	ROLE_ICONS,
} from "../../src/providers/agent-status-formatters.js";
import type { AgentNode } from "../../src/providers/agent-status-tree-nodes.js";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";
import {
	isAgentTeamLead,
	isSupersededByReleaseReset,
} from "../../src/providers/agent-task-classification.js";
import {
	isRegistryBackedLaneTask,
	normalizeProjectionLanes,
	normalizeRegistryTasks,
	normalizeTask,
	WORK_SYSTEM_LANES_PROJECTION_KIND,
	warnTaskRegistryFallback,
} from "../../src/providers/agent-task-normalize.js";
import { getAgentTypeIcon } from "../../src/providers/agent-type-detection.js";
import {
	formatCodexRunAuthority,
	formatCodexRunAutomationSource,
	formatCodexRunFieldSourceDetails,
	formatCodexRunLastEvent,
	formatCodexRunRuntime,
	formatCodexRunTrackerSource,
	formatCodexRunTurns,
	formatCodexRunWorkflow,
	getCodexRunActivityTimeMs,
	getCodexRunEvidenceIcon,
	getCodexRunStatusIcon,
} from "../../src/providers/codex-run-format.js";
import {
	computeDiffSummaryAsync,
	getPerFileNumstatDiffs,
} from "../../src/providers/git-diff.js";
import { isOpenClawTaskVisibleInRunningMode } from "../../src/providers/openclaw-task-format.js";
import {
	formatSymphonyDashboardDescription,
	formatSymphonyRuntimeSnapshotStatus,
	formatSymphonySnapshotValue,
	getSymphonyRunGroupCount,
	getSymphonyRunGroupEmptyDescription,
	getSymphonyRunGroupIcon,
	getSymphonyRunGroupSnapshotEntries,
	getSymphonyRunGroupSpecStatus,
	getSymphonySnapshotEntryIssue,
} from "../../src/providers/symphony-projection.js";
import type {
	CodexRunView,
	SymphonyRuntimeSnapshotView,
} from "../../src/types/codex-run-types.js";
import type { OpenClawTask } from "../../src/types/openclaw-task-types.js";

function makeAgentTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "task-1",
		status: "running",
		project_dir: "/repo",
		project_name: "repo",
		session_id: "session-1",
		bundle_path: "",
		prompt_file: "",
		started_at: "2026-06-18T20:00:00.000Z",
		attempts: 0,
		max_attempts: 0,
		...overrides,
	} as AgentTask;
}

function makeCodexRun(overrides: Partial<CodexRunView> = {}): CodexRunView {
	return {
		runId: "run-1",
		title: "Run 1",
		source: { kind: "openclaw-task", id: "task-1" },
		mergedFrom: [],
		status: "running",
		fieldSources: {},
		...overrides,
	};
}

describe("extracted Agent Status helper modules", () => {
	test("status formatters expose the tree/dashboard presentation contract", () => {
		const completedIcon = getStatusThemeIcon("completed") as {
			id: string;
			color?: { id: string };
		};
		expect(completedIcon.id).toBe("check");
		expect(completedIcon.color?.id).toBe("charts.green");
		expect(getStatusDisplayLabel("completed_dirty")).toBe("completed (dirty)");
		expect(ROLE_ICONS.reviewer).toBe("🔍");
		expect(
			formatDurationPrecise(
				"2026-06-18T20:00:00.000Z",
				"2026-06-18T20:01:05.000Z",
			),
		).toBe("1m 5s");
		expect(
			formatTaskElapsedDescription(
				makeAgentTask({
					status: "completed",
					completed_at: "2026-06-18T20:05:00.000Z",
				}),
			),
		).toMatch(/^Completed /);
	});

	test("task normalizers parse launcher registry and projection records", () => {
		const rawTask = {
			id: "task-1",
			session_id: "session-1",
			status: "active",
			project_dir: "/repo",
			project_ref: { id: "project-1", displayName: "Project One" },
		};
		const normalized = normalizeTask("task-1", rawTask);
		expect(normalized?.status).toBe("running");
		expect(normalized?.project_ref?.id).toBe("project-1");
		expect(isRegistryBackedLaneTask(normalized ?? makeAgentTask())).toBe(true);
		expect(normalizeRegistryTasks({ "task-1": rawTask })?.["task-1"]?.id).toBe(
			"task-1",
		);

		const lanes = normalizeProjectionLanes({
			"launcher:task-2": {
				kind: "lane_ref_update",
				lane_ref: {
					id: "launcher:task-2",
					task: "task-2",
					status: "running",
					session: "session-2",
					worktree: "/repo",
					updatedAt: "2026-06-18T20:00:00.000Z",
				},
				project_ref: { id: "project-2" },
			},
		});
		expect(lanes?.["launcher:task-2"]?.lane_projection).toBe(true);
		expect(WORK_SYSTEM_LANES_PROJECTION_KIND).toBe(
			"work-system-lanes-projection",
		);

		const originalWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (message?: unknown): void => {
			warnings.push(String(message));
		};
		try {
			warnTaskRegistryFallback("/tmp/tasks.json", "invalid json");
		} finally {
			console.warn = originalWarn;
		}
		expect(warnings[0]).toContain("invalid json");
	});

	test("direct classification helpers remain covered outside provider re-exports", () => {
		expect(isAgentTeamLead({ team_requested: true })).toBe(true);
		expect(isAgentTeamLead({ team_requested: false, team_template: " " })).toBe(
			false,
		);
		expect(
			isSupersededByReleaseReset({ release_generation: "rc.1" }, "rc.2"),
		).toBe(true);
	});

	test("agent and Codex run formatters cover icons, provenance, and timing", () => {
		const agentIcon = getAgentTypeIcon({ cli_name: "gemini" }) as {
			id: string;
			color?: { id: string };
		};
		expect(agentIcon.color?.id).toBe("charts.blue");

		const run = makeCodexRun({
			trackerKind: "linear",
			workflowName: "Implement",
			workflowPath: "workflow.md",
			workflowRunId: "wf-1",
			turnCount: 3,
			runtimeSeconds: 64.4,
			lastEvent: "tool_call",
			lastEventAt: Date.parse("2026-06-18T20:00:00.000Z"),
			startedAt: Date.parse("2026-06-18T19:59:00.000Z"),
			fieldSources: {
				status: [{ kind: "openclaw-task", id: "task-1" }],
				workflowName: [{ kind: "taskflow", id: "flow-1" }],
			},
		});

		expect(getCodexRunEvidenceIcon("commit")).toBe("git-commit");
		expect(formatCodexRunLastEvent(run)).toBe(
			"tool_call · 2026-06-18T20:00:00.000Z",
		);
		expect(formatCodexRunAuthority(run)).toBe("OpenClaw task task-1");
		expect(formatCodexRunAutomationSource(run)).toBe("Tracker-driven (linear)");
		expect(formatCodexRunTrackerSource(run)).toBe("linear");
		expect(formatCodexRunWorkflow(run)).toBe("Implement · workflow.md · wf-1");
		expect(formatCodexRunTurns(run)).toBe("3");
		expect(formatCodexRunRuntime(run)).toBe("64s");
		expect(formatCodexRunFieldSourceDetails(run)).toHaveLength(2);
		expect(getCodexRunActivityTimeMs(run)).toBe(
			Date.parse("2026-06-18T20:00:00.000Z"),
		);
		expect((getCodexRunStatusIcon("lost") as { id: string }).id).toBe(
			"warning",
		);
	});

	test("diff IO helpers stay available to provider extraction callers", () => {
		expect(typeof getPerFileNumstatDiffs).toBe("function");
		expect(typeof computeDiffSummaryAsync).toBe("function");
	});

	test("OpenClaw visibility helper mirrors active task filtering", () => {
		expect(
			isOpenClawTaskVisibleInRunningMode({
				taskId: "task-1",
				task: "work",
				status: "running",
				runtime: "cli",
			} as OpenClawTask),
		).toBe(true);
		expect(
			isOpenClawTaskVisibleInRunningMode({
				taskId: "task-1",
				task: "work",
				status: "succeeded",
				runtime: "cli",
			} as OpenClawTask),
		).toBe(false);
	});

	test("Symphony projection helpers expose snapshot and run-group presentation", () => {
		const snapshot: SymphonyRuntimeSnapshotView = {
			status: "fresh",
			source: "fixture",
			counts: { running: 2, retrying: 1 },
			running: [{ issueIdentifier: "CC-1", issueState: "In Progress" }],
			retrying: [{ issueIdentifier: "CC-2", issueState: "RetryQueued" }],
			rateLimits: { model: "ok" },
		};
		const node = {
			type: "symphonyRunGroup" as const,
			kind: "running" as const,
			runs: [makeCodexRun()],
			snapshot,
		};

		expect(formatSymphonyRuntimeSnapshotStatus(snapshot)).toBe("fresh");
		expect(formatSymphonySnapshotValue({ ok: true })).toBe('{"ok":true}');
		expect(getSymphonyRunGroupCount(node)).toBe(1);
		expect(getSymphonyRunGroupSnapshotEntries(node)).toHaveLength(1);
		expect(
			getSymphonySnapshotEntryIssue({
				issueIdentifier: "CC-1",
				issueState: "In Progress",
			}),
		).toBe("CC-1 · In Progress");
		expect(
			formatSymphonyDashboardDescription([
				makeCodexRun({
					symphonyRuntimeSnapshot: snapshot,
				}),
			]),
		).toBe("2 running · 1 RetryQueued · 1 rate-limit snapshot");
		expect(getSymphonyRunGroupSpecStatus("retryQueued")).toBe("RetryQueued");
		expect(getSymphonyRunGroupEmptyDescription("released")).toContain(
			"Released evidence",
		);
		expect((getSymphonyRunGroupIcon("running") as { id: string }).id).toBe(
			"pulse",
		);
	});

	test("extracted node union type remains importable by consumers", () => {
		const node: AgentNode = { type: "summary", label: "1 running" };
		expect(node.label).toBe("1 running");
	});
});
