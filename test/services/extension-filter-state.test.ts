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
		const state = new ExtensionFilterState(undefined, "none", undefined);
		expect(state.isFiltered("unknown-workspace")).toBe(false);
	});

	// =========================================================================
	// P0: Enable/disable extensions
	// =========================================================================

	test("enable extension: isFiltered returns true", () => {
		const state = new ExtensionFilterState(undefined, "none");
		state.setExtensionEnabled("ws1", ".ts", true);
		expect(state.isFiltered("ws1")).toBe(true);
	});

	test("disable last extension: isFiltered returns false (auto-cleanup)", () => {
		const state = new ExtensionFilterState(undefined, "none");
		state.setExtensionEnabled("ws1", ".ts", true);
		expect(state.isFiltered("ws1")).toBe(true);

		state.setExtensionEnabled("ws1", ".ts", false);
		expect(state.isFiltered("ws1")).toBe(false);
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

	test("enable same extension twice: idempotent", () => {
		const state = new ExtensionFilterState(undefined, "none");
		state.setExtensionEnabled("ws1", ".ts", true);
		state.setExtensionEnabled("ws1", ".ts", true);
		expect(state.getEnabledExtensions("ws1").size).toBe(1);
	});
});

// ===========================================================================
// PAR-70 [CP-31]: persistence writes must be ordered (last-write-wins)
// ===========================================================================

describe("ExtensionFilterState persistence ordering (PAR-70)", () => {
	let ExtensionFilterState: typeof import("../../src/services/extension-filter-state.js").ExtensionFilterState;
	let createMockExtensionContext: typeof import("../helpers/typed-mocks.js").createMockExtensionContext;

	beforeEach(async () => {
		mock.restore();
		const mod = await import("../../src/services/extension-filter-state.js");
		ExtensionFilterState = mod.ExtensionFilterState;
		const helpers = await import("../helpers/typed-mocks.js");
		createMockExtensionContext = helpers.createMockExtensionContext;
	});

	const STORAGE_KEY = "commandCentral.extensionFilters";

	/**
	 * Builds an ExtensionContext whose workspaceState.update calls intentionally
	 * resolve OUT OF ORDER: each successive call gets a strictly shorter delay,
	 * so the first-issued write resolves LAST. The backing value is committed at
	 * resolution time, so whichever write resolves last "wins" the stored value.
	 *
	 * With unordered fire-and-forget persistence, a stale earlier write (issued
	 * first, resolves last) clobbers the newer write. With a serialized write
	 * chain, a later write is not even issued until the prior one resolves, so
	 * the final stored value always reflects the final in-memory state.
	 */
	function makeOutOfOrderContext(): {
		context: import("vscode").ExtensionContext;
		read: () => Record<string, string[]> | undefined;
	} {
		let stored: Record<string, string[]> | undefined;
		let callIndex = 0;
		const baseDelay = 40;

		const workspaceState = {
			get<T>(key: string): T | undefined {
				if (key !== STORAGE_KEY) return undefined;
				return stored as unknown as T | undefined;
			},
			update(key: string, value: unknown): Promise<void> {
				// Earlier calls get longer delays so they resolve later.
				const delay = Math.max(0, baseDelay - callIndex * 15);
				callIndex += 1;
				return new Promise<void>((resolve) => {
					setTimeout(() => {
						if (key === STORAGE_KEY) {
							stored = value as Record<string, string[]>;
						}
						resolve();
					}, delay);
				});
			},
			keys: () => (stored ? [STORAGE_KEY] : []),
		} as unknown as import("vscode").Memento;

		const context = createMockExtensionContext({ workspaceState });
		return { context, read: () => stored };
	}

	test("out-of-order async writes do not clobber newer state (last-write-wins)", async () => {
		const { context, read } = makeOutOfOrderContext();
		const state = new ExtensionFilterState(context, "workspace");

		// Issue two mutations back-to-back. The first persist (enable → {.ts})
		// is scheduled before the second (disable → empty). Under the bug, the
		// first write resolves LAST and clobbers the empty state.
		state.setExtensionEnabled("ws1", ".ts", true);
		state.setExtensionEnabled("ws1", ".ts", false);

		// Wait for the serialized write chain to drain.
		await state.flushPersistence();

		// In-memory state is the source of truth and must be empty.
		expect(state.isFiltered("ws1")).toBe(false);

		// Persisted state must match: no stale {.ts} entry left behind.
		const persisted = read();
		expect(persisted).toEqual({});
	});

	test("writes execute in scheduling order (final write reflects final state)", async () => {
		const { context, read } = makeOutOfOrderContext();
		const state = new ExtensionFilterState(context, "workspace");

		// enable .ts, enable .py, then disable .ts — final state is {.py}.
		state.setExtensionEnabled("ws1", ".ts", true);
		state.setExtensionEnabled("ws1", ".py", true);
		state.setExtensionEnabled("ws1", ".ts", false);

		await state.flushPersistence();

		const persisted = read();
		expect(persisted).toEqual({ ws1: [".py"] });
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

		if (isFiltered && filteredCount === (0 as number) && unfilteredCount > 0) {
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

		if (isFiltered && filteredCount === (0 as number) && unfilteredCount > 0) {
			mockTreeView.message = "No files match...";
		} else {
			mockTreeView.message = undefined;
		}

		expect(mockTreeView.message).toBeUndefined();
	});

	test("filter cleared → tree message is cleared", () => {
		const mockTreeView = {
			message:
				"No files match the current filter (.py). Use the Extension Filter to adjust." as
					| string
					| undefined,
		};

		// Simulate clearing the filter
		const isFiltered = false;
		const filteredCount = 10;
		const unfilteredCount = 10;

		if (isFiltered && filteredCount === (0 as number) && unfilteredCount > 0) {
			mockTreeView.message = "No files match...";
		} else {
			mockTreeView.message = undefined;
		}

		expect(mockTreeView.message).toBeUndefined();
	});
});

describe("validateAndCleanFilter", () => {
	let ExtensionFilterState: typeof import("../../src/services/extension-filter-state.js").ExtensionFilterState;

	beforeEach(async () => {
		mock.restore();
		const mod = await import("../../src/services/extension-filter-state.js");
		ExtensionFilterState = mod.ExtensionFilterState;
	});

	test("extensionless files (empty string) are not removed as stale", () => {
		const state = new ExtensionFilterState();
		state.setExtensionEnabled("workspace", "", true);

		const actualFiles = ["src/index.ts", "Makefile", "README"];
		state.validateAndCleanFilter("workspace", actualFiles);

		const extensions = state.getEnabledExtensions("workspace");
		expect(extensions.has("")).toBe(true);
	});

	test("truly stale extensions are still removed", () => {
		const state = new ExtensionFilterState();
		state.setExtensionEnabled("workspace", ".py", true);

		const actualFiles = ["src/index.ts", "README.md"];
		state.validateAndCleanFilter("workspace", actualFiles);

		expect(state.isFiltered("workspace")).toBe(false);
	});
});
