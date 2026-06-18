import { describe, expect, test } from "bun:test";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";
import {
	codexRunSessionsMatch,
	formatOpenClawAuditStatusLabel,
	formatOpenClawTaskDuration,
	getOpenClawRuntimeIcon,
	getOpenClawTaskActivityTimeMs,
	getOpenClawTaskDisplayTitle,
	isOpenClawTaskActive,
	mapOpenClawTaskToAgentStatus,
	openClawTaskMatchesLauncherTask,
	toSyntheticOpenClawTask,
} from "../../src/providers/openclaw-task-format.js";
import type { OpenClawTask } from "../../src/types/openclaw-task-types.js";

function makeTask(overrides: Partial<OpenClawTask> = {}): OpenClawTask {
	return {
		taskId: "task-1",
		task: "do the thing",
		status: "running",
		runtime: "cli",
		...overrides,
	} as OpenClawTask;
}

describe("openclaw-task-format", () => {
	test("mapOpenClawTaskToAgentStatus collapses OpenClaw statuses to agent buckets", () => {
		expect(mapOpenClawTaskToAgentStatus(makeTask({ status: "queued" }))).toBe(
			"running",
		);
		expect(
			mapOpenClawTaskToAgentStatus(makeTask({ status: "succeeded" })),
		).toBe("completed");
		expect(
			mapOpenClawTaskToAgentStatus(makeTask({ status: "timed_out" })),
		).toBe("failed");
	});

	test("toSyntheticOpenClawTask projects into a Background Tasks agent task", () => {
		const synthetic = toSyntheticOpenClawTask(
			makeTask({ taskId: "abc", status: "succeeded" }),
		);
		expect(synthetic.id).toBe("openclaw-abc");
		expect(synthetic.status).toBe("completed");
		expect(synthetic.project_name).toBe("Background Tasks");
		expect(synthetic.session_id).toBe("abc");
	});

	test("activity predicates + time selection", () => {
		expect(isOpenClawTaskActive(makeTask({ status: "running" }))).toBe(true);
		expect(isOpenClawTaskActive(makeTask({ status: "failed" }))).toBe(false);
		expect(
			getOpenClawTaskActivityTimeMs(
				makeTask({ createdAt: 1, startedAt: 2, lastEventAt: 9 }),
			),
		).toBe(9);
	});

	test("display title prefers label, then task, then id", () => {
		expect(getOpenClawTaskDisplayTitle(makeTask({ label: " Build " }))).toBe(
			"Build",
		);
		expect(
			getOpenClawTaskDisplayTitle(makeTask({ label: "", task: "Compile" })),
		).toBe("Compile");
	});

	test("duration formats from start/end, runtime icon, and audit pluralization", () => {
		expect(
			formatOpenClawTaskDuration(
				makeTask({ startedAt: 1, endedAt: 3_660_001 }),
			),
		).toBe("1h 1m");
		expect(
			formatOpenClawTaskDuration(
				makeTask({ startedAt: undefined, createdAt: undefined }),
			),
		).toBeNull();
		expect(getOpenClawRuntimeIcon("cron")).toBe("clock");
		expect(formatOpenClawAuditStatusLabel("stale_running", 1)).toBe(
			"stale_running error detected",
		);
		expect(formatOpenClawAuditStatusLabel("orphaned", 2)).toBe(
			"orphaned findings detected",
		);
	});

	test("session matching correlates launcher and OpenClaw sessions across the session: prefix", () => {
		expect(codexRunSessionsMatch("session:agent-x", "agent-x")).toBe(true);
		expect(codexRunSessionsMatch("agent-x", "agent-x")).toBe(true);
		expect(codexRunSessionsMatch("agent-x", "agent-y")).toBe(false);
		expect(codexRunSessionsMatch(undefined, "agent-x")).toBe(false);
	});

	test("openClawTaskMatchesLauncherTask matches by taskId, runId, or session", () => {
		const launcher = { id: "L1", session_id: "session:agent-z" } as AgentTask;
		expect(
			openClawTaskMatchesLauncherTask(makeTask({ taskId: "L1" }), launcher),
		).toBe(true);
		expect(
			openClawTaskMatchesLauncherTask(
				makeTask({ taskId: "x", runId: "L1" }),
				launcher,
			),
		).toBe(true);
		expect(
			openClawTaskMatchesLauncherTask(
				makeTask({ taskId: "x", childSessionKey: "agent-z" }),
				launcher,
			),
		).toBe(true);
		expect(
			openClawTaskMatchesLauncherTask(makeTask({ taskId: "x" }), launcher),
		).toBe(false);
	});
});
