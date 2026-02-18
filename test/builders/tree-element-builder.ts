/**
 * Tree Element Builder
 *
 * Fluent API for creating test tree elements with minimal boilerplate.
 * Enables readable, expressive tests.
 */

import * as vscode from "vscode";

/**
 * Create mock URI for testing
 */
function createMockUri(path: string): vscode.Uri {
	return {
		scheme: "file",
		authority: "",
		path,
		query: "",
		fragment: "",
		fsPath: path,
		with: () => createMockUri(path),
		toString: () => `file://${path}`,
		toJSON: () => ({ path }),
	} as vscode.Uri;
}

/**
 * Fluent builder for GitChangeItem test data
 *
 * Example:
 * ```typescript
 * const file = new GitChangeItemBuilder()
 *   .withUri('/src/file.ts')
 *   .modifiedAfterStaging()
 *   .withTimestamp(Date.now())
 *   .build();
 * ```
 */
export class GitChangeItemBuilder {
	private uri: vscode.Uri;
	private status = "M";
	private isStaged = false;
	private timestamp?: number;
	private order?: number;

	constructor() {
		// Default URI
		this.uri = createMockUri("/test/file.ts");
	}

	/**
	 * Set file path
	 *
	 * @param path - File path
	 * @returns Builder for chaining
	 */
	withUri(path: string): this {
		this.uri = createMockUri(path);
		return this;
	}

	/**
	 * Mark as staged
	 *
	 * @returns Builder for chaining
	 */
	staged(): this {
		this.isStaged = true;
		this.status = "M"; // Modified in index
		return this;
	}

	/**
	 * Mark as unstaged
	 *
	 * @returns Builder for chaining
	 */
	unstaged(): this {
		this.isStaged = false;
		this.status = "M"; // Modified in working tree
		return this;
	}

	/**
	 * Mark as modified after staging (MM status)
	 *
	 * Critical test case: File in BOTH index and working tree
	 * Should appear in unstaged group ONLY
	 *
	 * @returns Builder for chaining
	 */
	modifiedAfterStaging(): this {
		this.isStaged = false; // Appears in working tree changes
		this.status = "MM"; // Modified in both
		return this;
	}

	/**
	 * Mark as conflicted
	 *
	 * @param conflictType - Type of conflict (UU, AU, etc.)
	 * @returns Builder for chaining
	 */
	conflicted(conflictType = "UU"): this {
		this.isStaged = false;
		this.status = conflictType;
		return this;
	}

	/**
	 * Mark as untracked
	 *
	 * @returns Builder for chaining
	 */
	untracked(): this {
		this.isStaged = false;
		this.status = "??";
		return this;
	}

	/**
	 * Mark as deleted
	 *
	 * @returns Builder for chaining
	 */
	deleted(): this {
		this.status = "D";
		return this;
	}

	/**
	 * Mark as added
	 *
	 * @returns Builder for chaining
	 */
	added(): this {
		this.status = "A";
		return this;
	}

	/**
	 * Set timestamp
	 *
	 * @param timestamp - Timestamp in ms
	 * @returns Builder for chaining
	 */
	withTimestamp(timestamp: number): this {
		this.timestamp = timestamp;
		return this;
	}

	/**
	 * Set order
	 *
	 * @param order - Sort order
	 * @returns Builder for chaining
	 */
	withOrder(order: number): this {
		this.order = order;
		return this;
	}

	/**
	 * Build GitChangeItem
	 *
	 * @returns GitChangeItem test object
	 */
	build(): GitChangeItem {
		return {
			type: "gitChangeItem", // Phase 2: Explicit type discriminant
			uri: this.uri,
			status: this.status,
			isStaged: this.isStaged,
			timestamp: this.timestamp,
			order: this.order,
		};
	}
}

/**
 * Fluent builder for TimeGroup test data
 *
 * Example:
 * ```typescript
 * const timeGroup = new TimeGroupBuilder()
 *   .today()
 *   .withFiles([file1, file2])
 *   .build();
 * ```
 */
export class TimeGroupBuilder {
	private label = "Today";
	private timePeriod: TimePeriod = "today";
	private children: GitChangeItem[] = [];
	private collapsibleState = vscode.TreeItemCollapsibleState.Expanded;

	/**
	 * Set as Today group
	 */
	today(): this {
		this.label = "Today";
		this.timePeriod = "today";
		return this;
	}

	/**
	 * Set as Yesterday group
	 */
	yesterday(): this {
		this.label = "Yesterday";
		this.timePeriod = "yesterday";
		return this;
	}

	/**
	 * Set as Last 7 days group
	 */
	last7days(): this {
		this.label = "Last 7 days";
		this.timePeriod = "last7days";
		return this;
	}

	/**
	 * Set as Last 30 days group
	 */
	last30days(): this {
		this.label = "Last 30 days";
		this.timePeriod = "last30days";
		return this;
	}

	/**
	 * Set as This Month group
	 */
	thisMonth(): this {
		this.label = "This Month";
		this.timePeriod = "thisMonth";
		return this;
	}

	/**
	 * Set as Last Month group
	 */
	lastMonth(): this {
		this.label = "Last Month";
		this.timePeriod = "lastMonth";
		return this;
	}

	/**
	 * Set as Older group
	 */
	older(): this {
		this.label = "Older";
		this.timePeriod = "older";
		return this;
	}

	/**
	 * Add files to group
	 *
	 * @param files - Files to add
	 * @returns Builder for chaining
	 */
	withFiles(files: GitChangeItem[]): this {
		this.children = files;
		return this;
	}

	/**
	 * Set collapsible state
	 *
	 * @param state - Collapsible state
	 * @returns Builder for chaining
	 */
	withCollapsibleState(state: vscode.TreeItemCollapsibleState): this {
		this.collapsibleState = state;
		return this;
	}

	/**
	 * Build TimeGroup
	 *
	 * @returns TimeGroup test object
	 */
	build(): TimeGroup {
		return {
			type: "timeGroup", // Phase 2: Explicit type discriminant
			label: this.label,
			timePeriod: this.timePeriod,
			children: this.children,
			collapsibleState: this.collapsibleState,
			contextValue: "timeGroup",
		};
	}
}

/**
 * Fluent builder for GitStatusGroup test data
 *
 * Example:
 * ```typescript
 * const statusGroup = new GitStatusGroupBuilder()
 *   .staged()
 *   .withTimeGroups([todayGroup, yesterdayGroup])
 *   .build();
 * ```
 */
export class GitStatusGroupBuilder {
	private label = "Staged Changes";
	private statusType: "staged" | "unstaged" = "staged";
	private timeGroups: TimeGroup[] = [];
	private totalCount = 0;
	private collapsibleState = vscode.TreeItemCollapsibleState.Expanded;

	/**
	 * Set as Staged group
	 */
	staged(): this {
		this.label = "Staged Changes";
		this.statusType = "staged";
		return this;
	}

	/**
	 * Set as Unstaged group
	 */
	unstaged(): this {
		this.label = "Unstaged Changes";
		this.statusType = "unstaged";
		return this;
	}

	/**
	 * Add time groups
	 *
	 * @param timeGroups - Time groups to add
	 * @returns Builder for chaining
	 */
	withTimeGroups(timeGroups: TimeGroup[]): this {
		this.timeGroups = timeGroups;
		// Calculate total count
		this.totalCount = timeGroups.reduce(
			(sum, group) => sum + group.children.length,
			0,
		);
		return this;
	}

	/**
	 * Set total count manually
	 *
	 * @param count - Total count
	 * @returns Builder for chaining
	 */
	withTotalCount(count: number): this {
		this.totalCount = count;
		return this;
	}

	/**
	 * Set collapsible state
	 *
	 * @param state - Collapsible state
	 * @returns Builder for chaining
	 */
	withCollapsibleState(state: vscode.TreeItemCollapsibleState): this {
		this.collapsibleState = state;
		return this;
	}

	/**
	 * Build GitStatusGroup
	 *
	 * @returns GitStatusGroup test object
	 */
	build(): GitStatusGroup {
		return {
			type: "gitStatusGroup", // Phase 2: Explicit type discriminant
			label: this.label,
			statusType: this.statusType,
			timeGroups: this.timeGroups,
			totalCount: this.totalCount,
			collapsibleState: this.collapsibleState,
			contextValue: "gitStatusGroup",
		};
	}
}

// Type definitions for test data
// These match the actual types that will be in src/types/

export interface GitChangeItem {
	type: "gitChangeItem";
	uri: vscode.Uri;
	status: string;
	isStaged: boolean;
	timestamp?: number;
	order?: number;
}

export type TimePeriod =
	| "today"
	| "yesterday"
	| "last7days"
	| "last30days"
	| "thisMonth"
	| "lastMonth"
	| "older";

export interface TimeGroup {
	type: "timeGroup";
	label: string;
	timePeriod: TimePeriod;
	children: GitChangeItem[];
	collapsibleState: vscode.TreeItemCollapsibleState;
	contextValue: "timeGroup";
}

export interface GitStatusGroup {
	type: "gitStatusGroup";
	label: string;
	statusType: "staged" | "unstaged";
	timeGroups: TimeGroup[];
	totalCount: number;
	collapsibleState: vscode.TreeItemCollapsibleState;
	contextValue: "gitStatusGroup";
}

export type TreeElement = GitStatusGroup | TimeGroup | GitChangeItem;
