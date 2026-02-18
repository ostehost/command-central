/**
 * Tree Element Validator Tests
 *
 * Tests the validation logic for tree hierarchy to prevent UI corruption.
 * Focuses on error detection and defensive programming.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import * as vscode from "vscode";
import type {
	GitChangeItem,
	GitStatusGroup,
	TimeGroup,
} from "../../src/types/tree-element.js";
import { validateTreeHierarchy } from "../../src/types/tree-element-validator.js";
import { createMockUri } from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("validateTreeHierarchy", () => {
	beforeEach(() => {
		setupVSCodeMock();
	});

	/**
	 * Test root element validation
	 */
	describe("root element validation", () => {
		test("returns error when tree root is null", () => {
			const result = validateTreeHierarchy(null);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Tree root must be an object");
		});

		test("returns error when tree root is undefined", () => {
			const result = validateTreeHierarchy(undefined);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Tree root must be an object");
		});

		test("returns error when tree root is not an object", () => {
			const result = validateTreeHierarchy("not an object");

			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Tree root must be an object");
		});

		test("returns error for unknown element type", () => {
			const unknown = { type: "unknown", data: "test" };
			const result = validateTreeHierarchy(unknown);

			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]).toContain("Unknown element type");
		});

		test("returns error for object without type", () => {
			const noType = { data: "test" };
			const result = validateTreeHierarchy(noType);

			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
		});
	});

	/**
	 * Test GitStatusGroup validation
	 */
	describe("GitStatusGroup validation", () => {
		test("returns error when statusType is missing", () => {
			const group: Partial<GitStatusGroup> = {
				type: "gitStatusGroup",
				label: "Test",
				totalCount: 0,
				timeGroups: [],
			};

			const result = validateTreeHierarchy(group);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain("GitStatusGroup missing statusType");
		});

		test("returns error when statusType is invalid", () => {
			// INTENTIONAL: Testing validator with invalid statusType
			const group = {
				type: "gitStatusGroup",
				statusType: "invalid",
				label: "Test",
				totalCount: 0,
				timeGroups: [],
			} as unknown as GitStatusGroup;

			const result = validateTreeHierarchy(group);

			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("invalid statusType"))).toBe(
				true,
			);
		});

		test("returns error when label is missing", () => {
			const group: Partial<GitStatusGroup> = {
				type: "gitStatusGroup",
				statusType: "staged",
				totalCount: 0,
				timeGroups: [],
			};

			const result = validateTreeHierarchy(group);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain("GitStatusGroup missing label");
		});

		test("returns error when totalCount is invalid", () => {
			// INTENTIONAL: Testing validator with invalid totalCount
			const group = {
				type: "gitStatusGroup",
				statusType: "staged",
				label: "Test",
				totalCount: -1,
				timeGroups: [],
			} as unknown as GitStatusGroup;

			const result = validateTreeHierarchy(group);

			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("invalid totalCount"))).toBe(
				true,
			);
		});

		test("returns error when timeGroups is not an array", () => {
			// INTENTIONAL: Testing validator with invalid timeGroups type
			const group = {
				type: "gitStatusGroup",
				statusType: "staged",
				label: "Test",
				totalCount: 0,
				timeGroups: "not an array",
			} as unknown as GitStatusGroup;

			const result = validateTreeHierarchy(group);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"GitStatusGroup.timeGroups must be an array",
			);
		});

		test("returns error when timeGroups contains null child", () => {
			// INTENTIONAL: Testing validator with null child
			const group = {
				type: "gitStatusGroup",
				statusType: "staged",
				label: "Test",
				totalCount: 0,
				timeGroups: [null],
			} as unknown as GitStatusGroup;

			const result = validateTreeHierarchy(group);

			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("null or undefined"))).toBe(
				true,
			);
		});

		test("returns error when timeGroups contains wrong child type", () => {
			// INTENTIONAL: Testing validator with wrong child type
			const group = {
				type: "gitStatusGroup",
				statusType: "staged",
				label: "Test",
				totalCount: 0,
				timeGroups: [{ type: "gitChangeItem" }],
			} as unknown as GitStatusGroup;

			const result = validateTreeHierarchy(group);

			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("invalid child type"))).toBe(
				true,
			);
		});

		test("returns warning when totalCount doesn't match actual count", () => {
			const group: GitStatusGroup = {
				type: "gitStatusGroup",
				statusType: "staged",
				label: "Test",
				totalCount: 5,
				timeGroups: [
					{
						type: "timeGroup",
						label: "Today",
						timePeriod: "today",
						children: [
							{
								type: "gitChangeItem",
								uri: createMockUri("/test.ts"),
								status: "Modified",
								isStaged: true,
								timestamp: Date.now(),
							},
						],
						collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
						contextValue: "timeGroup",
					},
				],
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
				contextValue: "gitStatusGroup",
			};

			const result = validateTreeHierarchy(group);

			expect(result.warnings.length).toBeGreaterThan(0);
			expect(
				result.warnings.some((w) => w.includes("doesn't match actual")),
			).toBe(true);
		});
	});

	/**
	 * Test TimeGroup validation
	 */
	describe("TimeGroup validation", () => {
		test("returns error when label is missing", () => {
			const group: Partial<TimeGroup> = {
				type: "timeGroup",
				timePeriod: "today",
				children: [],
			};

			const result = validateTreeHierarchy(group);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain("TimeGroup missing label");
		});

		test("returns error when timePeriod is missing", () => {
			const group: Partial<TimeGroup> = {
				type: "timeGroup",
				label: "Test",
				children: [],
			};

			const result = validateTreeHierarchy(group);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain("TimeGroup missing timePeriod");
		});

		test("returns error when timePeriod is invalid", () => {
			// INTENTIONAL: Testing validator with invalid timePeriod
			const group = {
				type: "timeGroup",
				label: "Test",
				timePeriod: "invalid",
				children: [],
			} as unknown as TimeGroup;

			const result = validateTreeHierarchy(group);

			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("invalid timePeriod"))).toBe(
				true,
			);
		});

		test("returns error when children is not an array", () => {
			// INTENTIONAL: Testing validator with invalid children type
			const group = {
				type: "timeGroup",
				label: "Test",
				timePeriod: "today",
				children: "not an array",
			} as unknown as TimeGroup;

			const result = validateTreeHierarchy(group);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain("TimeGroup.children must be an array");
		});

		test("returns error when children contains null", () => {
			// INTENTIONAL: Testing validator with null child
			const group = {
				type: "timeGroup",
				label: "Test",
				timePeriod: "today",
				children: [null],
			} as unknown as TimeGroup;

			const result = validateTreeHierarchy(group);

			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("null or undefined"))).toBe(
				true,
			);
		});

		test("returns error when children contains wrong type", () => {
			// INTENTIONAL: Testing validator with wrong child type
			const group = {
				type: "timeGroup",
				label: "Test",
				timePeriod: "today",
				children: [{ type: "timeGroup" }],
			} as unknown as TimeGroup;

			const result = validateTreeHierarchy(group);

			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("invalid child type"))).toBe(
				true,
			);
		});
	});

	/**
	 * Test GitChangeItem validation
	 */
	describe("GitChangeItem validation", () => {
		test("returns error when uri is missing", () => {
			const item: Partial<GitChangeItem> = {
				type: "gitChangeItem",
				status: "Modified",
				isStaged: false,
			};

			const result = validateTreeHierarchy(item);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain("GitChangeItem missing uri");
		});

		test("returns error when status is missing", () => {
			const item: Partial<GitChangeItem> = {
				type: "gitChangeItem",
				uri: createMockUri("/test.ts"),
				isStaged: false,
			};

			const result = validateTreeHierarchy(item);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain("GitChangeItem missing status");
		});

		test("returns error when isStaged is not boolean", () => {
			// INTENTIONAL: Testing validator with invalid isStaged type
			const item = {
				type: "gitChangeItem",
				uri: { fsPath: "/test.ts" },
				status: "Modified",
				isStaged: "not a boolean",
			} as unknown as GitChangeItem;

			const result = validateTreeHierarchy(item);

			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("invalid isStaged"))).toBe(
				true,
			);
		});

		test("returns warning when timestamp is negative", () => {
			const item: GitChangeItem = {
				type: "gitChangeItem",
				uri: createMockUri("/test.ts"),
				status: "Modified",
				isStaged: false,
				timestamp: -1,
			};

			const result = validateTreeHierarchy(item);

			expect(result.warnings.length).toBeGreaterThan(0);
			expect(result.warnings.some((w) => w.includes("invalid timestamp"))).toBe(
				true,
			);
		});

		test("returns warning when timestamp is in the future", () => {
			const futureTimestamp = Date.now() + 86400000; // +1 day
			const item: GitChangeItem = {
				type: "gitChangeItem",
				uri: createMockUri("/test.ts"),
				status: "Modified",
				isStaged: false,
				timestamp: futureTimestamp,
			};

			const result = validateTreeHierarchy(item);

			expect(result.warnings.length).toBeGreaterThan(0);
			expect(result.warnings.some((w) => w.includes("future timestamp"))).toBe(
				true,
			);
		});

		test("returns warning when order is invalid", () => {
			const item: GitChangeItem = {
				type: "gitChangeItem",
				uri: createMockUri("/test.ts"),
				status: "Modified",
				isStaged: false,
				timestamp: Date.now(),
				order: 0,
			};

			const result = validateTreeHierarchy(item);

			expect(result.warnings.length).toBeGreaterThan(0);
			expect(result.warnings.some((w) => w.includes("invalid order"))).toBe(
				true,
			);
		});
	});

	/**
	 * Test valid structures
	 */
	describe("valid structures", () => {
		test("returns valid for well-formed GitStatusGroup", () => {
			const group: GitStatusGroup = {
				type: "gitStatusGroup",
				statusType: "staged",
				label: "Staged Changes",
				totalCount: 1,
				timeGroups: [
					{
						type: "timeGroup",
						label: "Today",
						timePeriod: "today",
						children: [
							{
								type: "gitChangeItem",
								uri: createMockUri("/test.ts"),
								status: "Modified",
								isStaged: true,
								timestamp: Date.now(),
								order: 1,
							},
						],
						collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
						contextValue: "timeGroup",
					},
				],
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
				contextValue: "gitStatusGroup",
			};

			const result = validateTreeHierarchy(group);

			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		test("returns valid for well-formed TimeGroup", () => {
			const group: TimeGroup = {
				type: "timeGroup",
				label: "Today",
				timePeriod: "today",
				children: [
					{
						type: "gitChangeItem",
						uri: createMockUri("/test.ts"),
						status: "Modified",
						isStaged: true,
						timestamp: Date.now(),
					},
				],
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
				contextValue: "timeGroup",
			};

			const result = validateTreeHierarchy(group);

			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		test("returns valid for well-formed GitChangeItem", () => {
			const item: GitChangeItem = {
				type: "gitChangeItem",
				uri: createMockUri("/test.ts"),
				status: "Modified",
				isStaged: false,
				timestamp: Date.now(),
				order: 1,
			};

			const result = validateTreeHierarchy(item);

			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		test("returns valid for GitChangeItem without optional fields", () => {
			const item: GitChangeItem = {
				type: "gitChangeItem",
				uri: createMockUri("/test.ts"),
				status: "Modified",
				isStaged: false,
			};

			const result = validateTreeHierarchy(item);

			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});
	});
});
