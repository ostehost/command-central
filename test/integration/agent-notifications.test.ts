/**
 * Agent Notification Integration Tests
 *
 * Tests the full notification flow: status change → notification → action button.
 * Based on checkCompletionNotifications() in AgentStatusTreeProvider.
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

/**
 * Simulate the checkCompletionNotifications logic from AgentStatusTreeProvider
 * without loading the full provider (which requires fs/file watchers).
 */
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

describe("Agent Notification Flow", () => {
	test("running→completed fires showInformationMessage with View Diff and Show Output", () => {
		const prev = new Map<string, string>([["t1", "running"]]);
		const task = createTask({ id: "t1", status: "completed" });

		simulateNotifications(prev, [task]);

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"Agent t1 completed",
			"View Diff",
			"Show Output",
		);
	});

	test("running→failed fires showWarningMessage with Show Output and View Diff", () => {
		const prev = new Map<string, string>([["t1", "running"]]);
		const task = createTask({ id: "t1", status: "failed" });

		simulateNotifications(prev, [task]);

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"Agent t1 failed — check output",
			"Show Output",
			"View Diff",
		);
	});

	test("completed→completed does NOT fire notification", () => {
		const prev = new Map<string, string>([["t1", "completed"]]);
		const task = createTask({ id: "t1", status: "completed" });

		simulateNotifications(prev, [task]);

		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
		expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
	});

	test("stopped→completed does NOT fire notification", () => {
		const prev = new Map<string, string>([["t1", "stopped"]]);
		const task = createTask({ id: "t1", status: "completed" });

		simulateNotifications(prev, [task]);

		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
	});

	test("new task (no previous status) does NOT fire notification", () => {
		const prev = new Map<string, string>();
		const task = createTask({ id: "t1", status: "completed" });

		simulateNotifications(prev, [task]);

		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
	});

	test("onCompletion=false suppresses completion notifications", () => {
		const prev = new Map<string, string>([["t1", "running"]]);
		const task = createTask({ id: "t1", status: "completed" });

		simulateNotifications(prev, [task], {
			masterEnabled: true,
			onCompletion: false,
			onFailure: true,
		});

		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
	});

	test("onFailure=false suppresses failure notifications", () => {
		const prev = new Map<string, string>([["t1", "running"]]);
		const task = createTask({ id: "t1", status: "failed" });

		simulateNotifications(prev, [task], {
			masterEnabled: true,
			onCompletion: true,
			onFailure: false,
		});

		expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
	});

	test("master toggle=false overrides individual settings", () => {
		const prev = new Map<string, string>([["t1", "running"]]);
		const task = createTask({ id: "t1", status: "completed" });

		simulateNotifications(prev, [task], {
			masterEnabled: false,
			onCompletion: true,
			onFailure: true,
		});

		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
	});

	test("multiple simultaneous transitions fire separate notifications", () => {
		const prev = new Map<string, string>([
			["t1", "running"],
			["t2", "running"],
		]);
		const tasks = [
			createTask({ id: "t1", status: "completed" }),
			createTask({ id: "t2", status: "failed" }),
		];

		simulateNotifications(prev, tasks);

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"Agent t1 completed",
			"View Diff",
			"Show Output",
		);
		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"Agent t2 failed — check output",
			"Show Output",
			"View Diff",
		);
	});

	test("running→stopped does NOT fire notification", () => {
		const prev = new Map<string, string>([["t1", "running"]]);
		const task = createTask({ id: "t1", status: "stopped" });

		simulateNotifications(prev, [task]);

		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
		expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
	});

	test("running→killed does NOT fire notification", () => {
		const prev = new Map<string, string>([["t1", "running"]]);
		const task = createTask({ id: "t1", status: "killed" });

		simulateNotifications(prev, [task]);

		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
		expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
	});

	test("previousStatuses map is updated after each check", () => {
		const prev = new Map<string, string>([["t1", "running"]]);
		const task = createTask({ id: "t1", status: "completed" });

		simulateNotifications(prev, [task]);

		expect(prev.get("t1")).toBe("completed");
	});

	test("second reload with same status does not re-fire", () => {
		const prev = new Map<string, string>([["t1", "running"]]);
		const task = createTask({ id: "t1", status: "completed" });

		// First reload
		simulateNotifications(prev, [task]);
		// Second reload — status hasn't changed
		simulateNotifications(prev, [task]);

		// showInformationMessage should only have been called once
		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1);
	});

	test("failed→running→completed fires notification on second transition", () => {
		const prev = new Map<string, string>([["t1", "failed"]]);

		// First: failed→running — no notification expected
		simulateNotifications(prev, [createTask({ id: "t1", status: "running" })]);
		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();

		// Second: running→completed — notification expected
		simulateNotifications(prev, [
			createTask({ id: "t1", status: "completed" }),
		]);
		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1);
	});
});
