/**
 * AgentStatusTreeProvider — pure helper function tests
 *
 * EXTRACTED from agent-status-tree-provider.test.ts. These tests cover
 * exported pure functions that don't construct a provider instance:
 *   - formatElapsed
 *   - detectAgentType + getAgentTypeIcon
 *   - getStatusThemeIcon
 *
 * Because no provider is instantiated, no module mocks are needed beyond
 * the global vscode mock (test/setup/global-test-cleanup.ts).
 */

import { describe, expect, test } from "bun:test";
import {
	classifyCompletionRouting,
	classifyLifecycleConflict,
	detectAgentType,
	formatElapsed,
	getAgentTypeIcon,
	getStatusThemeIcon,
} from "../../src/providers/agent-status-tree-provider.js";
import { createMockTask } from "./_helpers/agent-status-tree-provider-test-base.js";

describe("formatElapsed", () => {
	test("shows minutes for short durations", () => {
		const now = new Date("2026-02-25T08:30:00Z");
		expect(formatElapsed("2026-02-25T08:00:00Z", now)).toBe("30m");
	});

	test("shows hours and minutes for long durations", () => {
		const now = new Date("2026-02-25T10:15:00Z");
		expect(formatElapsed("2026-02-25T08:00:00Z", now)).toBe("2h 15m");
	});

	test("omits zero minutes for exact-hour durations", () => {
		const now = new Date("2026-02-25T10:00:00Z");
		expect(formatElapsed("2026-02-25T08:00:00Z", now)).toBe("2h");
	});

	test("shows 0m for same time", () => {
		const now = new Date("2026-02-25T08:00:00Z");
		expect(formatElapsed("2026-02-25T08:00:00Z", now)).toBe("0m");
	});

	test("handles future start time gracefully", () => {
		const now = new Date("2026-02-25T07:00:00Z");
		expect(formatElapsed("2026-02-25T08:00:00Z", now)).toBe("0m");
	});
});

describe("agent type detection + icons", () => {
	test("detects backend/CLI hints first", () => {
		expect(detectAgentType({ agent_backend: "claude" })).toBe("claude");
		expect(detectAgentType({ cli_name: "codex" })).toBe("codex");
		expect(detectAgentType({ process_name: "gemini" })).toBe("gemini");
	});

	test("falls back to command/model hints", () => {
		expect(
			detectAgentType({
				command: "/usr/local/bin/codex --model gpt-5 --print hello",
			}),
		).toBe("codex");
		expect(detectAgentType({ model: "claude-3.7-sonnet" })).toBe("claude");
		expect(detectAgentType({ model: "gemini-2.5-pro" })).toBe("gemini");
		expect(detectAgentType({ id: "unknown-task" })).toBe("unknown");
	});

	test("returns hubot icon with expected color mapping", () => {
		const claudeIcon = getAgentTypeIcon({ cli_name: "claude" }) as {
			id: string;
			color?: { id: string };
		};
		const codexIcon = getAgentTypeIcon({
			command: "/opt/homebrew/bin/codex run",
		}) as {
			id: string;
			color?: { id: string };
		};
		const geminiIcon = getAgentTypeIcon({ model: "gemini-2.5-pro" }) as {
			id: string;
			color?: { id: string };
		};
		const unknownIcon = getAgentTypeIcon({}) as {
			id: string;
			color?: { id: string };
		};

		expect(claudeIcon.id).toBe("hubot");
		expect(claudeIcon.color?.id).toBe("charts.purple");
		expect(codexIcon.id).toBe("hubot");
		expect(codexIcon.color?.id).toBe("charts.green");
		expect(geminiIcon.id).toBe("hubot");
		expect(geminiIcon.color?.id).toBe("charts.blue");
		expect(unknownIcon.id).toBe("hubot");
		expect(unknownIcon.color).toBeUndefined();
	});
});

describe("status icon mapping", () => {
	test("returns expected ThemeIcon + color for each status", () => {
		const cases = [
			["running", "sync~spin", "charts.yellow"],
			["completed", "check", "charts.green"],
			["completed_dirty", "check", "charts.green"],
			["completed_stale", "check-all", "charts.green"],
			["failed", "error", "charts.red"],
			["contract_failure", "warning", "charts.orange"],
			["stopped", "debug-stop", "charts.purple"],
			["killed", "close", "charts.red"],
		] as const;

		for (const [status, expectedIcon, expectedColor] of cases) {
			const icon = getStatusThemeIcon(status) as {
				id: string;
				color?: { id: string };
			};
			expect(icon.id).toBe(expectedIcon);
			expect(icon.color?.id).toBe(expectedColor);
		}
	});
});

describe("classifyCompletionRouting", () => {
	test("completed task with session_key + callback_url is owner-bound", () => {
		const task = createMockTask({
			status: "completed",
			session_key: "agent:main:dashboard:fff3d5cc",
			callback_url: "https://gateway.partnerai.dev/hooks/agent",
		});
		const routing = classifyCompletionRouting(task);
		expect(routing.kind).toBe("owner-bound");
		expect(routing.label).toBe("Owner-bound completion");
		expect(routing.icon).toBe("radio-tower");
	});

	test("completed task with callback_url only is owner-bound", () => {
		const task = createMockTask({
			status: "completed",
			session_key: null,
			callback_url: "https://gateway.partnerai.dev/hooks/agent",
		});
		const routing = classifyCompletionRouting(task);
		expect(routing.kind).toBe("owner-bound");
	});

	test("completed task with session_key only is owner-bound", () => {
		const task = createMockTask({
			status: "completed",
			session_key: "agent:main:dashboard:fff3d5cc",
			callback_url: null,
		});
		const routing = classifyCompletionRouting(task);
		expect(routing.kind).toBe("owner-bound");
	});

	test("completed task with no session_key and no callback_url is detached", () => {
		const task = createMockTask({
			status: "completed",
			session_key: null,
			callback_url: null,
		});
		const routing = classifyCompletionRouting(task);
		expect(routing.kind).toBe("detached");
		expect(routing.label).toBe("Detached — manual observation required");
		expect(routing.icon).toBe("debug-disconnect");
		expect(routing.iconColor).toBe("charts.yellow");
	});

	test("failed task with no routing fields is detached", () => {
		const task = createMockTask({
			status: "failed",
			session_key: null,
			callback_url: null,
		});
		const routing = classifyCompletionRouting(task);
		expect(routing.kind).toBe("detached");
	});

	test("running task with session_key is owner-bound", () => {
		const task = createMockTask({
			status: "running",
			session_key: "agent:main:dashboard:fff3d5cc",
			callback_url: null,
		});
		const routing = classifyCompletionRouting(task);
		expect(routing.kind).toBe("owner-bound");
		expect(routing.label).toBe("Owner-bound");
	});

	test("running task with no routing fields is detached", () => {
		const task = createMockTask({
			status: "running",
			session_key: null,
			callback_url: null,
		});
		const routing = classifyCompletionRouting(task);
		expect(routing.kind).toBe("detached");
		expect(routing.label).toBe("Detached");
	});

	test("empty-string session_key is treated as absent", () => {
		const task = createMockTask({
			status: "completed",
			session_key: "  ",
			callback_url: null,
		});
		const routing = classifyCompletionRouting(task);
		expect(routing.kind).toBe("detached");
	});

	test("contract_failure with callback is owner-bound", () => {
		const task = createMockTask({
			status: "contract_failure",
			callback_url: "https://example.com/hook",
		});
		const routing = classifyCompletionRouting(task);
		expect(routing.kind).toBe("owner-bound");
	});
});

describe("classifyLifecycleConflict", () => {
	test("failed task with alive evidence returns live-process-conflict", () => {
		const task = createMockTask({
			status: "failed",
			error_message: "dead_pid",
		});
		const conflict = classifyLifecycleConflict(task, "alive");
		expect(conflict.kind).toBe("live-process-conflict");
		expect(conflict.label).toBe("Lifecycle conflict");
		expect(conflict.detail).toContain("failed");
		expect(conflict.detail).toContain("dead_pid");
		expect(conflict.detail).toContain("still alive");
		expect(conflict.icon).toBe("warning");
		expect(conflict.iconColor).toBe("charts.orange");
	});

	test("failed task with dead evidence returns none", () => {
		const task = createMockTask({
			status: "failed",
			error_message: "dead_pid",
		});
		const conflict = classifyLifecycleConflict(task, "dead");
		expect(conflict.kind).toBe("none");
	});

	test("failed task with unknown evidence returns none", () => {
		const task = createMockTask({ status: "failed" });
		const conflict = classifyLifecycleConflict(task, "unknown");
		expect(conflict.kind).toBe("none");
	});

	test("failed task with not-checked evidence returns none", () => {
		const task = createMockTask({ status: "failed" });
		const conflict = classifyLifecycleConflict(task, "not-checked");
		expect(conflict.kind).toBe("none");
	});

	test("stopped task with alive evidence returns conflict", () => {
		const task = createMockTask({ status: "stopped" });
		const conflict = classifyLifecycleConflict(task, "alive");
		expect(conflict.kind).toBe("live-process-conflict");
		expect(conflict.detail).toContain("stopped");
	});

	test("killed task with alive evidence returns conflict", () => {
		const task = createMockTask({ status: "killed" });
		const conflict = classifyLifecycleConflict(task, "alive");
		expect(conflict.kind).toBe("live-process-conflict");
	});

	test("contract_failure with alive evidence returns conflict", () => {
		const task = createMockTask({ status: "contract_failure" });
		const conflict = classifyLifecycleConflict(task, "alive");
		expect(conflict.kind).toBe("live-process-conflict");
	});

	test("running task with alive evidence returns none (not terminal)", () => {
		const task = createMockTask({ status: "running" });
		const conflict = classifyLifecycleConflict(task, "alive");
		expect(conflict.kind).toBe("none");
	});

	test("completed task with alive evidence returns live-process-conflict", () => {
		const task = createMockTask({ status: "completed" });
		const conflict = classifyLifecycleConflict(task, "alive");
		expect(conflict.kind).toBe("live-process-conflict");
		expect(conflict.detail).toContain("completed");
		expect(conflict.detail).toContain("still alive");
	});

	test("completed task with dead evidence returns none", () => {
		const task = createMockTask({ status: "completed" });
		const conflict = classifyLifecycleConflict(task, "dead");
		expect(conflict.kind).toBe("none");
	});

	test("completed task with unknown evidence returns none", () => {
		const task = createMockTask({ status: "completed" });
		const conflict = classifyLifecycleConflict(task, "unknown");
		expect(conflict.kind).toBe("none");
	});

	test("completed_dirty with alive evidence returns live-process-conflict", () => {
		const task = createMockTask({ status: "completed_dirty" });
		const conflict = classifyLifecycleConflict(task, "alive");
		expect(conflict.kind).toBe("live-process-conflict");
		expect(conflict.detail).toContain("completed_dirty");
	});

	test("completed_stale with alive evidence returns live-process-conflict", () => {
		const task = createMockTask({ status: "completed_stale" });
		const conflict = classifyLifecycleConflict(task, "alive");
		expect(conflict.kind).toBe("live-process-conflict");
		expect(conflict.detail).toContain("completed_stale");
	});

	test("failed task without error_message omits parenthetical", () => {
		const task = createMockTask({ status: "failed", error_message: null });
		const conflict = classifyLifecycleConflict(task, "alive");
		expect(conflict.kind).toBe("live-process-conflict");
		expect(conflict.detail).not.toContain("(");
		expect(conflict.detail).toContain("failed");
	});
});
