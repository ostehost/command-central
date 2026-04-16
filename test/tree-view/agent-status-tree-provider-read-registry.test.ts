/**
 * AgentStatusTreeProvider — readRegistry tests (isolated)
 *
 * EXTRACTED from agent-status-tree-provider.test.ts to escape intra-suite
 * pollution. Two sibling files (agent-status-handoff-file.test.ts and
 * agent-status-review-and-handoff.test.ts) clobber
 * `AgentStatusTreeProvider.prototype.readRegistry` at module scope to suppress
 * their constructor's tasks.json read. Because bun loads test files into a
 * shared worker, the giant test file captured a stub instead of the real
 * method when these polluters loaded first.
 *
 * Fix: the real method is now captured at PRELOAD time
 * (`test/setup/global-test-cleanup.ts`) and stashed on globalThis. These
 * tests read it from there, so they're immune to prototype pollution.
 *
 * Do NOT clobber the prototype in this file — use per-instance overrides only.
 */

import { describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Module mocks (must be set up before importing source) ───────────────

const execFileSyncMock = mock((...fnArgs: unknown[]) =>
	realChildProcess.execFileSync(
		fnArgs[0] as string,
		fnArgs[1] as string[] | undefined,
		fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
	),
);

mock.module("node:child_process", () => ({
	...realChildProcess,
	execFileSync: execFileSyncMock,
}));

mock.module("../../src/utils/port-detector.js", () => ({
	detectListeningPorts: mock(() => []),
	detectListeningPortsAsync: mock(async () => []),
}));

import {
	AgentStatusTreeProvider,
	type TaskRegistry,
} from "../../src/providers/agent-status-tree-provider.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// ── Capture the real readRegistry from the global preload ───────────────
// See test/setup/global-test-cleanup.ts for where this is stashed. Falling
// back to the prototype lets this file work even if the preload changes.
const realReadRegistry = ((globalThis as Record<string, unknown>)[
	"__realAgentStatusReadRegistry"
] ?? AgentStatusTreeProvider.prototype.readRegistry) as () => TaskRegistry;

// ── Tests ───────────────────────────────────────────────────────────────

describe("AgentStatusTreeProvider.readRegistry (real impl)", () => {
	function makeProvider(): AgentStatusTreeProvider {
		setupVSCodeMock();
		const provider = new AgentStatusTreeProvider();
		// Override per-instance so the constructor's reload doesn't blow up.
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
