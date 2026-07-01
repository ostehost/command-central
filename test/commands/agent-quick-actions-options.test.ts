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

	test("paused lanes stay inspectable (regression: was an empty quick-pick)", () => {
		const labels = getAgentQuickActions("paused", false).map(
			(action) => action.label,
		);
		expect(labels).toEqual([
			"View Conversation Transcript",
			"View Diff",
			"Show Output",
		]);
	});

	test("paused lanes offer Resume (the unpause path) but never Restart or Remove", () => {
		const labels = getAgentQuickActions("paused", {
			hasTerminalFocusSurface: true,
			hasResumeSession: true,
			includeAdvancedActions: true,
		}).map((action) => action.label);
		// Resume reattaches to the still-alive conversation (the unpause path).
		// Restart is excluded: an in-place respawn would kill+orphan the live
		// process — the exit from paused is kill-to-clear, not restart. No Remove.
		expect(labels).toEqual([
			"Focus Terminal",
			"View Conversation Transcript",
			"View Diff",
			"Show Output",
			"Resume Claude Session…",
		]);
		expect(labels).not.toContain("Restart");
		expect(labels).not.toContain("Remove");
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
