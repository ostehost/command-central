/**
 * Tree Element Types for Git Status Grouping
 *
 * Defines a 3-level hierarchy for grouped Git status display:
 * - Level 1: GitStatusGroup (Staged/Unstaged)
 * - Level 2: TimeGroup (Today/Yesterday/etc.)
 * - Level 3: GitChangeItem (individual files)
 *
 * Design Principles:
 * - Explicit 'type' discriminant for type safety
 * - VS Code native patterns (ThemeIcon, contextValue, stable IDs)
 * - Defensive programming with runtime validation
 * - Compatible with TreeDataProvider<TreeElement>
 *
 * Pattern based on:
 * - ExtensionFilterTreeProvider (explicit type discriminant)
 * - SortedGitChangesProvider (VS Code TreeView patterns)
 */

import type * as vscode from "vscode";

/**
 * Level 1: Status Group (Staged/Unstaged)
 *
 * Top-level container grouping files by their Git status.
 * Appears at root level of tree.
 *
 * Children: TimeGroup[]
 *
 * Example:
 * ```
 * Staged Changes (5 files)
 *   Today (3 files)
 *   Yesterday (2 files)
 * Unstaged Changes (10 files)
 *   Today (10 files)
 * ```
 */
export interface GitStatusGroup {
	/** Discriminant for type guards */
	type: "gitStatusGroup";

	/** Status category: staged or unstaged */
	statusType: "staged" | "unstaged";

	/** Display label (e.g., "Staged Changes") */
	label: string;

	/** Total file count across all time groups */
	totalCount: number;

	/** Child time groups */
	timeGroups: TimeGroup[];

	/** VS Code collapsible state */
	collapsibleState: vscode.TreeItemCollapsibleState;

	/** VS Code context value for menu contributions */
	contextValue: "gitStatusGroup";
}

/**
 * Level 2: Time Group (Today/Yesterday/etc.)
 *
 * Groups files by modification time.
 * Child of GitStatusGroup.
 *
 * Children: GitChangeItem[]
 *
 * Time periods:
 * - today: Last 24 hours
 * - yesterday: 24-48 hours ago
 * - last7days: Within last 7 days
 * - last30days: Within last 30 days
 * - thisMonth: Current calendar month
 * - lastMonth: Previous calendar month
 * - older: Before last month
 */
export interface TimeGroup {
	/** Discriminant for type guards */
	type: "timeGroup";

	/** Display label (e.g., "Today") */
	label: string;

	/** Time period identifier */
	timePeriod:
		| "today"
		| "yesterday"
		| "last7days"
		| "last30days"
		| "thisMonth"
		| "lastMonth"
		| "older";

	/** Child file change items */
	children: GitChangeItem[];

	/** VS Code collapsible state */
	collapsibleState: vscode.TreeItemCollapsibleState;

	/** VS Code context value for menu contributions */
	contextValue: "timeGroup";

	/** Parent context for unique tree item IDs in git status grouping */
	parentType?: "staged" | "unstaged";
}

/**
 * Level 3: Git Change Item (individual file)
 *
 * Represents a single modified file.
 * Child of TimeGroup.
 * Leaf node (no children).
 *
 * Properties align with VS Code Git API Change type.
 */
export interface GitChangeItem {
	/** Discriminant for type guards */
	type?: "gitChangeItem";

	/** File URI */
	uri: vscode.Uri;

	/** Git status code (M, A, D, R, etc.) */
	status: string;

	/** Whether file is staged */
	isStaged: boolean;

	/** Context value for menu visibility (staged, unstaged, staged-and-unstaged, etc.) */
	contextValue?: string;

	/** Last modification timestamp (ms since epoch) */
	timestamp?: number;

	/** Sequential order for deleted files (1-based) */
	order?: number;

	/** Parent context for unique tree item IDs in git status grouping */
	parentType?: "staged" | "unstaged";
}

/**
 * Union type for all tree elements
 *
 * Used as generic parameter for TreeDataProvider<TreeElement>
 *
 * Type guards:
 * - isGitStatusGroup(element): element is GitStatusGroup
 * - isTimeGroup(element): element is TimeGroup
 * - isGitChangeItem(element): element is GitChangeItem
 */
export type TreeElement = GitStatusGroup | TimeGroup | GitChangeItem;

// Legacy re-exports removed - all types now defined in this file
