import { describe, expect, test } from "bun:test";
import { getAgentQuickActions } from "../../src/commands/agent-quick-actions.js";

describe("agent quick action options", () => {
	test("completed tasks include diff/output/focus/restart", () => {
		const labels = getAgentQuickActions("completed", false).map(
			(action) => action.label,
		);
		expect(labels).toEqual([
			"View Diff",
			"Show Output",
			"Focus Terminal",
			"Restart",
		]);
	});

	test("completed stale tasks include mark-as-failed", () => {
		const labels = getAgentQuickActions("completed_stale", false).map(
			(action) => action.label,
		);
		expect(labels).toEqual([
			"View Diff",
			"Show Output",
			"Focus Terminal",
			"Mark as Failed",
			"Restart",
		]);
	});

	test("failed tasks include output/diff/restart/remove", () => {
		const labels = getAgentQuickActions("failed", false).map(
			(action) => action.label,
		);
		expect(labels).toEqual(["Show Output", "View Diff", "Restart", "Remove"]);
	});

	test("stopped tasks include output/diff/restart/remove", () => {
		const labels = getAgentQuickActions("stopped", false).map(
			(action) => action.label,
		);
		expect(labels).toEqual(["Show Output", "View Diff", "Restart", "Remove"]);
	});

	test("killed tasks include output/diff/restart/remove", () => {
		const labels = getAgentQuickActions("killed", false).map(
			(action) => action.label,
		);
		expect(labels).toEqual(["Show Output", "View Diff", "Restart", "Remove"]);
	});

	test("resume session is prepended when a resumable session exists", () => {
		const labels = getAgentQuickActions("failed", true).map(
			(action) => action.label,
		);
		expect(labels).toEqual([
			"Resume Session",
			"Show Output",
			"View Diff",
			"Restart",
			"Remove",
		]);
	});

	test("running tasks do not produce quick actions", () => {
		const actions = getAgentQuickActions("running", true);
		expect(actions).toEqual([]);
	});
});
