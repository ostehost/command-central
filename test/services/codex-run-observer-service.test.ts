import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";
import { CodexRunObserverService } from "../../src/services/codex-run-observer-service.js";
import type { OpenClawTask } from "../../src/types/openclaw-task-types.js";
import type { TaskFlow } from "../../src/types/taskflow-types.js";

function openClawTask(overrides: Partial<OpenClawTask> = {}): OpenClawTask {
	return {
		taskId: "oc-1",
		runtime: "acp",
		ownerKey: "main",
		scopeKind: "workspace",
		task: "Implement the thing",
		status: "running",
		deliveryStatus: "pending",
		notifyPolicy: "silent",
		createdAt: 1_000,
		startedAt: 2_000,
		lastEventAt: 3_000,
		...overrides,
	};
}

function launcherTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "launcher-1",
		status: "running",
		project_dir: "/tmp/project-a",
		project_name: "Project A",
		session_id: "agent-project-a",
		stream_file: "/tmp/project-a/stream.jsonl",
		bundle_path: "/Applications/Project A.app",
		handoff_file: "/tmp/project-a/handoff.md",
		prompt_file: "/tmp/project-a/prompt.md",
		started_at: new Date(2_500).toISOString(),
		updated_at: new Date(4_000).toISOString(),
		attempts: 1,
		max_attempts: 3,
		model: "gpt-5.4",
		actual_model: "gpt-5.5",
		prompt_summary: "Implement the launcher-visible task",
		...overrides,
	};
}

function taskFlow(overrides: Partial<TaskFlow> = {}): TaskFlow {
	return {
		flowId: "flow-1",
		label: "Flow 1",
		status: "failed",
		createdAt: 500,
		startedAt: 1_500,
		endedAt: 5_000,
		taskCount: 1,
		completedCount: 0,
		failedCount: 1,
		tasks: [openClawTask({ taskId: "oc-1", status: "failed" })],
		...overrides,
	};
}

describe("CodexRunObserverService", () => {
	test("projects OpenClaw tasks while preserving raw lifecycle status", () => {
		const service = new CodexRunObserverService();
		const [run] = service.project({
			agentTasks: [],
			openClawTasks: [
				openClawTask({
					runId: "run-1",
					status: "timed_out",
					label: "Timed out task",
				}),
			],
			taskFlows: [],
		});

		expect(run).toMatchObject({
			runId: "run-1",
			title: "Timed out task",
			source: { kind: "openclaw-task", id: "oc-1" },
			sourceStatus: "timed_out",
			status: "timed_out",
			taskId: "oc-1",
		});
		expect(run?.mergedFrom).toEqual([{ kind: "openclaw-task", id: "oc-1" }]);
		expect(run?.fieldSources.status).toEqual([
			{ kind: "openclaw-task", id: "oc-1" },
		]);
	});

	test("joins TaskFlow context without overriding child task lifecycle status", () => {
		const service = new CodexRunObserverService();
		const [run] = service.project({
			agentTasks: [],
			openClawTasks: [openClawTask({ taskId: "oc-1", status: "running" })],
			taskFlows: [taskFlow({ status: "failed" })],
		});

		expect(run?.status).toBe("running");
		expect(run?.sourceStatus).toBe("running");
		expect(run?.flowId).toBe("flow-1");
		expect(run?.mergedFrom).toContainEqual({
			kind: "taskflow",
			id: "flow-1",
		});
		expect(run?.fieldSources.flowId).toEqual([
			{ kind: "taskflow", id: "flow-1" },
		]);
	});

	test("joins launcher metadata by child session key and keeps OpenClaw authoritative", () => {
		const service = new CodexRunObserverService();
		const [run] = service.project({
			agentTasks: [launcherTask({ id: "launcher-visible" })],
			openClawTasks: [
				openClawTask({
					taskId: "oc-1",
					task: "oc-1",
					childSessionKey: "session:agent-project-a",
				}),
			],
			taskFlows: [],
		});

		expect(run?.source).toEqual({ kind: "openclaw-task", id: "oc-1" });
		expect(run?.mergedFrom).toContainEqual({
			kind: "launcher",
			id: "launcher-visible",
			path: "/tmp/project-a",
		});
		expect(run?.status).toBe("running");
		expect(run?.title).toBe("Implement the launcher-visible task");
		expect(run?.model).toBe("gpt-5.5");
		expect(run?.workspacePath).toBe("/tmp/project-a");
		expect(run?.artifactPaths).toEqual([
			"/tmp/project-a/stream.jsonl",
			"/tmp/project-a/prompt.md",
			"/tmp/project-a/handoff.md",
		]);
		expect(run?.fieldSources.model).toEqual([
			{ kind: "launcher", id: "launcher-visible", path: "/tmp/project-a" },
		]);
		expect(run?.fieldSources.artifactPaths).toEqual([
			{ kind: "launcher", id: "launcher-visible", path: "/tmp/project-a" },
		]);
	});

	test("creates launcher-only and flow-only run views when no owner row joins", () => {
		const service = new CodexRunObserverService();
		const runs = service.project({
			agentTasks: [
				launcherTask({
					id: "launcher-only",
					status: "completed",
					agent_backend: "codex",
				}),
			],
			openClawTasks: [],
			taskFlows: [
				taskFlow({
					flowId: "flow-only",
					status: "waiting",
					tasks: [],
					taskCount: 0,
				}),
			],
		});

		expect(runs.map((run) => run.source.kind).sort()).toEqual([
			"launcher",
			"taskflow",
		]);
		expect(runs.find((run) => run.source.kind === "launcher")?.status).toBe(
			"succeeded",
		);
		expect(runs.find((run) => run.source.kind === "taskflow")?.status).toBe(
			"waiting",
		);
	});

	test("uses non-Codex launcher rows only as join metadata", () => {
		const service = new CodexRunObserverService();

		const launcherOnlyRuns = service.project({
			agentTasks: [
				launcherTask({ id: "claude-only", agent_backend: "claude" }),
			],
			openClawTasks: [],
			taskFlows: [],
		});
		expect(launcherOnlyRuns).toEqual([]);

		const [joinedRun] = service.project({
			agentTasks: [
				launcherTask({
					id: "claude-join",
					agent_backend: "claude",
					session_id: "agent-project-a",
				}),
			],
			openClawTasks: [
				openClawTask({ childSessionKey: "session:agent-project-a" }),
			],
			taskFlows: [],
		});
		expect(joinedRun?.source).toEqual({ kind: "openclaw-task", id: "oc-1" });
		expect(joinedRun?.workspacePath).toBe("/tmp/project-a");
	});

	test("orders projection deterministically by active state, activity, and run id", () => {
		const service = new CodexRunObserverService();
		const inputs = {
			agentTasks: [],
			openClawTasks: [
				openClawTask({
					taskId: "done",
					status: "succeeded",
					lastEventAt: 20_000,
				}),
				openClawTask({
					taskId: "running-b",
					status: "running",
					lastEventAt: 10_000,
				}),
				openClawTask({
					taskId: "running-a",
					status: "running",
					lastEventAt: 10_000,
				}),
			],
			taskFlows: [],
		};

		const first = service.project(inputs).map((run) => run.runId);
		const second = service.project(inputs).map((run) => run.runId);

		expect(first).toEqual(["running-a", "running-b", "done"]);
		expect(second).toEqual(first);
	});

	test("does not mutate inputs or import execution/file-watching dependencies", () => {
		const service = new CodexRunObserverService();
		const inputTask = openClawTask();
		const before = JSON.stringify(inputTask);

		service.project({
			agentTasks: [],
			openClawTasks: [inputTask],
			taskFlows: [],
		});

		expect(JSON.stringify(inputTask)).toBe(before);

		const source = fs.readFileSync(
			path.join(process.cwd(), "src/services/codex-run-observer-service.ts"),
			"utf-8",
		);
		expect(source).not.toMatch(/node:child_process|execFile|spawn\(/);
		expect(source).not.toMatch(/from "node:fs"|fs\.watch|watch\(/);
		expect(source).not.toMatch(/CodexRunObserverService.*refresh/s);
	});
});
