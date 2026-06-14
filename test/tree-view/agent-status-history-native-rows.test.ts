/**
 * Agent Status V2 — History section rows are native, non-actionable group rows.
 *
 * This extends the PITFALL #1 doctrine in `native-commands.test.ts` (which only
 * covers the git-sort provider) to the Agent Status V2 lifecycle tree, where the
 * History section is the densest surface: many completed rows, time sub-groups,
 * and a "Show N older completed..." overflow row.
 *
 * UX CONTRACT (locked here):
 *  - Section/group rows (statusGroup, statusTimeGroup), the overflow row
 *    (olderRuns), and pure info rows (state) carry NO `item.command`. Clicking
 *    them therefore only toggles VS Code's native expand/collapse — it can never
 *    dispatch a Command Central command, so an accidental click on a dense
 *    History header is inert (no terminal focus, no osascript, no toast, no
 *    bell). Adding a command to any of these rows is the #1 VS Code tree pitfall
 *    and would turn a benign expand-click into an action dispatch.
 *  - History (`done`) is rendered Collapsed and never auto-expands, so it stays
 *    quiet/dense-by-choice while remaining one click from full revisitability.
 *  - The "Show N older completed..." overflow row hides nothing: expanding it
 *    reveals every hidden run (the doctrine that every lane stays revisitable).
 *  - Leaf rows still navigate: a completed History task row DOES carry a command
 *    (defaultAgentAction → View Changes), confirming the no-command rule is
 *    scoped to group rows, not leaves.
 *
 * See research/RESULT-cc-history-ux-native-enhancement-20260614.md.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as vscode from "vscode";
import type {
	OlderRunsNode,
	StateNode,
	StatusGroupNode,
	StatusTimeGroupNode,
} from "../../src/providers/agent-status-tree-provider.js";
import {
	type AgentNode,
	type AgentStatusTreeProvider,
	type AgentTask,
	createMockTask,
	createProviderHarness,
	disposeHarness,
	type ProviderHarness,
} from "./_helpers/agent-status-tree-provider-test-base.js";

describe("Agent Status V2 — History section rows (native, non-actionable)", () => {
	let h: ProviderHarness;
	let provider: AgentStatusTreeProvider;

	beforeEach(() => {
		h = createProviderHarness();
		provider = h.provider;
	});

	afterEach(() => {
		disposeHarness(h);
	});

	const completedTaskNode = (
		id: string,
	): { type: "task"; task: AgentTask } => ({
		type: "task",
		task: createMockTask({ id, status: "completed" }),
	});

	const getItem = (node: AgentNode): vscode.TreeItem =>
		provider.getTreeItem(node);

	test("History section header (statusGroup) has NO command and stays Collapsed", () => {
		const node: StatusGroupNode = {
			type: "statusGroup",
			status: "done",
			nodes: [completedTaskNode("h-1"), completedTaskNode("h-2")],
		};

		const item = getItem(node);

		// PITFALL #1: a command here would override native expand/collapse and
		// turn an accidental click on a dense History header into a dispatch.
		expect(item.command).toBeUndefined();
		expect(item.contextValue).toBe("statusGroup");
		// History never auto-expands — quiet by default, one click from revisit.
		expect(item.collapsibleState).toBe(
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		// Still discoverable: icon + tooltip present for hover/AT context.
		expect(item.iconPath).toBeDefined();
		expect(item.tooltip).toBeDefined();
	});

	test("History time sub-group (statusTimeGroup) has NO command", () => {
		const node: StatusTimeGroupNode = {
			type: "statusTimeGroup",
			status: "done",
			period: "older",
			label: "Older",
			nodes: [completedTaskNode("t-1")],
			collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
		};

		const item = getItem(node);

		expect(item.command).toBeUndefined();
		expect(item.contextValue).toBe("statusTimeGroup");
		expect(item.collapsibleState).toBe(
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		expect(item.tooltip).toBeDefined();
	});

	test('"Show N older completed..." overflow row has NO command, is collapsible, and hides nothing', () => {
		const hiddenNodes = [
			completedTaskNode("o-1"),
			completedTaskNode("o-2"),
			completedTaskNode("o-3"),
		];
		const node: OlderRunsNode = {
			type: "olderRuns",
			label: `Show ${hiddenNodes.length} older completed...`,
			hiddenNodes,
		};

		const item = getItem(node);

		// Non-actionable: clicking expands (native), it is not a button/command.
		expect(item.command).toBeUndefined();
		expect(item.contextValue).toBe("olderRuns");
		expect(item.collapsibleState).toBe(
			vscode.TreeItemCollapsibleState.Collapsed,
		);

		// Hides nothing: expanding reveals every hidden run (revisitability).
		const revealed = provider.getChildren(node);
		expect(revealed.length).toBe(hiddenNodes.length);
	});

	test("Info row (state) has NO command", () => {
		const node: StateNode = {
			type: "state",
			label: "No file changes",
		};

		const item = getItem(node);

		expect(item.command).toBeUndefined();
		expect(item.contextValue).toBe("agentState");
		expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
	});

	test("Contrast: a completed History task LEAF still carries a navigation command", () => {
		// The no-command rule is scoped to group/section rows, never leaves —
		// a History row still opens its diff on click (quiet, no terminal focus).
		const item = getItem(completedTaskNode("leaf-1"));

		expect(item.command).toBeDefined();
		expect(item.command?.command).toBe("commandCentral.defaultAgentAction");
	});
});
