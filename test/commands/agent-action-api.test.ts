import { describe, expect, test } from "bun:test";
import { resolveAgentActionRequest } from "../../src/commands/agent-action-api.js";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";

function task(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "task-1",
		status: "completed",
		project_dir: "/repo/project",
		session_id: "agent-project",
		terminal_backend: "tmux",
		tmux_socket: "/tmp/project.tmux.sock",
		tmux_window_id: "@7",
		tmux_pane_id: "%12",
		exec_host: "hub",
		launcher_attach_available: true,
		...overrides,
	} as AgentTask;
}

describe("agent action API", () => {
	test("resolves a chat-friendly focusTerminal command from task infrastructure state", () => {
		const response = resolveAgentActionRequest(
			{
				action: "focusTerminal",
				surface: "discord",
				target: { taskId: "task-1" },
				mode: "command",
			},
			{ "task-1": task() },
		);

		expect(response.ok).toBe(true);
		expect(response.status).toBe("wouldExecute");
		expect(response.resolvedTarget).toEqual({
			taskId: "task-1",
			projectDir: "/repo/project",
			execHost: "hub",
			execNode: undefined,
		});
		expect(response.terminal).toMatchObject({
			backend: "tmux",
			sessionId: "agent-project",
			tmuxSocket: "/tmp/project.tmux.sock",
			tmuxWindowId: "@7",
			tmuxPaneId: "%12",
			attachAvailable: true,
		});
		expect(response.command?.argv).toEqual([
			"tmux",
			"-S",
			"/tmp/project.tmux.sock",
			"attach",
			"-t",
			"agent-project",
		]);
	});

	test("chat surfaces do not pretend they can focus a remote-node lane locally", () => {
		const response = resolveAgentActionRequest(
			{
				action: "focusTerminal",
				surface: "discord",
				target: { taskId: "task-1" },
			},
			{
				"task-1": task({
					exec_host: "node",
					exec_node: "Mike MacBook Pro",
				}),
			},
		);

		expect(response.ok).toBe(false);
		expect(response.status).toBe("needsRemoteHost");
		expect(response.resolvedTarget?.execNode).toBe("Mike MacBook Pro");
		expect(response.message).toContain("node");
	});

	test("requires focusable terminal state for focusTerminal", () => {
		const response = resolveAgentActionRequest(
			{
				action: "focusTerminal",
				surface: "vscode",
				target: { taskId: "task-1" },
			},
			{
				"task-1": task({
					session_id: undefined,
					tmux_socket: undefined,
					tmux_window_id: undefined,
					tmux_pane_id: undefined,
					ghostty_bundle_id: null,
					bundle_path: "",
				}),
			},
		);

		expect(response.ok).toBe(false);
		expect(response.status).toBe("unavailable");
	});

	test("reports ambiguous non-id targets instead of guessing", () => {
		const response = resolveAgentActionRequest(
			{
				action: "focusTerminal",
				surface: "chat",
				target: { projectRef: "/repo/project" },
			},
			{
				"task-1": task({ id: "task-1" }),
				"task-2": task({ id: "task-2" }),
			},
		);

		expect(response.ok).toBe(false);
		expect(response.status).toBe("ambiguous");
	});
});
