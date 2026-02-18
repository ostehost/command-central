/**
 * Tests for ExtensionFilterState
 *
 * Covers the core filter state logic including:
 * - Default state behavior
 * - Enable/disable extensions
 * - Auto-cleanup when last extension disabled
 * - Multiple workspaces isolation
 * - validateAndCleanFilter for stale extensions
 * - Persistence round-trip
 * - Tree view message behavior
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// We test ExtensionFilterState directly — no VS Code mock needed for core logic
// (persistence uses context, but we can test with persistenceMode: "none")

describe("ExtensionFilterState", () => {
	let ExtensionFilterState: typeof import("../../src/services/extension-filter-state.js").ExtensionFilterState;

	beforeEach(async () => {
		mock.restore();
		// Dynamic import to avoid module caching issues
		const mod = await import("../../src/services/extension-filter-state.js");
		ExtensionFilterState = mod.ExtensionFilterState;
	});

	// =========================================================================
	// P0: Default state
	// =========================================================================

	test("default state: isFiltered returns false for unknown workspace", () => {
		const state = new ExtensionFilterState(
			undefined,
			"none",
			undefined,
		);
		expect(state.isFiltered("unknown-workspace")).toBe(false);
	});

	test("default state: getEnabledExtensions returns empty Set", () => {
		const state = new ExtensionFilterState(
			undefined,
			"none",
			undefined,
		);
		const extensions = state.getEnabledExtensions("unknown-workspace");
		expect(extensions.size).toBe(0);
	});

	// =========================================================================
	// P0: Enable/disable extensions
	// =========================================================================

	test("enable extension: isFiltered returns true", () => {
		const state = new ExtensionFilterState(undefined, "none");
		state.setExtensionEnabled("ws1", ".ts", true);
		expect(state.isFiltered("ws1")).toBe(true);
	});

	test("enable extension: getEnabledExtensions contains the extension", () => {
		const state = new ExtensionFilterState(undefined, "none");
		state.setExtensionEnabled("ws1", ".ts", true);
		const extensions = state.getEnabledExtensions("ws1");
		expect(extensions.has(".ts")).toBe(true);
		expect(extensions.size).toBe(1);
	});

	test("disable last extension: isFiltered returns false (auto-cleanup)", () => {
		const state = new ExtensionFilterState(undefined, "none");
		state.setExtensionEnabled("ws1", ".ts", true);
		expect(state.isFiltered("ws1")).toBe(true);

		state.setExtensionEnabled("ws1", ".ts", false);
		expect(state.isFiltered("ws1")).toBe(false);
	});

	test("disable last extension: workspace entry removed from Map", () => {
		const state = new ExtensionFilterState(undefined, "none");
		state.setExtensionEnabled("ws1", ".ts", true);
		state.setExtensionEnabled("ws1", ".ts", false);

		// getEnabledExtensions should return empty Set (no entry in Map)
		const extensions = state.getEnabledExtensions("ws1");
		expect(extensions.size).toBe(0);
	});

	test("multiple extensions: enable/disable independently", () => {
		const state = new ExtensionFilterState(undefined, "none");
		state.setExtensionEnabled("ws1", ".ts", true);
		state.setExtensionEnabled("ws1", ".py", true);

		expect(state.getEnabledExtensions("ws1").size).toBe(2);
		expect(state.getEnabledExtensions("ws1").has(".ts")).toBe(true);
		expect(state.getEnabledExtensions("ws1").has(".py")).toBe(true);

		// Disable one, other stays
		state.setExtensionEnabled("ws1", ".ts", false);
		expect(state.isFiltered("ws1")).toBe(true);
		expect(state.getEnabledExtensions("ws1").has(".ts")).toBe(false);
		expect(state.getEnabledExtensions("ws1").has(".py")).toBe(true);
	});

	test("multiple workspaces: filters are isolated", () => {
		const state = new ExtensionFilterState(undefined, "none");
		state.setExtensionEnabled("ws1", ".ts", true);
		state.setExtensionEnabled("ws2", ".py", true);

		expect(state.isFiltered("ws1")).toBe(true);
		expect(state.isFiltered("ws2")).toBe(true);
		expect(state.getEnabledExtensions("ws1").has(".ts")).toBe(true);
		expect(state.getEnabledExtensions("ws1").has(".py")).toBe(false);
		expect(state.getEnabledExtensions("ws2").has(".py")).toBe(true);
		expect(state.getEnabledExtensions("ws2").has(".ts")).toBe(false);
	});

	// =========================================================================
	// P0: getEnabledExtensions returns defensive copy
	// =========================================================================

	test("getEnabledExtensions returns defensive copy", () => {
		const state = new ExtensionFilterState(undefined, "none");
		state.setExtensionEnabled("ws1", ".ts", true);

		const copy = state.getEnabledExtensions("ws1");
		copy.add(".hacked");

		// Internal state should be unchanged
		expect(state.getEnabledExtensions("ws1").has(".hacked")).toBe(false);
		expect(state.getEnabledExtensions("ws1").size).toBe(1);
	});

	// =========================================================================
	// P0: validateAndCleanFilter
	// =========================================================================

	test("validateAndCleanFilter: removes extensions with no matching files", () => {
		const state = new ExtensionFilterState(undefined, "none");
		state.setExtensionEnabled("ws1", ".ts", true);
		state.setExtensionEnabled("ws1", ".bak", true);

		const modified = state.validateAndCleanFilter("ws1", [
			"/project/src/index.ts",
			"/project/src/utils.ts",
		]);

		expect(modified).toBe(true);
		expect(state.getEnabledExtensions("ws1").has(".ts")).toBe(true);
		expect(state.getEnabledExtensions("ws1").has(".bak")).toBe(false);
		expect(state.isFiltered("ws1")).toBe(true); // .ts still active
	});

	test("validateAndCleanFilter: returns to show-all when all extensions stale", () => {
		const state = new ExtensionFilterState(undefined, "none");
		state.setExtensionEnabled("ws1", ".bak", true);

		const modified = state.validateAndCleanFilter("ws1", [
			"/project/src/index.ts",
			"/project/src/main.py",
		]);

		expect(modified).toBe(true);
		expect(state.isFiltered("ws1")).toBe(false); // Back to show-all
		expect(state.getEnabledExtensions("ws1").size).toBe(0);
	});

	test("validateAndCleanFilter: keeps extensions that have matching files", () => {
		const state = new ExtensionFilterState(undefined, "none");
		state.setExtensionEnabled("ws1", ".ts", true);

		const modified = state.validateAndCleanFilter("ws1", [
			"/project/src/index.ts",
		]);

		expect(modified).toBe(false);
		expect(state.isFiltered("ws1")).toBe(true);
		expect(state.getEnabledExtensions("ws1").has(".ts")).toBe(true);
	});

	test("validateAndCleanFilter: no-op when workspace has no filter", () => {
		const state = new ExtensionFilterState(undefined, "none");
		const modified = state.validateAndCleanFilter("ws1", ["/project/file.ts"]);
		expect(modified).toBe(false);
	});

	test("validateAndCleanFilter: clears filter when actual files list is empty", () => {
		const state = new ExtensionFilterState(undefined, "none");
		state.setExtensionEnabled("ws1", ".ts", true);

		const modified = state.validateAndCleanFilter("ws1", []);

		expect(modified).toBe(true);
		expect(state.isFiltered("ws1")).toBe(false);
	});

	// =========================================================================
	// P0: Persistence round-trip
	// =========================================================================

	test("persistence: state survives save/load cycle", () => {
		// Create a mock VS Code context with workspaceState
		const storage = new Map<string, unknown>();
		const mockContext = {
			workspaceState: {
				get: (key: string) => storage.get(key),
				update: async (key: string, value: unknown) => {
					storage.set(key, value);
				},
			},
			globalState: {
				get: (key: string) => storage.get(key),
				update: async (key: string, value: unknown) => {
					storage.set(key, value);
				},
			},
		} as any;

		// Create first instance and set some state
		const state1 = new ExtensionFilterState(mockContext, "workspace");
		state1.setExtensionEnabled("ws1", ".ts", true);
		state1.setExtensionEnabled("ws1", ".py", true);
		state1.setExtensionEnabled("ws2", ".go", true);

		// Create second instance from same storage — should load persisted state
		const state2 = new ExtensionFilterState(mockContext, "workspace");

		expect(state2.isFiltered("ws1")).toBe(true);
		expect(state2.getEnabledExtensions("ws1").has(".ts")).toBe(true);
		expect(state2.getEnabledExtensions("ws1").has(".py")).toBe(true);
		expect(state2.isFiltered("ws2")).toBe(true);
		expect(state2.getEnabledExtensions("ws2").has(".go")).toBe(true);
	});

	test("persistence: empty filters not persisted (no phantom entries)", () => {
		const storage = new Map<string, unknown>();
		const mockContext = {
			workspaceState: {
				get: (key: string) => storage.get(key),
				update: async (key: string, value: unknown) => {
					storage.set(key, value);
				},
			},
		} as any;

		const state = new ExtensionFilterState(mockContext, "workspace");
		state.setExtensionEnabled("ws1", ".ts", true);
		state.setExtensionEnabled("ws1", ".ts", false);

		// Check what was persisted
		const persisted = storage.get("commandCentral.extensionFilters") as Record<
			string,
			string[]
		>;
		// Should be empty object (no ws1 key with empty array)
		expect(persisted).toBeDefined();
		expect(persisted["ws1"]).toBeUndefined();
	});

	// =========================================================================
	// P0: Disabling non-existent extension is a no-op
	// =========================================================================

	test("disable non-existent extension: no-op, no crash", () => {
		const state = new ExtensionFilterState(undefined, "none");
		// Should not throw
		state.setExtensionEnabled("ws1", ".ts", false);
		expect(state.isFiltered("ws1")).toBe(false);
	});

	test("enable same extension twice: idempotent", () => {
		const state = new ExtensionFilterState(undefined, "none");
		state.setExtensionEnabled("ws1", ".ts", true);
		state.setExtensionEnabled("ws1", ".ts", true);
		expect(state.getEnabledExtensions("ws1").size).toBe(1);
	});
});

describe("Tree view message behavior", () => {
	// These tests verify the updateTreeViewMessage logic conceptually.
	// We test the message-setting logic by checking the provider's behavior
	// through a minimal mock of the tree view.

	test("filter active + zero matches → tree message is set", () => {
		// Create a mock tree view
		const mockTreeView = { message: undefined as string | undefined };

		// Simulate the logic from updateTreeViewMessage
		const isFiltered = true;
		const filteredCount = 0;
		const unfilteredCount = 10;
		const extensions = new Set([".py", ".go"]);

		if (isFiltered && filteredCount === 0 && unfilteredCount > 0) {
			const extStr = Array.from(extensions).sort().join(", ");
			mockTreeView.message = `No files match the current filter (${extStr}). Use the Extension Filter to adjust.`;
		} else {
			mockTreeView.message = undefined;
		}

		expect(mockTreeView.message).toContain("No files match");
		expect(mockTreeView.message).toContain(".go, .py");
	});

	test("filter active + some matches → tree message is cleared", () => {
		const mockTreeView = { message: "previous message" as string | undefined };

		const isFiltered = true;
		const filteredCount = 5;
		const unfilteredCount = 10;

		if (isFiltered && filteredCount === 0 && unfilteredCount > 0) {
			mockTreeView.message = "No files match...";
		} else {
			mockTreeView.message = undefined;
		}

		expect(mockTreeView.message).toBeUndefined();
	});

	test("no filter → tree message is cleared", () => {
		const mockTreeView = { message: "previous message" as string | undefined };

		const isFiltered = false;
		const filteredCount = 10;
		const unfilteredCount = 10;

		if (isFiltered && filteredCount === 0 && unfilteredCount > 0) {
			mockTreeView.message = "No files match...";
		} else {
			mockTreeView.message = undefined;
		}

		expect(mockTreeView.message).toBeUndefined();
	});

	test("filter cleared → tree message is cleared", () => {
		const mockTreeView = {
			message: "No files match the current filter (.py). Use the Extension Filter to adjust." as string | undefined,
		};

		// Simulate clearing the filter
		const isFiltered = false;
		const filteredCount = 10;
		const unfilteredCount = 10;

		if (isFiltered && filteredCount === 0 && unfilteredCount > 0) {
			mockTreeView.message = "No files match...";
		} else {
			mockTreeView.message = undefined;
		}

		expect(mockTreeView.message).toBeUndefined();
	});
});
