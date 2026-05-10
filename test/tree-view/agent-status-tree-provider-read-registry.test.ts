/**
 * AgentStatusTreeProvider — readRegistry tests (isolated)
 *
 * Uses the shared tree-view helper so this file participates in the same
 * module-mock graph as the rest of the tree-view suite. Importing the provider
 * directly from source here lets Bun cache a different child_process/fs world
 * for AgentStatusTreeProvider, which makes sibling files silently fall back to
 * real git/tmux calls in mixed runs.
 *
 * The real readRegistry implementation is stashed on globalThis before the
 * helper clobbers the prototype for constructor safety.
 */

import { describe, expect, test } from "bun:test";

const fs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof import("node:fs");

import * as path from "node:path";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";
import {
	AgentStatusTreeProvider,
	type TaskRegistry,
} from "./_helpers/agent-status-tree-provider-test-base.js";

const realReadRegistry = ((globalThis as Record<string, unknown>)[
	"__realAgentStatusReadRegistry"
] ?? AgentStatusTreeProvider.prototype.readRegistry) as () => TaskRegistry;

describe("AgentStatusTreeProvider.readRegistry (real impl)", () => {
	function makeProvider(): AgentStatusTreeProvider {
		setupVSCodeMock();
		const provider = new AgentStatusTreeProvider();
		provider.readRegistry = () => ({ version: 2, tasks: {} });
		return provider;
	}

	function setProviderTaskFiles(
		provider: AgentStatusTreeProvider,
		paths: string[],
	): void {
		(provider as unknown as { _filePath: string | null })._filePath =
			paths[0] ?? null;
		(provider as unknown as { _filePaths: string[] })._filePaths = paths;
	}

	test("preserves completed_dirty and maps unknown statuses to stopped", () => {
		const provider = makeProvider();
		const tmpDir = fs.mkdtempSync("/tmp/cc-agent-status-");
		const tasksFile = path.join(tmpDir, "tasks.json");
		fs.writeFileSync(
			tasksFile,
			JSON.stringify({
				version: 2,
				tasks: {
					dirty: {
						id: "dirty",
						status: "completed_dirty",
						project_dir: "/Users/test/projects/my-app",
						project_name: "My App",
						session_id: "agent-my-app",
						bundle_path: "/Applications/Projects/My App.app",
						prompt_file: "/tmp/task.md",
						started_at: "2026-02-25T08:00:00Z",
						attempts: 1,
						max_attempts: 3,
					},
					weird: {
						id: "weird",
						status: "mystery_state",
						project_dir: "/Users/test/projects/my-app",
						project_name: "My App",
						session_id: "agent-my-app-weird",
						bundle_path: "/Applications/Projects/My App.app",
						prompt_file: "/tmp/task.md",
						started_at: "2026-02-25T08:00:00Z",
						attempts: 1,
						max_attempts: 3,
					},
				},
			}),
		);

		try {
			setProviderTaskFiles(provider, [tasksFile]);
			const registry = realReadRegistry.call(provider);
			expect(registry.tasks["dirty"]?.status).toBe("completed_dirty");
			expect(registry.tasks["weird"]?.status).toBe("stopped");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			provider.dispose();
		}
	});

	test("preserves model from tasks.json", () => {
		const provider = makeProvider();
		const tmpDir = fs.mkdtempSync("/tmp/cc-agent-status-");
		const tasksFile = path.join(tmpDir, "tasks.json");
		fs.writeFileSync(
			tasksFile,
			JSON.stringify({
				version: 2,
				tasks: {
					explicitModel: {
						id: "explicitModel",
						status: "running",
						project_dir: "/Users/test/projects/my-app",
						project_name: "My App",
						session_id: "agent-my-app-model",
						bundle_path: "/Applications/Projects/My App.app",
						prompt_file: "/tmp/task.md",
						started_at: "2026-02-25T08:00:00Z",
						attempts: 1,
						max_attempts: 3,
						model: "anthropic/claude-opus-4-6",
					},
				},
			}),
		);

		try {
			setProviderTaskFiles(provider, [tasksFile]);
			const registry = realReadRegistry.call(provider);
			expect(registry.tasks["explicitModel"]?.model).toBe(
				"anthropic/claude-opus-4-6",
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			provider.dispose();
		}
	});

	test("preserves actual_model from tasks.json", () => {
		const provider = makeProvider();
		const tmpDir = fs.mkdtempSync("/tmp/cc-agent-status-");
		const tasksFile = path.join(tmpDir, "tasks.json");
		fs.writeFileSync(
			tasksFile,
			JSON.stringify({
				version: 2,
				tasks: {
					fallbackTask: {
						id: "fallbackTask",
						status: "running",
						project_dir: "/Users/test/projects/my-app",
						project_name: "My App",
						session_id: "agent-my-app-fallback",
						bundle_path: "/Applications/Projects/My App.app",
						prompt_file: "/tmp/task.md",
						started_at: "2026-02-25T08:00:00Z",
						attempts: 1,
						max_attempts: 3,
						model: "anthropic/claude-opus-4-6",
						actual_model: "google/gemini-2.5-flash-lite",
					},
				},
			}),
		);

		try {
			setProviderTaskFiles(provider, [tasksFile]);
			const registry = realReadRegistry.call(provider);
			expect(registry.tasks["fallbackTask"]?.model).toBe(
				"anthropic/claude-opus-4-6",
			);
			expect(registry.tasks["fallbackTask"]?.actual_model).toBe(
				"google/gemini-2.5-flash-lite",
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			provider.dispose();
		}
	});

	test("preserves node execution metadata from tasks.json", () => {
		const provider = makeProvider();
		const tmpDir = fs.mkdtempSync("/tmp/cc-agent-status-");
		const tasksFile = path.join(tmpDir, "tasks.json");
		fs.writeFileSync(
			tasksFile,
			JSON.stringify({
				version: 2,
				tasks: {
					nodeVisible: {
						id: "nodeVisible",
						status: "running",
						project_dir: "/Users/ostehost/projects/command-central",
						project_name: "command-central",
						session_id: "agent-command-central",
						terminal_backend: "tmux",
						tmux_socket:
							"/Users/ostehost/.local/state/ghostty-launcher/tmux/command-central.sock",
						tmux_conf:
							"/Users/ostehost/.local/state/ghostty-launcher/tmux/command-central.conf",
						tmux_window_id: "@5",
						tmux_pane_id: "%5",
						bundle_path: "/Applications/Projects/command-central.app",
						ghostty_bundle_id: "dev.partnerai.ghostty.command-central",
						prompt_file: "/tmp/task.md",
						started_at: "2026-05-08T20:13:50Z",
						attempts: 1,
						max_attempts: 3,
						exec_mode: "spoke",
						exec_node: "Mike MacBook Pro",
						exec_host: "Mike's MacBook Pro",
						exec_visible: true,
						exec_cwd: "/Users/ostehost/projects/command-central",
						pending_review_path: "/tmp/oste-pending-review/nodeVisible.json",
						review_state: "pending",
					},
				},
			}),
		);

		try {
			setProviderTaskFiles(provider, [tasksFile]);
			const registry = realReadRegistry.call(provider);
			const task = registry.tasks["nodeVisible"];
			expect(task?.exec_mode).toBe("spoke");
			expect(task?.exec_node).toBe("Mike MacBook Pro");
			expect(task?.exec_host).toBe("Mike's MacBook Pro");
			expect(task?.exec_visible).toBe(true);
			expect(task?.exec_cwd).toBe("/Users/ostehost/projects/command-central");
			expect(task?.pending_review_path).toBe(
				"/tmp/oste-pending-review/nodeVisible.json",
			);
			expect(task?.review_state).toBe("pending");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			provider.dispose();
		}
	});

	test("preserves Symphony owner metadata from tasks.json", () => {
		const provider = makeProvider();
		const tmpDir = fs.mkdtempSync("/tmp/cc-agent-status-");
		const tasksFile = path.join(tmpDir, "tasks.json");
		fs.writeFileSync(
			tasksFile,
			JSON.stringify({
				version: 2,
				tasks: {
					sourceOwned: {
						task_id: "sourceOwned",
						id: "sourceOwned",
						flow_id: "flow-source",
						project_id: "command-central",
						status: "running",
						source_authority: "launcher",
						owner_kind: "launcher",
						owner_actions: [
							{
								action: "focusTerminal",
								ownerKind: "launcher",
							},
						],
						workflow_run: {
							id: "sourceOwned",
							pending_review_path: "/tmp/oste-pending-review/sourceOwned.json",
						},
						provenance: {
							source_ref: "launcher:sourceOwned",
							adapter_kind: "ghostty-launcher",
						},
						orchestration_mode: "normal",
						agent_mode: "normal",
						team_template: "full",
						project_dir: "/Users/ostehost/projects/command-central",
						project_name: "command-central",
						session_id: "agent-command-central",
						agent_backend: "claude",
						bundle_path: "/Applications/Projects/command-central.app",
						prompt_file: "/tmp/task.md",
						started_at: "2026-05-09T23:57:31Z",
						attempts: 1,
						max_attempts: 3,
					},
				},
			}),
		);

		try {
			setProviderTaskFiles(provider, [tasksFile]);
			const registry = realReadRegistry.call(provider);
			const task = registry.tasks["sourceOwned"];
			expect(task?.task_id).toBe("sourceOwned");
			expect(task?.flow_id).toBe("flow-source");
			expect(task?.project_id).toBe("command-central");
			expect(task?.source_authority).toBe("launcher");
			expect(task?.owner_kind).toBe("launcher");
			expect(task?.owner_actions).toEqual([
				{ action: "focusTerminal", ownerKind: "launcher" },
			]);
			expect(task?.workflow_run).toEqual({
				id: "sourceOwned",
				pending_review_path: "/tmp/oste-pending-review/sourceOwned.json",
			});
			expect(task?.provenance).toEqual({
				source_ref: "launcher:sourceOwned",
				adapter_kind: "ghostty-launcher",
			});
			expect(task?.orchestration_mode).toBe("normal");
			expect(task?.agent_mode).toBe("normal");
			expect(task?.team_template).toBe("full");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			provider.dispose();
		}
	});

	test("merges additional mirrored node task registries", () => {
		const provider = makeProvider();
		const tmpDir = fs.mkdtempSync("/tmp/cc-agent-status-");
		const hubTasksFile = path.join(tmpDir, "hub-tasks.json");
		const nodeTasksFile = path.join(tmpDir, "node-tasks.json");
		fs.writeFileSync(
			hubTasksFile,
			JSON.stringify({
				version: 2,
				tasks: {
					hubTask: {
						id: "hubTask",
						status: "running",
						project_dir: "/Users/ostemini/projects/command-central",
						project_name: "command-central",
						session_id: "agent-hub",
						bundle_path: "",
						prompt_file: "/tmp/hub.md",
						started_at: "2026-05-08T20:13:50Z",
						attempts: 1,
						max_attempts: 3,
					},
				},
			}),
		);
		fs.writeFileSync(
			nodeTasksFile,
			JSON.stringify({
				version: 2,
				tasks: {
					nodeTask: {
						id: "nodeTask",
						status: "running",
						project_dir: "/Users/ostehost/projects/command-central",
						project_name: "command-central",
						visible_project_name: "Command Central Node",
						session_id: "agent-node",
						terminal_backend: "tmux",
						bundle_path: "/Applications/Projects/command-central.app",
						ghostty_bundle_id: "dev.partnerai.ghostty.command-central",
						prompt_file: "/tmp/node.md",
						started_at: "2026-05-08T20:13:50Z",
						attempts: 1,
						max_attempts: 3,
						exec_node: "Mike MacBook Pro",
						exec_host: "Mike's MacBook Pro",
						exec_visible: true,
						exec_cwd: "/Users/ostehost/projects/command-central",
					},
				},
			}),
		);

		try {
			setProviderTaskFiles(provider, [hubTasksFile, nodeTasksFile]);
			const registry = realReadRegistry.call(provider);
			expect(Object.keys(registry.tasks).sort()).toEqual([
				"hubTask",
				"nodeTask",
			]);
			expect(registry.tasks["nodeTask"]?.exec_node).toBe("Mike MacBook Pro");
			expect(registry.tasks["nodeTask"]?.visible_project_name).toBe(
				"Command Central Node",
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			provider.dispose();
		}
	});

	test("canonicalizes symlinked project_dir values from tasks.json", () => {
		const provider = makeProvider();
		const tmpDir = fs.mkdtempSync("/tmp/cc-agent-status-");
		const realProjectDir = path.join(tmpDir, "projects", "alpha");
		const aliasedProjectDir = path.join(tmpDir, "aliases", "alpha");
		const tasksFile = path.join(tmpDir, "tasks.json");
		fs.mkdirSync(realProjectDir, { recursive: true });
		fs.mkdirSync(path.dirname(aliasedProjectDir), { recursive: true });
		fs.symlinkSync(realProjectDir, aliasedProjectDir, "dir");
		fs.writeFileSync(
			tasksFile,
			JSON.stringify({
				version: 2,
				tasks: {
					canonicalized: {
						id: "canonicalized",
						status: "running",
						project_dir: aliasedProjectDir,
						project_name: "Alpha",
						session_id: "agent-alpha",
						bundle_path: "/Applications/Projects/Alpha.app",
						prompt_file: "/tmp/task.md",
						started_at: "2026-02-25T08:00:00Z",
						attempts: 1,
						max_attempts: 3,
					},
				},
			}),
		);

		try {
			setProviderTaskFiles(provider, [tasksFile]);
			const registry = realReadRegistry.call(provider);
			expect(registry.tasks["canonicalized"]?.project_dir).toBe(
				fs.realpathSync(aliasedProjectDir),
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			provider.dispose();
		}
	});
});
