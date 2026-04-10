/**
 * AgentStatusBar count calculation tests
 *
 * Verifies that the status bar correctly reflects the running count,
 * including discovered (non-launcher) agents. This guards against the
 * regression where getTasks() excluded discovered agents, causing the
 * status bar and sidebar to show different running counts.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

setupVSCodeMock();

import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";
import { AgentStatusBar } from "../../src/services/agent-status-bar.js";

function makeTask(id: string, status: AgentTask["status"]): AgentTask {
	return {
		id,
		status,
		project_dir: "/mock/project",
		project_name: "project",
		session_id: `session-${id}`,
		bundle_path: "",
		prompt_file: "",
		started_at: new Date().toISOString(),
		attempts: 0,
		max_attempts: 3,
	};
}

describe("AgentStatusBar count calculation", () => {
	let statusBar: AgentStatusBar;
	let mockItem: {
		text: string;
		tooltip: unknown;
		backgroundColor: unknown;
		show: ReturnType<typeof mock>;
		hide: ReturnType<typeof mock>;
		dispose: ReturnType<typeof mock>;
		command: string;
	};

	beforeEach(() => {
		mockItem = {
			text: "",
			tooltip: undefined,
			backgroundColor: undefined,
			show: mock(),
			hide: mock(),
			dispose: mock(),
			command: "",
		};

		// Patch createStatusBarItem to return our mock
		const vscode = require("vscode");
		vscode.window.createStatusBarItem = mock(() => mockItem);

		statusBar = new AgentStatusBar();
	});

	test("hides when task list is empty", () => {
		statusBar.update([]);
		expect(mockItem.hide).toHaveBeenCalled();
		expect(mockItem.show).not.toHaveBeenCalled();
	});

	test("shows running count for a single running launcher task", () => {
		statusBar.update([makeTask("a", "running")]);
		expect(mockItem.text).toContain("1 working");
		expect(mockItem.show).toHaveBeenCalled();
	});

	test("counts multiple running tasks correctly", () => {
		statusBar.update([
			makeTask("a", "running"),
			makeTask("b", "running"),
			makeTask("c", "completed"),
		]);
		expect(mockItem.text).toContain("2 working");
		expect(mockItem.text).toContain("1 done");
	});

	test("counts synthetic discovered-agent tasks as running", () => {
		// Synthetic tasks created by getTasks() for discovered agents
		// have status "running" and id prefixed with "discovered-"
		const discovered = makeTask("discovered-1234", "running");
		const launcher = makeTask("launcher-task-1", "completed");

		statusBar.update([discovered, launcher]);
		expect(mockItem.text).toContain("1 working");
		expect(mockItem.text).toContain("1 done");
	});

	test("running count matches sidebar when discovered agents are present", () => {
		// Simulate: 1 launcher running + 2 discovered running + 1 completed
		// Expected sidebar summary: "4 running · 1 completed"  (but sidebar
		// counts discovered separately — this test checks the status bar side)
		const tasks: AgentTask[] = [
			makeTask("launcher-1", "running"),
			makeTask("discovered-100", "running"),
			makeTask("discovered-200", "running"),
			makeTask("launcher-2", "completed"),
		];

		statusBar.update(tasks);
		expect(mockItem.text).toContain("3 working");
		expect(mockItem.text).toContain("1 done");
	});

	test("shows only completed when all tasks are done", () => {
		statusBar.update([makeTask("a", "completed"), makeTask("b", "completed")]);
		expect(mockItem.text).toContain("2 done");
		expect(mockItem.show).toHaveBeenCalled();
	});

	test("shows failed with warning icon when no running tasks", () => {
		statusBar.update([makeTask("a", "failed"), makeTask("b", "completed")]);
		expect(mockItem.text).toContain("$(warning)");
		expect(mockItem.text).toContain("1 attention");
		expect(mockItem.text).toContain("1 done");
	});

	test("counts completed_dirty/completed_stale as limbo and stopped as attention", () => {
		statusBar.update([
			makeTask("c", "completed_dirty"),
			makeTask("a", "completed_stale"),
			makeTask("b", "stopped"),
		]);
		expect(mockItem.text).toContain("2 limbo");
		expect(mockItem.text).toContain("1 attention");
		expect(mockItem.text).not.toContain("done");
	});

	test("treats killed as failed", () => {
		statusBar.update([makeTask("a", "killed"), makeTask("b", "completed")]);
		expect(mockItem.text).toContain("$(warning)");
		expect(mockItem.text).toContain("1 attention");
		expect(mockItem.text).toContain("1 done");
	});
});
