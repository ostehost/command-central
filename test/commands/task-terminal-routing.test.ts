import { describe, expect, test } from "bun:test";
import {
	buildTaskTmuxArgs,
	buildTaskTmuxAttachCommand,
	resolveTaskInputTarget,
	resolveTaskWindowTarget,
} from "../../src/commands/task-terminal-routing.js";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";

function createTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "task-routing",
		status: "running",
		project_dir: "/tmp/project",
		project_name: "project",
		session_id: "agent-project",
		bundle_path: "/Applications/Projects/project.app",
		prompt_file: "/tmp/prompt.md",
		started_at: "2026-04-02T12:00:00Z",
		attempts: 1,
		max_attempts: 1,
		...overrides,
	};
}

describe("task terminal routing helpers", () => {
	test("prefers pane ids for command routing when present", () => {
		const task = createTask({
			tmux_window_id: "@42",
			tmux_pane_id: "%7",
		});

		expect(resolveTaskInputTarget(task)).toBe("%7");
		expect(resolveTaskWindowTarget(task)).toBe("@42");
	});

	test("falls back to tmux window id before session id", () => {
		const task = createTask({
			tmux_window_id: "@42",
		});

		expect(resolveTaskInputTarget(task)).toBe("@42");
		expect(resolveTaskWindowTarget(task)).toBe("@42");
	});

	test("uses the session id when no exact tmux window metadata exists", () => {
		const task = createTask();

		expect(resolveTaskInputTarget(task)).toBe("agent-project");
		expect(resolveTaskWindowTarget(task)).toBe("agent-project");
	});

	test("builds tmux commands with dedicated socket and config", () => {
		const task = createTask({
			tmux_conf: "/tmp/project.tmux.conf",
			tmux_socket: "/tmp/project.tmux.sock",
		});

		expect(buildTaskTmuxArgs(task, ["select-window", "-t", "@42"])).toEqual([
			"-f",
			"/tmp/project.tmux.conf",
			"-S",
			"/tmp/project.tmux.sock",
			"select-window",
			"-t",
			"@42",
		]);
	});

	test("builds attach commands against the task-specific tmux runtime", () => {
		const task = createTask({
			session_id: "agent-project-reviewer",
			tmux_conf: "/tmp/project.tmux.conf",
			tmux_socket: "/tmp/project.tmux.sock",
		});

		expect(buildTaskTmuxAttachCommand(task)).toBe(
			"'tmux' '-f' '/tmp/project.tmux.conf' '-S' '/tmp/project.tmux.sock' 'attach' '-t' 'agent-project-reviewer'",
		);
	});
});
