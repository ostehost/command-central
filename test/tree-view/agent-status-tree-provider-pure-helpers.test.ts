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
	detectAgentType,
	formatElapsed,
	getAgentTypeIcon,
	getStatusThemeIcon,
} from "../../src/providers/agent-status-tree-provider.js";

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
