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
			(provider as unknown as { _filePath: string | null })._filePath =
				tasksFile;
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
			(provider as unknown as { _filePath: string | null })._filePath =
				tasksFile;
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
			(provider as unknown as { _filePath: string | null })._filePath =
				tasksFile;
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
});
