/**
 * Type Guards for Tree Elements
 *
 * Provides safe runtime type checking for the 3-level tree hierarchy.
 * Essential for proper navigation in getTreeItem() and getChildren().
 *
 * Design Principles:
 * - Defensive: Handle null, undefined, and malformed data
 * - Exhaustive: Each guard is mutually exclusive
 * - Fast: Simple property checks, no deep validation
 * - TypeScript: Proper type predicates for narrowing
 *
 * Usage:
 * ```typescript
 * if (isGitStatusGroup(element)) {
 *   // TypeScript knows element is GitStatusGroup
 *   return element.timeGroups;
 * }
 * ```
 */

import type {
	GitChangeItem,
	GitStatusGroup,
	TimeGroup,
} from "./tree-element.js";

/**
 * Check if element is a GitStatusGroup
 *
 * Level 1 of hierarchy (root level).
 * Has children: TimeGroup[]
 *
 * @param element - Element to check
 * @returns true if element is GitStatusGroup
 */
export function isGitStatusGroup(element: unknown): element is GitStatusGroup {
	if (!element || typeof element !== "object") {
		return false;
	}

	const el = element as { type?: string };
	return el.type === "gitStatusGroup";
}

/**
 * Check if element is a TimeGroup
 *
 * Level 2 of hierarchy (child of GitStatusGroup).
 * Has children: GitChangeItem[]
 *
 * @param element - Element to check
 * @returns true if element is TimeGroup
 */
export function isTimeGroup(element: unknown): element is TimeGroup {
	if (!element || typeof element !== "object") {
		return false;
	}

	const el = element as { type?: string };
	return el.type === "timeGroup";
}

/**
 * Check if element is a GitChangeItem
 *
 * Level 3 of hierarchy (child of TimeGroup).
 * Leaf node - no children.
 *
 * @param element - Element to check
 * @returns true if element is GitChangeItem
 */
export function isGitChangeItem(element: unknown): element is GitChangeItem {
	if (!element || typeof element !== "object") {
		return false;
	}

	const el = element as { type?: string };
	return el.type === "gitChangeItem";
}
