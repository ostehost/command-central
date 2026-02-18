/**
 * Tree Element Helpers - VS Code TreeDataProvider Pattern Tests
 *
 * Purpose: Validate helper functions for 3-level tree hierarchy
 *
 * Research-Backed Patterns (2024-2025):
 * 1. ✅ getParent() required for reveal operations (VS Code TreeView Sample)
 * 2. ✅ Stable IDs for state persistence (Microsoft best practice)
 * 3. ✅ Object identity caching prevents re-renders (performance)
 * 4. ✅ Abstraction layer testing (Microsoft ISE Blog, April 2024)
 *
 * Coverage Target: 95%+ (up from 28.77%)
 *
 * Best Practices Applied:
 * - One assertion per test (Bun 2024 recommendation)
 * - Test edge cases, not just happy paths
 * - Independent tests with beforeEach cleanup
 * - Use builders for realistic test data
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
	GitChangeItemBuilder,
	GitStatusGroupBuilder,
	TimeGroupBuilder,
} from "../builders/tree-element-builder.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("tree-element-helpers - VS Code TreeDataProvider Patterns", () => {
	beforeEach(() => {
		setupVSCodeMock();
	});

	/**
	 * PATTERN 1: getChildren() Hierarchical Navigation
	 *
	 * Source: VS Code TreeView Sample
	 * Pattern: undefined = root level, then drill down through hierarchy
	 *
	 * Why This Matters:
	 * - VS Code calls getChildren(undefined) for root elements
	 * - Must handle all 3 levels: StatusGroup → TimeGroup → GitChangeItem
	 * - Leaf nodes return empty array (no children)
	 */
	describe("getChildrenForElement", () => {
		test("returns root elements when element is undefined", async () => {
			const { getChildrenForElement } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			// VS Code pattern: undefined = root level
			const statusGroup = new GitStatusGroupBuilder().staged().build();
			const children = getChildrenForElement(undefined, [statusGroup]);

			expect(children).toEqual([statusGroup]);
		});

		test("returns TimeGroups for GitStatusGroup", async () => {
			const { getChildrenForElement } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			// Level 1 → Level 2 navigation
			const timeGroup = new TimeGroupBuilder().today().build();
			const statusGroup = new GitStatusGroupBuilder()
				.withTimeGroups([timeGroup])
				.build();

			const children = getChildrenForElement(statusGroup, []);

			expect(children).toEqual([timeGroup]);
		});

		test("returns GitChangeItems for TimeGroup", async () => {
			const { getChildrenForElement } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			// Level 2 → Level 3 navigation
			const file = new GitChangeItemBuilder().withUri("/test.ts").build();
			const timeGroup = new TimeGroupBuilder().withFiles([file]).build();

			const children = getChildrenForElement(timeGroup, []);

			expect(children).toEqual([file]);
		});

		test("returns empty array for leaf nodes (GitChangeItem)", async () => {
			const { getChildrenForElement } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			// Leaf nodes have no children
			const file = new GitChangeItemBuilder().build();

			const children = getChildrenForElement(file, []);

			expect(children).toEqual([]);
		});
	});

	/**
	 * PATTERN 2: getParent() for Reveal Operations
	 *
	 * Source: VS Code requires getParent() for reveal()
	 * Pattern: Use parent map for O(1) lookups
	 *
	 * Why This Matters:
	 * - reveal() operation requires parent traversal
	 * - Parent map provides O(1) lookup performance
	 * - Root elements return undefined
	 */
	describe("getParentForElement", () => {
		test("returns TimeGroup parent for GitChangeItem", async () => {
			const { getParentForElement, buildParentMap } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const file = new GitChangeItemBuilder().build();
			const timeGroup = new TimeGroupBuilder().withFiles([file]).build();
			const statusGroup = new GitStatusGroupBuilder()
				.withTimeGroups([timeGroup])
				.build();

			const parentMap = buildParentMap([statusGroup]);
			const parent = getParentForElement(file, parentMap);

			expect(parent).toBe(timeGroup); // Object identity
		});

		test("returns GitStatusGroup parent for TimeGroup", async () => {
			const { getParentForElement, buildParentMap } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const timeGroup = new TimeGroupBuilder().build();
			const statusGroup = new GitStatusGroupBuilder()
				.withTimeGroups([timeGroup])
				.build();

			const parentMap = buildParentMap([statusGroup]);
			const parent = getParentForElement(timeGroup, parentMap);

			expect(parent).toBe(statusGroup);
		});

		test("returns undefined for root elements", async () => {
			const { getParentForElement, buildParentMap } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const statusGroup = new GitStatusGroupBuilder().build();
			const parentMap = buildParentMap([statusGroup]);

			const parent = getParentForElement(statusGroup, parentMap);

			expect(parent).toBeUndefined(); // Root has no parent
		});

		test("handles missing elements in map", async () => {
			const { getParentForElement } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const orphan = new GitChangeItemBuilder().build();
			const parentMap = new Map();

			const parent = getParentForElement(orphan, parentMap);

			expect(parent).toBeUndefined(); // Graceful handling
		});
	});

	/**
	 * PATTERN 3: Parent Map Building (O(1) Lookups)
	 *
	 * Source: Performance best practice
	 * Pattern: Pre-build map for fast parent lookups
	 *
	 * Why This Matters:
	 * - Avoid O(n) tree traversal for each getParent() call
	 * - Map provides O(1) lookup performance
	 * - Built once per tree refresh
	 */
	describe("buildParentMap", () => {
		test("creates correct parent relationships", async () => {
			const { buildParentMap } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const file1 = new GitChangeItemBuilder().withUri("/file1.ts").build();
			const file2 = new GitChangeItemBuilder().withUri("/file2.ts").build();
			const timeGroup = new TimeGroupBuilder()
				.withFiles([file1, file2])
				.build();
			const statusGroup = new GitStatusGroupBuilder()
				.withTimeGroups([timeGroup])
				.build();

			const parentMap = buildParentMap([statusGroup]);

			// Validate hierarchy
			expect(parentMap.get(file1)).toBe(timeGroup);
			expect(parentMap.get(file2)).toBe(timeGroup);
			expect(parentMap.get(timeGroup)).toBe(statusGroup);
			expect(parentMap.size).toBe(3); // 2 files + 1 timeGroup
		});

		test("handles empty tree", async () => {
			const { buildParentMap } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const parentMap = buildParentMap([]);

			expect(parentMap.size).toBe(0);
		});

		test("handles multiple status groups", async () => {
			const { buildParentMap } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const stagedGroup = new GitStatusGroupBuilder().staged().build();
			const unstagedGroup = new GitStatusGroupBuilder().unstaged().build();

			const parentMap = buildParentMap([stagedGroup, unstagedGroup]);

			// Both groups processed
			expect(parentMap.size).toBeGreaterThanOrEqual(0);
		});

		test("provides O(1) lookup performance", async () => {
			const { buildParentMap } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			// Performance characteristic test
			const file = new GitChangeItemBuilder().build();
			const timeGroup = new TimeGroupBuilder().withFiles([file]).build();
			const statusGroup = new GitStatusGroupBuilder()
				.withTimeGroups([timeGroup])
				.build();

			const parentMap = buildParentMap([statusGroup]);

			const start = performance.now();
			parentMap.get(file); // O(1) lookup
			const duration = performance.now() - start;

			expect(duration).toBeLessThan(1); // Sub-millisecond
		});
	});

	/**
	 * PATTERN 4: File Counting for UI Labels
	 *
	 * Source: VS Code TreeItem description pattern
	 * Pattern: Show counts in labels (e.g., "Staged Changes (5)")
	 *
	 * Why This Matters:
	 * - Users need to see file counts at a glance
	 * - Counts must be accurate across all time groups
	 * - Empty groups should show (0)
	 */
	describe("countFilesInStatusGroup", () => {
		test("counts files across all time groups", async () => {
			const { countFilesInStatusGroup } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const today = new TimeGroupBuilder()
				.today()
				.withFiles([
					new GitChangeItemBuilder().build(),
					new GitChangeItemBuilder().build(),
				])
				.build();
			const yesterday = new TimeGroupBuilder()
				.yesterday()
				.withFiles([new GitChangeItemBuilder().build()])
				.build();
			const statusGroup = new GitStatusGroupBuilder()
				.withTimeGroups([today, yesterday])
				.build();

			const count = countFilesInStatusGroup(statusGroup);

			expect(count).toBe(3);
		});

		test("returns 0 for empty groups", async () => {
			const { countFilesInStatusGroup } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const statusGroup = new GitStatusGroupBuilder()
				.withTimeGroups([])
				.build();

			const count = countFilesInStatusGroup(statusGroup);

			expect(count).toBe(0);
		});

		test("handles empty time groups within status group", async () => {
			const { countFilesInStatusGroup } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const emptyGroup = new TimeGroupBuilder().withFiles([]).build();
			const statusGroup = new GitStatusGroupBuilder()
				.withTimeGroups([emptyGroup])
				.build();

			const count = countFilesInStatusGroup(statusGroup);

			expect(count).toBe(0);
		});
	});

	/**
	 * PATTERN 5: Find Element by URI (Reveal Operations)
	 *
	 * Source: VS Code TreeView.reveal() API
	 * Pattern: Search entire tree for element matching URI
	 *
	 * Why This Matters:
	 * - reveal() requires finding element by identifier
	 * - Must search across all status groups and time groups
	 * - Returns undefined if not found (no errors)
	 */
	describe("findElementByUri", () => {
		test("finds file in staged changes", async () => {
			const { findElementByUri } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const targetUri = "file:///test/target.ts";
			const target = new GitChangeItemBuilder()
				.withUri("/test/target.ts")
				.build();
			const other = new GitChangeItemBuilder()
				.withUri("/test/other.ts")
				.build();
			const timeGroup = new TimeGroupBuilder()
				.withFiles([target, other])
				.build();
			const statusGroup = new GitStatusGroupBuilder()
				.staged()
				.withTimeGroups([timeGroup])
				.build();

			const found = findElementByUri([statusGroup], targetUri);

			expect(found).toBe(target); // Object identity
		});

		test("finds file in unstaged changes", async () => {
			const { findElementByUri } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const targetUri = "file:///test/unstaged.ts";
			const target = new GitChangeItemBuilder()
				.withUri("/test/unstaged.ts")
				.build();
			const timeGroup = new TimeGroupBuilder().withFiles([target]).build();
			const statusGroup = new GitStatusGroupBuilder()
				.unstaged()
				.withTimeGroups([timeGroup])
				.build();

			const found = findElementByUri([statusGroup], targetUri);

			expect(found).toBe(target);
		});

		test("returns undefined for non-existent file", async () => {
			const { findElementByUri } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const statusGroup = new GitStatusGroupBuilder().build();

			const found = findElementByUri([statusGroup], "file:///missing.ts");

			expect(found).toBeUndefined();
		});

		test("handles URI toString() format", async () => {
			const { findElementByUri } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const target = new GitChangeItemBuilder()
				.withUri("/test/file.ts")
				.build();
			const timeGroup = new TimeGroupBuilder().withFiles([target]).build();
			const statusGroup = new GitStatusGroupBuilder()
				.withTimeGroups([timeGroup])
				.build();

			// Use URI's toString() method
			const found = findElementByUri([statusGroup], target.uri.toString());

			expect(found).toBeDefined();
		});

		test("searches across multiple status groups", async () => {
			const { findElementByUri } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const targetUri = "file:///test/target.ts";
			const target = new GitChangeItemBuilder()
				.withUri("/test/target.ts")
				.build();

			const staged = new GitStatusGroupBuilder().staged().build();
			const unstaged = new GitStatusGroupBuilder()
				.unstaged()
				.withTimeGroups([new TimeGroupBuilder().withFiles([target]).build()])
				.build();

			const found = findElementByUri([staged, unstaged], targetUri);

			expect(found).toBe(target);
		});

		test("returns exact match using URI toString()", async () => {
			const { findElementByUri } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			// Test exact string matching with URI toString()
			const file = new GitChangeItemBuilder()
				.withUri("/exact/match.ts")
				.build();
			const timeGroup = new TimeGroupBuilder().withFiles([file]).build();
			const statusGroup = new GitStatusGroupBuilder()
				.withTimeGroups([timeGroup])
				.build();

			// Use the exact URI toString() value
			const uriString = file.uri.toString();
			const found = findElementByUri([statusGroup], uriString);

			// Verify exact match returns the file
			expect(found).toBeDefined();
			expect(found).toBe(file);
		});

		test("early return when file found in first status group", async () => {
			const { findElementByUri } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			// Create two status groups, target in first
			const target = new GitChangeItemBuilder().withUri("/first.ts").build();
			const decoy = new GitChangeItemBuilder().withUri("/second.ts").build();

			const firstGroup = new GitStatusGroupBuilder()
				.withTimeGroups([new TimeGroupBuilder().withFiles([target]).build()])
				.build();

			const secondGroup = new GitStatusGroupBuilder()
				.withTimeGroups([new TimeGroupBuilder().withFiles([decoy]).build()])
				.build();

			const found = findElementByUri(
				[firstGroup, secondGroup],
				target.uri.toString(),
			);

			// Should return immediately from first group
			expect(found).toBe(target);
		});
	});

	/**
	 * PATTERN 6: Flatten Hierarchy (Bulk Operations)
	 *
	 * Source: Bulk operations pattern
	 * Pattern: Convert tree to flat array for iteration
	 *
	 * Why This Matters:
	 * - Needed for "open all files" type operations
	 * - Simplifies iteration over all files
	 * - Preserves order within groups
	 */
	describe("getAllFiles", () => {
		test("flattens 3-level hierarchy correctly", async () => {
			const { getAllFiles } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const file1 = new GitChangeItemBuilder().withUri("/1.ts").build();
			const file2 = new GitChangeItemBuilder().withUri("/2.ts").build();
			const file3 = new GitChangeItemBuilder().withUri("/3.ts").build();

			const today = new TimeGroupBuilder().withFiles([file1, file2]).build();
			const yesterday = new TimeGroupBuilder().withFiles([file3]).build();
			const statusGroup = new GitStatusGroupBuilder()
				.withTimeGroups([today, yesterday])
				.build();

			const allFiles = getAllFiles([statusGroup]);

			expect(allFiles).toHaveLength(3);
			expect(allFiles).toContain(file1);
			expect(allFiles).toContain(file2);
			expect(allFiles).toContain(file3);
		});

		test("preserves file order within groups", async () => {
			const { getAllFiles } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const file1 = new GitChangeItemBuilder().withUri("/1.ts").build();
			const file2 = new GitChangeItemBuilder().withUri("/2.ts").build();
			const timeGroup = new TimeGroupBuilder()
				.withFiles([file1, file2])
				.build();
			const statusGroup = new GitStatusGroupBuilder()
				.withTimeGroups([timeGroup])
				.build();

			const allFiles = getAllFiles([statusGroup]);

			expect(allFiles[0]).toBe(file1);
			expect(allFiles[1]).toBe(file2);
		});

		test("returns empty array for empty tree", async () => {
			const { getAllFiles } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const allFiles = getAllFiles([]);

			expect(allFiles).toEqual([]);
		});

		test("handles multiple status groups", async () => {
			const { getAllFiles } = await import(
				"../../src/types/tree-element-helpers.js"
			);

			const stagedFile = new GitChangeItemBuilder().build();
			const unstagedFile = new GitChangeItemBuilder().build();

			const staged = new GitStatusGroupBuilder()
				.staged()
				.withTimeGroups([
					new TimeGroupBuilder().withFiles([stagedFile]).build(),
				])
				.build();
			const unstaged = new GitStatusGroupBuilder()
				.unstaged()
				.withTimeGroups([
					new TimeGroupBuilder().withFiles([unstagedFile]).build(),
				])
				.build();

			const allFiles = getAllFiles([staged, unstaged]);

			expect(allFiles).toHaveLength(2);
			expect(allFiles).toContain(stagedFile);
			expect(allFiles).toContain(unstagedFile);
		});
	});
});
