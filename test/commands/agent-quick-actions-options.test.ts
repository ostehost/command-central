import { describe, expect, test } from "bun:test";
import { getAgentQuickActions } from "../../src/commands/agent-quick-actions.js";

describe("agent quick action options", () => {
	test("completed focusable tasks put Focus Terminal first without restart/resume", () => {
		const labels = getAgentQuickActions("completed", {
			hasTerminalFocusSurface: true,
			hasResumeSession: true,
		}).map((action) => action.label);
		expect(labels).toEqual([
			"Focus Terminal",
			"View Conversation Transcript",
			"View Diff",
			"Show Output",
		]);
	});

	test("completed non-focusable tasks keep review actions first", () => {
		const labels = getAgentQuickActions("completed", false).map(
			(action) => action.label,
		);
		expect(labels).toEqual([
			"View Conversation Transcript",
			"View Diff",
			"Show Output",
		]);
	});

	test("completed stale tasks include mark-as-failed", () => {
		const labels = getAgentQuickActions("completed_stale", {
			hasTerminalFocusSurface: true,
		}).map((action) => action.label);
		expect(labels).toEqual([
			"Focus Terminal",
			"View Conversation Transcript",
			"View Diff",
			"Show Output",
			"Mark as Failed",
		]);
	});

	test("failed tasks include transcript/output/diff/remove", () => {
		const labels = getAgentQuickActions("failed", false).map(
			(action) => action.label,
		);
		expect(labels).toEqual([
			"View Conversation Transcript",
			"Show Output",
			"View Diff",
			"Remove",
		]);
	});

	test("stopped tasks include transcript/output/diff/remove", () => {
		const labels = getAgentQuickActions("stopped", false).map(
			(action) => action.label,
		);
		expect(labels).toEqual([
			"View Conversation Transcript",
			"Show Output",
			"View Diff",
			"Remove",
		]);
	});

	test("killed tasks include transcript/output/diff/remove", () => {
		const labels = getAgentQuickActions("killed", false).map(
			(action) => action.label,
		);
		expect(labels).toEqual([
			"View Conversation Transcript",
			"Show Output",
			"View Diff",
			"Remove",
		]);
	});

	test("resume/restart stay behind the advanced flag and after common actions", () => {
		const labels = getAgentQuickActions("failed", {
			hasResumeSession: true,
			hasTerminalFocusSurface: true,
			includeAdvancedActions: true,
		}).map((action) => action.label);
		expect(labels).toEqual([
			"Focus Terminal",
			"View Conversation Transcript",
			"Show Output",
			"View Diff",
			"Remove",
			"Resume Claude Session…",
			"Restart",
		]);
	});

	test("running tasks do not produce quick actions", () => {
		const actions = getAgentQuickActions("running", true);
		expect(actions).toEqual([]);
	});
});
