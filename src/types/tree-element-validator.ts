/**
 * Tree Hierarchy Validator
 *
 * Validates tree structure to prevent UI corruption from malformed data.
 * Defensive programming layer between data processing and UI rendering.
 *
 * Design Principles:
 * - Fail gracefully: Log warnings, don't throw errors
 * - Comprehensive: Check all hierarchy rules
 * - Actionable: Error messages explain what's wrong
 * - Fast: Validate before rendering, not during
 *
 * Usage:
 * ```typescript
 * const result = validateTreeHierarchy(statusGroup);
 * if (!result.valid) {
 *   logger.warn('Invalid tree hierarchy:', result.errors);
 *   return fallbackData;
 * }
 * ```
 */

import type {
	GitChangeItem,
	GitStatusGroup,
	TimeGroup,
} from "./tree-element.js";
import {
	isGitChangeItem,
	isGitStatusGroup,
	isTimeGroup,
} from "./tree-element-guards.js";

/**
 * Validation result
 */
export interface ValidationResult {
	/** Whether tree is valid */
	valid: boolean;

	/** Array of error messages (empty if valid) */
	errors: string[];

	/** Array of warnings (non-fatal issues) */
	warnings: string[];
}

/**
 * Validate entire tree hierarchy
 *
 * Checks:
 * 1. Correct nesting (GitStatusGroup → TimeGroup → GitChangeItem)
 * 2. No level skipping
 * 3. Required properties present
 * 4. Discriminants are correct
 * 5. Collapsible states are valid
 *
 * @param tree - Root element to validate (usually GitStatusGroup)
 * @returns Validation result
 */
export function validateTreeHierarchy(tree: unknown): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	// Check if tree is an object
	if (!tree || typeof tree !== "object") {
		errors.push("Tree root must be an object");
		return { valid: false, errors, warnings };
	}

	// Validate based on element type
	if (isGitStatusGroup(tree)) {
		validateGitStatusGroup(tree, errors, warnings);
	} else if (isTimeGroup(tree)) {
		validateTimeGroup(tree, errors, warnings);
	} else if (isGitChangeItem(tree)) {
		validateGitChangeItem(tree, errors, warnings);
	} else {
		errors.push(
			`Unknown element type: ${(tree as { type?: string }).type || "undefined"}`,
		);
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

/**
 * Validate GitStatusGroup structure
 * @private
 */
function validateGitStatusGroup(
	group: GitStatusGroup,
	errors: string[],
	warnings: string[],
): void {
	// Check required properties
	if (!group.statusType) {
		errors.push("GitStatusGroup missing statusType");
	}

	if (group.statusType !== "staged" && group.statusType !== "unstaged") {
		errors.push(
			`GitStatusGroup has invalid statusType: ${group.statusType} (expected 'staged' or 'unstaged')`,
		);
	}

	if (!group.label) {
		errors.push("GitStatusGroup missing label");
	}

	if (typeof group.totalCount !== "number" || group.totalCount < 0) {
		errors.push(
			`GitStatusGroup has invalid totalCount: ${group.totalCount} (expected non-negative number)`,
		);
	}

	if (!Array.isArray(group.timeGroups)) {
		errors.push("GitStatusGroup.timeGroups must be an array");
		return; // Can't validate children if not array
	}

	// Validate children are TimeGroups
	for (let i = 0; i < group.timeGroups.length; i++) {
		const child = group.timeGroups[i];

		if (!child) {
			errors.push(
				`GitStatusGroup child[${i}] is null or undefined (expected TimeGroup)`,
			);
			continue;
		}

		if (!isTimeGroup(child)) {
			const childType = (child as { type?: string }).type || typeof child;
			errors.push(
				`GitStatusGroup child[${i}] has invalid child type: ${childType} (expected TimeGroup)`,
			);
			continue;
		}

		// Recursively validate child
		validateTimeGroup(child, errors, warnings);
	}

	// Validate count matches actual file count
	const actualCount = group.timeGroups.reduce(
		(sum, tg) => sum + (tg?.children?.length ?? 0),
		0,
	);
	if (group.totalCount !== actualCount) {
		warnings.push(
			`GitStatusGroup totalCount (${group.totalCount}) doesn't match actual file count (${actualCount})`,
		);
	}
}

/**
 * Validate TimeGroup structure
 * @private
 */
function validateTimeGroup(
	group: TimeGroup,
	errors: string[],
	warnings: string[],
): void {
	// Check required properties
	if (!group.label) {
		errors.push("TimeGroup missing label");
	}

	if (!group.timePeriod) {
		errors.push("TimeGroup missing timePeriod");
	}

	const validPeriods = [
		"today",
		"yesterday",
		"last7days",
		"last30days",
		"thisMonth",
		"lastMonth",
		"older",
	];
	if (!validPeriods.includes(group.timePeriod)) {
		errors.push(
			`TimeGroup has invalid timePeriod: ${group.timePeriod} (expected one of: ${validPeriods.join(", ")})`,
		);
	}

	if (!Array.isArray(group.children)) {
		errors.push("TimeGroup.children must be an array");
		return; // Can't validate children if not array
	}

	// Validate children are GitChangeItems
	for (let i = 0; i < group.children.length; i++) {
		const child = group.children[i];

		if (!child) {
			errors.push(
				`TimeGroup child[${i}] is null or undefined (expected GitChangeItem)`,
			);
			continue;
		}

		if (!isGitChangeItem(child)) {
			const childType = (child as { type?: string }).type || typeof child;
			errors.push(
				`TimeGroup child[${i}] has invalid child type: ${childType} (expected GitChangeItem)`,
			);
			continue;
		}

		// Recursively validate child
		validateGitChangeItem(child, errors, warnings);
	}
}

/**
 * Validate GitChangeItem structure
 * @private
 */
function validateGitChangeItem(
	item: GitChangeItem,
	errors: string[],
	warnings: string[],
): void {
	// Check required properties
	if (!item.uri) {
		errors.push("GitChangeItem missing uri");
	}

	if (!item.status) {
		errors.push("GitChangeItem missing status");
	}

	if (typeof item.isStaged !== "boolean") {
		errors.push(
			`GitChangeItem has invalid isStaged: ${item.isStaged} (expected boolean)`,
		);
	}

	// Optional properties validation
	if (item.timestamp !== undefined) {
		if (typeof item.timestamp !== "number" || item.timestamp < 0) {
			warnings.push(
				`GitChangeItem has invalid timestamp: ${item.timestamp} (expected positive number)`,
			);
		}

		// Warn if timestamp is in the future
		if (item.timestamp > Date.now()) {
			warnings.push(
				`GitChangeItem has future timestamp: ${new Date(item.timestamp).toISOString()}`,
			);
		}
	}

	if (item.order !== undefined) {
		if (typeof item.order !== "number" || item.order < 1) {
			warnings.push(
				`GitChangeItem has invalid order: ${item.order} (expected positive number ≥ 1)`,
			);
		}
	}
}
