/**
 * AgentStatusBar Tests
 *
 * Tests status bar text formatting, background color selection,
 * tooltip generation, click command, and disposal.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

let vscodeMock: ReturnType<typeof setupVSCodeMock>;
let mockStatusBarItem: {
	text: string;
	tooltip: unknown;
	command: string;
	backgroundColor: unknown;
	show: ReturnType<typeof mock>;
	hide: ReturnType<typeof mock>;
	dispose: ReturnType<typeof mock>;
};

beforeEach(() => {
	mock.restore();
	mockStatusBarItem = {
		text: "",
		tooltip: "",
		command: "",
		backgroundColor: undefined,
		show: mock(),
		hide: mock(),
		dispose: mock(),
	};
	vscodeMock = setupVSCodeMock();
	// biome-ignore lint/suspicious/noExplicitAny: test mock cast
	vscodeMock.window.createStatusBarItem = mock(() => mockStatusBarItem) as any;
});

function createTask(
	overrides: Partial<AgentTask> & { id: string; status: AgentTask["status"] },
): AgentTask {
	return {
		project_dir: "/tmp/test",
		project_name: "test",
		session_id: "sess-1",
		bundle_path: "(test-mode)",
		prompt_file: "/tmp/prompt.md",
		started_at: new Date().toISOString(),
		attempts: 1,
		max_attempts: 3,
		...overrides,
	};
}

async function loadModule() {
	return await import("../../src/services/agent-status-bar.js");
}

describe("AgentStatusBar", () => {
	test("hides status bar when no tasks", async () => {
		const { AgentStatusBar } = await loadModule();
		const bar = new AgentStatusBar();
		bar.update([]);

		expect(mockStatusBarItem.hide).toHaveBeenCalled();
	});

	test("shows '1 working' with pulse icon for single running task", async () => {
		const { AgentStatusBar } = await loadModule();
		const bar = new AgentStatusBar();

		bar.update([createTask({ id: "t1", status: "running" })]);

		expect(mockStatusBarItem.text).toBe("$(pulse) 1 working");
		expect(mockStatusBarItem.show).toHaveBeenCalled();
	});

	test("shows '2 working' for two running tasks", async () => {
		const { AgentStatusBar } = await loadModule();
		const bar = new AgentStatusBar();

		bar.update([
			createTask({ id: "t1", status: "running" }),
			createTask({ id: "t2", status: "running" }),
		]);

		expect(mockStatusBarItem.text).toBe("$(pulse) 2 working");
	});

	test("shows mixed running + completed with separator", async () => {
		const { AgentStatusBar } = await loadModule();
		const bar = new AgentStatusBar();

		bar.update([
			createTask({ id: "t1", status: "running" }),
			createTask({ id: "t2", status: "completed" }),
		]);

		expect(mockStatusBarItem.text).toBe("$(pulse) 1 working · 1 done");
	});

	test("uses warning background when tasks are running", async () => {
		const { AgentStatusBar } = await loadModule();
		const bar = new AgentStatusBar();

		bar.update([createTask({ id: "t1", status: "running" })]);

		expect(mockStatusBarItem.backgroundColor).toBeDefined();
		expect((mockStatusBarItem.backgroundColor as { id: string }).id).toBe(
			"statusBarItem.warningBackground",
		);
	});

	test("shows all done with check icon and no background", async () => {
		const { AgentStatusBar } = await loadModule();
		const bar = new AgentStatusBar();

		bar.update([
			createTask({ id: "t1", status: "completed" }),
			createTask({ id: "t2", status: "completed" }),
		]);

		expect(mockStatusBarItem.text).toBe("$(check) 2 done");
		expect(mockStatusBarItem.backgroundColor).toBeUndefined();
	});

	test("shows single done count for one completed task", async () => {
		const { AgentStatusBar } = await loadModule();
		const bar = new AgentStatusBar();

		bar.update([createTask({ id: "t1", status: "completed" })]);

		expect(mockStatusBarItem.text).toBe("$(check) 1 done");
	});

	test("shows failed with warning icon and error background", async () => {
		const { AgentStatusBar } = await loadModule();
		const bar = new AgentStatusBar();

		bar.update([createTask({ id: "t1", status: "failed" })]);

		expect(mockStatusBarItem.text).toBe("$(warning) 1 attention");
		expect((mockStatusBarItem.backgroundColor as { id: string }).id).toBe(
			"statusBarItem.errorBackground",
		);
	});

	test("shows mixed failed + completed", async () => {
		const { AgentStatusBar } = await loadModule();
		const bar = new AgentStatusBar();

		bar.update([
			createTask({ id: "t1", status: "failed" }),
			createTask({ id: "t2", status: "completed" }),
		]);

		expect(mockStatusBarItem.text).toBe("$(warning) 1 attention · 1 done");
	});

	test("handles stopped and killed tasks as attention", async () => {
		const { AgentStatusBar } = await loadModule();
		const bar = new AgentStatusBar();

		bar.update([
			createTask({ id: "t1", status: "stopped" }),
			createTask({ id: "t2", status: "killed" }),
		]);

		expect(mockStatusBarItem.text).toBe("$(warning) 2 attention");
		expect(mockStatusBarItem.show).toHaveBeenCalled();
	});

	test("tooltip contains MarkdownString with per-task details", async () => {
		const { AgentStatusBar } = await loadModule();
		const bar = new AgentStatusBar();

		bar.update([
			createTask({ id: "task-alpha", status: "running" }),
			createTask({ id: "task-beta", status: "completed" }),
		]);

		const tooltip = mockStatusBarItem.tooltip as { value: string };
		expect(tooltip).toBeDefined();
		expect(tooltip.value).toContain("task-alpha");
		expect(tooltip.value).toContain("running");
		expect(tooltip.value).toContain("task-beta");
		expect(tooltip.value).toContain("completed");
	});

	test("click command is commandCentral.agentStatus.focus", async () => {
		const { AgentStatusBar } = await loadModule();
		new AgentStatusBar();

		expect(mockStatusBarItem.command).toBe("commandCentral.agentStatus.focus");
	});

	test("constructor sets Left alignment and priority 50", async () => {
		const vscode = (await import("vscode")) as unknown as {
			window: { createStatusBarItem: ReturnType<typeof mock> };
			StatusBarAlignment: { Left: number };
		};

		const { AgentStatusBar } = await loadModule();
		new AgentStatusBar();

		expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(
			vscode.StatusBarAlignment.Left,
			50,
		);
	});

	test("dispose calls statusBarItem.dispose", async () => {
		const { AgentStatusBar } = await loadModule();
		const bar = new AgentStatusBar();
		bar.dispose();

		expect(mockStatusBarItem.dispose).toHaveBeenCalled();
	});

	test("running tasks with failed shows all three state parts", async () => {
		const { AgentStatusBar } = await loadModule();
		const bar = new AgentStatusBar();

		bar.update([
			createTask({ id: "t1", status: "running" }),
			createTask({ id: "t2", status: "failed" }),
			createTask({ id: "t3", status: "completed" }),
		]);

		expect(mockStatusBarItem.text).toBe(
			"$(warning) 1 working · 1 attention · 1 done",
		);
	});

	test("tooltip truncates very long project names", async () => {
		const { AgentStatusBar } = await loadModule();
		const bar = new AgentStatusBar();
		const longProjectName = "project-".repeat(20);

		bar.update([
			createTask({
				id: "task-long",
				status: "running",
				project_name: longProjectName,
			}),
		]);

		const tooltip = mockStatusBarItem.tooltip as { value: string };
		expect(tooltip.value).toContain("task-long");
		expect(tooltip.value).toContain("…");
		expect(tooltip.value).not.toContain(longProjectName);
	});
});
