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

	test("projects launcher workflow contract fields without exposing callback URLs", () => {
		const service = new CodexRunObserverService();
		const [run] = service.project({
			agentTasks: [
				launcherTask({
					id: "launcher-visible",
					task_id: "task-123",
					flow_id: "flow-123",
					project_id: "project-a",
					source_authority: "launcher",
					owner_kind: "launcher",
					callback_url: "https://hub.example.test/hooks/secret-token",
					exec_mode: "spoke",
					exec_node: "Mike MacBook Pro",
					exec_host: "Mike MacBook Pro",
					exec_cwd: "/Users/ostehost/projects/project-a",
					artifact_paths: ["/tmp/artifact.md"],
					pending_review_path: "/tmp/oste-pending-review/task-123.json",
					pending_fixup_path: "/tmp/oste-pending-fixup/task-123.json",
					start_sha: "abc1234",
					review_state: "pending",
					fixup_state: "none",
					agent_backend: "codex",
				}),
			],
			openClawTasks: [],
			taskFlows: [],
		});

		expect(run).toMatchObject({
			taskId: "task-123",
			flowId: "flow-123",
			execMode: "spoke",
			execNodeId: "Mike MacBook Pro",
			execNodeName: "Mike MacBook Pro",
			host: "Mike MacBook Pro",
			workspacePath: "/Users/ostehost/projects/project-a",
			sourceAuthority: "launcher",
			ownerKind: "launcher",
			callbackPresent: true,
			reviewState: "pending",
			fixupState: "none",
		});
		expect(JSON.stringify(run)).not.toContain("secret-token");
		expect(run?.artifactPaths).toContain("/tmp/artifact.md");
		expect(run?.artifactPaths).toContain(
			"/tmp/oste-pending-review/task-123.json",
		);
		expect(run?.evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					label: "Pending review",
					value: "/tmp/oste-pending-review/task-123.json",
					kind: "file",
				}),
				expect.objectContaining({
					label: "Pending fixup",
					value: "/tmp/oste-pending-fixup/task-123.json",
					kind: "file",
				}),
				expect.objectContaining({
					label: "Start commit",
					value: "abc1234",
					kind: "commit",
				}),
			]),
		);
		expect(run?.fieldSources.execMode).toEqual([
			{ kind: "launcher", id: "launcher-visible", path: "/tmp/project-a" },
		]);
		expect(run?.fieldSources.evidence).toEqual([
			{ kind: "launcher", id: "launcher-visible", path: "/tmp/project-a" },
		]);
		expect(run?.fieldSources.callbackPresent).toEqual([
			{ kind: "launcher", id: "launcher-visible", path: "/tmp/project-a" },
		]);
	});

	test("projects node host as execution node name when exec_node is absent", () => {
		const service = new CodexRunObserverService();
		const [run] = service.project({
			agentTasks: [
				launcherTask({
					id: "node-visible",
					task_id: "node-visible",
					exec_mode: "hub",
					exec_node: null,
					exec_host: "Mike's MacBook Pro",
					exec_cwd: "/Users/ostehost/projects/ghostty-launcher",
					project_dir: "/Users/ostehost/projects/ghostty-launcher",
					agent_backend: "codex",
				}),
			],
			openClawTasks: [],
			taskFlows: [],
		});

		expect(run).toMatchObject({
			taskId: "node-visible",
			execMode: "hub",
			execNodeName: "Mike's MacBook Pro",
			host: "Mike's MacBook Pro",
			workspacePath: "/Users/ostehost/projects/ghostty-launcher",
		});
		expect(run?.execNodeId).toBeUndefined();
	});

	test("keeps OpenClaw as source authority while launcher adds node execution detail", () => {
		const service = new CodexRunObserverService();
		const [run] = service.project({
			agentTasks: [
				launcherTask({
					id: "oc-node-task",
					session_id: "agent-node-task",
					exec_mode: "spoke",
					exec_node: "node-1",
					exec_host: "Mike MacBook Pro",
					callback_url: "https://hub.example.test/hooks/callback",
					agent_backend: "claude",
				}),
			],
			openClawTasks: [
				openClawTask({
					taskId: "oc-node-task",
					childSessionKey: "session:agent-node-task",
					execMode: "spoke",
					execNodeId: "node-1",
					execNodeName: "Mike MacBook Pro",
					nodeConnected: true,
					sourceAuthority: "openclaw",
					ownerKind: "openclaw",
				}),
			],
			taskFlows: [],
		});

		expect(run).toMatchObject({
			source: { kind: "openclaw-task", id: "oc-node-task" },
			sourceAuthority: "openclaw",
			ownerKind: "openclaw",
			execMode: "spoke",
			execNodeId: "node-1",
			execNodeName: "Mike MacBook Pro",
			nodeConnected: true,
			host: "Mike MacBook Pro",
			callbackPresent: true,
		});
		expect(run?.fieldSources.sourceAuthority).toEqual([
			{ kind: "openclaw-task", id: "oc-node-task" },
		]);
		expect(run?.fieldSources.callbackPresent).toEqual([
			{ kind: "launcher", id: "oc-node-task", path: "/tmp/project-a" },
		]);
	});

	test("projects launcher role as read-only process metadata", () => {
		const service = new CodexRunObserverService();
		const [run] = service.project({
			agentTasks: [
				launcherTask({
					id: "oc-review-task",
					session_id: "agent-review-task",
					role: "reviewer",
					agent_backend: "claude",
				}),
			],
			openClawTasks: [
				openClawTask({
					taskId: "oc-review-task",
					childSessionKey: "session:agent-review-task",
					ownerKind: "openclaw",
				}),
			],
			taskFlows: [],
		});

		expect(run?.source).toEqual({
			kind: "openclaw-task",
			id: "oc-review-task",
		});
		expect(run?.role).toBe("reviewer");
		expect(run?.ownerKind).toBe("openclaw");
		expect(run?.fieldSources.role).toEqual([
			{ kind: "launcher", id: "oc-review-task", path: "/tmp/project-a" },
		]);
	});

	test("projects source-owned Claude launcher rows as standalone runs", () => {
		const service = new CodexRunObserverService();

		const sourceOwnedVariants: Array<Partial<AgentTask>> = [
			{ source_authority: "launcher" },
			{ owner_kind: "launcher" },
			{ owner_kind: "openclaw" },
			{ owner_actions: [{ name: "approve" }] },
			{ workflow_run: { id: "wf-1" } },
			{ provenance: { source_ref: "launcher:abc" } },
		];

		for (const overrides of sourceOwnedVariants) {
			const runs = service.project({
				agentTasks: [
					launcherTask({
						id: "claude-source-owned",
						agent_backend: "claude",
						session_id: "claude-source-owned-session",
						...overrides,
					}),
				],
				openClawTasks: [],
				taskFlows: [],
			});

			expect(runs).toHaveLength(1);
			expect(runs[0]?.source).toEqual({
				kind: "launcher",
				id: "claude-source-owned",
				path: "/tmp/project-a",
			});
			expect(runs[0]?.runtime).toBe("claude");
		}

		const camelRuns = service.project({
			agentTasks: [
				{
					...launcherTask({
						id: "claude-source-owned-camel",
						agent_backend: "claude",
						session_id: "claude-source-owned-camel-session",
					}),
					sourceAuthority: "launcher",
					ownerKind: "launcher",
				} as AgentTask,
			],
			openClawTasks: [],
			taskFlows: [],
		});

		expect(camelRuns).toHaveLength(1);
		expect(camelRuns[0]?.source.kind).toBe("launcher");
	});

	test("excludes Claude launcher rows that lack source-owned metadata", () => {
		const service = new CodexRunObserverService();
		const runs = service.project({
			agentTasks: [
				launcherTask({
					id: "plain-claude-task",
					agent_backend: "claude",
					session_id: "plain-claude-session",
				}),
				launcherTask({
					id: "empty-owner-actions",
					agent_backend: "claude",
					session_id: "empty-owner-actions-session",
					owner_actions: [],
					provenance: {},
				}),
			],
			openClawTasks: [],
			taskFlows: [],
		});

		expect(runs).toEqual([]);
	});

	test("joins launcher metadata when the session prefix is on the launcher side", () => {
		const service = new CodexRunObserverService();
		const [run] = service.project({
			agentTasks: [
				launcherTask({
					id: "launcher-prefixed",
					session_id: "session:agent-project-a",
				}),
			],
			openClawTasks: [
				openClawTask({
					taskId: "oc-prefix-reverse",
					childSessionKey: "agent-project-a",
				}),
			],
			taskFlows: [],
		});

		expect(run?.source).toEqual({
			kind: "openclaw-task",
			id: "oc-prefix-reverse",
		});
		expect(run?.mergedFrom).toContainEqual({
			kind: "launcher",
			id: "launcher-prefixed",
			path: "/tmp/project-a",
		});
		expect(run?.workspacePath).toBe("/tmp/project-a");
		expect(run?.model).toBe("gpt-5.5");
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
		expect(runs.find((run) => run.source.kind === "launcher")?.branch).toBe(
			undefined,
		);
	});

	test("uses non-Codex launcher rows only as join metadata", () => {
		const service = new CodexRunObserverService();

		const launcherOnlyRuns = service.project({
			agentTasks: [
				launcherTask({
					id: "codex-review-claude-task",
					agent_backend: "claude",
					session_id: "codex-ish-session-name",
				}),
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

	test("does not collapse launcher-only Codex runs by shared project path", () => {
		const service = new CodexRunObserverService();

		const runs = service.project({
			agentTasks: [
				launcherTask({
					id: "codex-a",
					session_id: "session-a",
					agent_backend: "codex",
					project_dir: "/tmp/shared-project",
				}),
				launcherTask({
					id: "codex-b",
					session_id: "session-b",
					agent_backend: "codex",
					project_dir: "/tmp/shared-project",
				}),
			],
			openClawTasks: [],
			taskFlows: [],
		});

		expect(runs.map((run) => run.runId).sort()).toEqual(["codex-a", "codex-b"]);
		expect(runs).toHaveLength(2);
	});

	test("does not collapse launcher-only Codex runs by shared session identity", () => {
		const service = new CodexRunObserverService();

		const runs = service.project({
			agentTasks: [
				launcherTask({
					id: "codex-a",
					session_id: "agent-shared",
					agent_backend: "codex",
					project_dir: "/tmp/project-a",
				}),
				launcherTask({
					id: "codex-b",
					session_id: "agent-shared",
					agent_backend: "codex",
					project_dir: "/tmp/project-b",
				}),
			],
			openClawTasks: [],
			taskFlows: [],
		});

		expect(runs.map((run) => run.runId).sort()).toEqual(["codex-a", "codex-b"]);
		expect(runs).toHaveLength(2);
	});

	test("does not collapse launcher-only Codex runs by title matching another launcher id", () => {
		const service = new CodexRunObserverService();

		const runs = service.project({
			agentTasks: [
				launcherTask({
					id: "codex-a",
					agent_backend: "codex",
					prompt_summary: "codex-b",
				}),
				launcherTask({
					id: "codex-b",
					agent_backend: "codex",
					prompt_summary: "Independent Codex task",
				}),
			],
			openClawTasks: [],
			taskFlows: [],
		});

		expect(runs.map((run) => run.runId).sort()).toEqual(["codex-a", "codex-b"]);
		expect(runs).toHaveLength(2);
	});

	test("does not join launcher metadata to an owner row by display title", () => {
		const service = new CodexRunObserverService();

		const runs = service.project({
			agentTasks: [
				launcherTask({
					id: "launcher-unrelated",
					agent_backend: "codex",
					session_id: "agent-unrelated",
					project_dir: "/tmp/unrelated-project",
					prompt_summary: "Unrelated launcher prompt",
				}),
			],
			openClawTasks: [
				openClawTask({
					taskId: "real-owner",
					label: "launcher-unrelated",
					childSessionKey: "session:real-owner-session",
				}),
			],
			taskFlows: [],
		});

		const ownerRun = runs.find((run) => run.taskId === "real-owner");
		const launcherRun = runs.find((run) => run.source.kind === "launcher");
		expect(runs).toHaveLength(2);
		expect(ownerRun?.title).toBe("launcher-unrelated");
		expect(ownerRun?.workspacePath).toBeUndefined();
		expect(ownerRun?.model).toBeUndefined();
		expect(ownerRun?.mergedFrom).toEqual([
			{ kind: "openclaw-task", id: "real-owner" },
		]);
		expect(launcherRun?.runId).toBe("launcher-unrelated");
	});

	test("does not join launcher metadata to an owner row by substring session identity", () => {
		const service = new CodexRunObserverService();

		const runs = service.project({
			agentTasks: [
				launcherTask({
					id: "launcher-abc",
					agent_backend: "codex",
					session_id: "abc",
					project_dir: "/tmp/substring-project",
					model: "gpt-5.5",
					stream_file: "/tmp/substring-project/stream.jsonl",
				}),
			],
			openClawTasks: [
				openClawTask({
					taskId: "owner-abc-extra",
					childSessionKey: "session:abc-extra",
				}),
			],
			taskFlows: [],
		});

		const ownerRun = runs.find((run) => run.taskId === "owner-abc-extra");
		const launcherRun = runs.find((run) => run.source.kind === "launcher");
		expect(runs).toHaveLength(2);
		expect(ownerRun?.mergedFrom).toEqual([
			{ kind: "openclaw-task", id: "owner-abc-extra" },
		]);
		expect(ownerRun?.workspacePath).toBeUndefined();
		expect(ownerRun?.model).toBeUndefined();
		expect(ownerRun?.artifactPaths).toBeUndefined();
		expect(launcherRun?.runId).toBe("launcher-abc");
	});

	test("does not join TaskFlow children to OpenClaw tasks by human label", () => {
		const service = new CodexRunObserverService();

		const runs = service.project({
			agentTasks: [],
			openClawTasks: [
				openClawTask({
					taskId: "real-task",
					label: "Shared label",
				}),
			],
			taskFlows: [
				taskFlow({
					tasks: [
						openClawTask({
							taskId: "flow-child",
							label: "Shared label",
						}),
					],
				}),
			],
		});

		const realTask = runs.find((run) => run.taskId === "real-task");
		const flowChild = runs.find((run) => run.taskId === "flow-child");
		expect(runs).toHaveLength(2);
		expect(realTask?.flowId).toBeUndefined();
		expect(flowChild?.flowId).toBe("flow-1");
	});

	test("preserves official Symphony phase language separately from display status", () => {
		const service = new CodexRunObserverService();
		const [run] = service.project({
			agentTasks: [],
			openClawTasks: [
				openClawTask({
					status: "LaunchingAgentProcess" as unknown as OpenClawTask["status"],
				}),
			],
			taskFlows: [],
		});

		expect(run?.sourceStatus).toBe("LaunchingAgentProcess");
		expect(run?.status).toBe("running");
		expect(run?.phase).toBe("LaunchingAgentProcess");
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
