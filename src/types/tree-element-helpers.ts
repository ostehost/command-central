/**
 * Tree Element Helper Functions
 *
 * Provides utility functions for working with the 3-level tree hierarchy.
 * Simplifies common operations in TreeDataProvider implementations.
 *
 * Primary Use Case: getChildren() implementation
 * ```typescript
 * async getChildren(element?: TreeElement): Promise<TreeElement[]> {
 *   return getChildrenForElement(element, this.rootElements);
 * }
 * ```
 */

import type {
	GitChangeItem,
	GitStatusGroup,
	TimeGroup,
	TreeElement,
} from "./tree-element.js";
import {
	isGitChangeItem,
	isGitStatusGroup,
	isTimeGroup,
} from "./tree-element-guards.js";

/**
 * Get children for any tree element
 *
 * Handles all 3 levels of hierarchy:
 * - undefined (root) → returns rootElements
 * - GitStatusGroup → returns timeGroups
 * - TimeGroup → returns children
 * - GitChangeItem → returns [] (leaf node)
 *
 * This function encapsulates the hierarchy logic, making
 * provider implementations cleaner and more maintainable.
 *
 * @param element - Parent element (undefined = root)
 * @param rootElements - Root elements to return when element is undefined
 * @returns Array of child elements
 */
export function getChildrenForElement(
	element: TreeElement | undefined,
	rootElements: TreeElement[],
): TreeElement[] {
	// Root level - return root elements (usually GitStatusGroups)
	if (!element) {
		return rootElements;
	}

	// Level 1: GitStatusGroup → return TimeGroups
	if (isGitStatusGroup(element)) {
		return element.timeGroups;
	}

	// Level 2: TimeGroup → return GitChangeItems
	if (isTimeGroup(element)) {
		return element.children;
	}

	// Level 3: GitChangeItem → no children (leaf node)
	if (isGitChangeItem(element)) {
		return [];
	}

	// Unknown element type - defensive programming
	console.warn(`Unknown element type in getChildrenForElement:`, element);
	return [];
}

/**
 * Get parent for any tree element
 *
 * Useful for TreeDataProvider.getParent() implementation.
 *
 * @param element - Child element
 * @param parentMap - Map of child to parent (provider must maintain this)
 * @returns Parent element or undefined if root
 */
export function getParentForElement(
	element: TreeElement,
	parentMap: Map<TreeElement, GitStatusGroup | TimeGroup | undefined>,
): GitStatusGroup | TimeGroup | undefined {
	return parentMap.get(element);
}

/**
 * Build a parent map for efficient parent lookups
 *
 * Traverses the tree and creates a Map for O(1) parent lookups.
 * Call this whenever the tree structure changes.
 *
 * @param rootElements - Root elements (usually GitStatusGroups)
 * @returns Map of child to parent
 */
export function buildParentMap(
	rootElements: GitStatusGroup[],
): Map<TreeElement, GitStatusGroup | TimeGroup | undefined> {
	const parentMap = new Map<
		TreeElement,
		GitStatusGroup | TimeGroup | undefined
	>();

	for (const statusGroup of rootElements) {
		// TimeGroups have GitStatusGroup as parent
		for (const timeGroup of statusGroup.timeGroups) {
			parentMap.set(timeGroup, statusGroup);

			// GitChangeItems have TimeGroup as parent
			for (const changeItem of timeGroup.children) {
				parentMap.set(changeItem, timeGroup);
			}
		}
	}

	return parentMap;
}

/**
 * Count total files in a GitStatusGroup
 *
 * Sums file counts across all time groups.
 *
 * @param statusGroup - Status group to count
 * @returns Total file count
 */
export function countFilesInStatusGroup(statusGroup: GitStatusGroup): number {
	return statusGroup.timeGroups.reduce(
		(sum, timeGroup) => sum + timeGroup.children.length,
		0,
	);
}

/**
 * Find element by URI
 *
 * Searches entire tree for a GitChangeItem with matching URI.
 * Useful for reveal operations.
 *
 * @param rootElements - Root elements to search
 * @param uri - URI to find
 * @returns GitChangeItem if found, undefined otherwise
 */
export function findElementByUri(
	rootElements: GitStatusGroup[],
	uri: string,
): GitChangeItem | undefined {
	for (const statusGroup of rootElements) {
		for (const timeGroup of statusGroup.timeGroups) {
			for (const changeItem of timeGroup.children) {
				if (changeItem.uri.toString() === uri) {
					return changeItem;
				}
			}
		}
	}
	return undefined;
}

/**
 * Get all files from tree
 *
 * Flattens the hierarchy into a flat array of GitChangeItems.
 * Useful for bulk operations.
 *
 * @param rootElements - Root elements
 * @returns Flat array of all GitChangeItems
 */
export function getAllFiles(rootElements: GitStatusGroup[]): GitChangeItem[] {
	const files: GitChangeItem[] = [];

	for (const statusGroup of rootElements) {
		for (const timeGroup of statusGroup.timeGroups) {
			files.push(...timeGroup.children);
		}
	}

	return files;
}
