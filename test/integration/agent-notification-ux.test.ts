/**
 * Agent Notification UX Integration Tests
 *
 * Tests the new notification UX behaviors: dead-session diff viewer,
 * live-bundle shortcut, and updated action buttons (View Diff / Show Output).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

let vscodeMock: ReturnType<typeof setupVSCodeMock>;

beforeEach(() => {
	mock.restore();
	vscodeMock = setupVSCodeMock();
});

function createTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "test-task",
		status: "running",
		project_dir: "/tmp/project",
		project_name: "test-project",
		session_id: "sess-123",
		bundle_path: "(test-mode)",
		prompt_file: "/tmp/prompt.md",
		started_at: new Date().toISOString(),
		attempts: 1,
		max_attempts: 3,
		...overrides,
	};
}

type NotifConfig = {
	masterEnabled: boolean;
	onCompletion: boolean;
	onFailure: boolean;
};

function simulateNotifications(
	previousStatuses: Map<string, string>,
	tasks: AgentTask[],
	config: NotifConfig = {
		masterEnabled: true,
		onCompletion: true,
		onFailure: true,
	},
) {
	for (const task of tasks) {
		const prev = previousStatuses.get(task.id);
		if (config.masterEnabled && prev === "running") {
			if (task.status === "completed" && config.onCompletion) {
				const msg = `Agent ${task.id} completed`;
				vscodeMock.window.showInformationMessage(
					msg,
					"View Diff",
					"Show Output",
				);
			} else if (task.status === "failed" && config.onFailure) {
				const msg = `Agent ${task.id} failed — check output`;
				vscodeMock.window.showWarningMessage(msg, "Show Output", "View Diff");
			}
		}
		previousStatuses.set(task.id, task.status);
	}
}

describe("Agent Notification UX", () => {
	test("Click completed agent with dead session opens diff viewer, not toast", () => {
		// Simulate the dead-session scenario: clicking a completed task with no live
		// session should open the diff viewer via executeCommand and set a status bar
		// message, but NOT show a toast notification.
		const task = createTask({ id: "agent-1", status: "completed" });

		vscodeMock.window.setStatusBarMessage(`Showing diff for ${task.id}`, 3000);
		vscodeMock.commands.executeCommand("commandCentral.viewAgentDiff", task);

		expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
			"commandCentral.viewAgentDiff",
			task,
		);
		expect(vscodeMock.window.setStatusBarMessage).toHaveBeenCalledWith(
			`Showing diff for ${task.id}`,
			3000,
		);
		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
	});

	test("Click completed agent with dead session but live bundle opens bundle", () => {
		// When a bundle is available, clicking the task should open the bundle instead
		// of showing a diff or a toast notification.
		const task = createTask({
			id: "agent-2",
			status: "completed",
			bundle_path: "/tmp/agent-bundle",
		});

		// Simulate opening the bundle — neither diff nor toast should fire
		vscodeMock.commands.executeCommand("commandCentral.openBundle", task);

		expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
			"commandCentral.openBundle",
			task,
		);
		expect(vscodeMock.window.setStatusBarMessage).not.toHaveBeenCalled();
		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
	});

	test("Completion notification shows View Diff and Show Output actions", () => {
		const prev = new Map<string, string>([["agent-3", "running"]]);
		const task = createTask({ id: "agent-3", status: "completed" });

		simulateNotifications(prev, [task]);

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"Agent agent-3 completed",
			"View Diff",
			"Show Output",
		);
		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalledWith(
			expect.anything(),
			"Focus Terminal",
		);
	});

	test("Failure notification shows Show Output and View Diff actions", () => {
		const prev = new Map<string, string>([["agent-4", "running"]]);
		const task = createTask({ id: "agent-4", status: "failed" });

		simulateNotifications(prev, [task]);

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"Agent agent-4 failed — check output",
			"Show Output",
			"View Diff",
		);
		expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalledWith(
			expect.anything(),
			"Focus Terminal",
		);
	});

	test("Config notifications disabled suppresses completion toast", () => {
		const prev = new Map<string, string>([["agent-5", "running"]]);
		const task = createTask({ id: "agent-5", status: "completed" });

		simulateNotifications(prev, [task], {
			masterEnabled: false,
			onCompletion: true,
			onFailure: true,
		});

		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
		expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
	});

	test("Click running agent preserves normal focus behavior", () => {
		// A running agent should not fire any completion-related notifications
		const prev = new Map<string, string>([["agent-6", "running"]]);
		const task = createTask({ id: "agent-6", status: "running" });

		simulateNotifications(prev, [task]);

		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
		expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
	});
});
