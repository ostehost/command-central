/**
 * Tests for FilterStateManager
 *
 * Covers:
 * - Constructor and defensive copy of workspaces
 * - isEnabled: checks extension in specific workspace
 * - setEnabled: updates state and fires onDidChange event
 * - setAllWorkspaces: bulk enable/disable across all workspaces
 * - isGloballyEnabled: checks all (or specific) workspaces
 * - setWorkspaces: update managed workspace list
 * - dispose: cleans up EventEmitter
 * - Edge cases: empty workspaces, single workspace, no relevant workspaces
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { IExtensionFilterState } from "../../src/types/service-interfaces.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal IExtensionFilterState mock backed by an in-memory Map<workspace, Set<extension>>
 */
function createMockFilterState(): IExtensionFilterState & {
	_data: Map<string, Set<string>>;
} {
	const data = new Map<string, Set<string>>();

	return {
		_data: data,
		getEnabledExtensions(workspace: string): Set<string> {
			return data.get(workspace) ?? new Set();
		},
		isFiltered(workspace: string): boolean {
			const set = data.get(workspace);
			return set !== undefined && set.size > 0;
		},
		setExtensionEnabled(
			workspace: string,
			extension: string,
			enabled: boolean,
		): void {
			if (enabled) {
				if (!data.has(workspace)) {
					data.set(workspace, new Set());
				}
				data.get(workspace)?.add(extension);
			} else {
				const set = data.get(workspace);
				if (set) {
					set.delete(extension);
					if (set.size === 0) {
						data.delete(workspace);
					}
				}
			}
		},
		validateAndCleanFilter(_workspace: string, _actualFiles: string[]): boolean {
			// no-op for testing
			return false;
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FilterStateManager", () => {
	let FilterStateManager: typeof import("../../src/state/filter-state-manager.js").FilterStateManager;
	let filterState: ReturnType<typeof createMockFilterState>;

	beforeEach(async () => {
		mock.restore();
		setupVSCodeMock();
		// Re-import each time to get a fresh module with the real EventEmitter from our mock
		const mod = await import("../../src/state/filter-state-manager.js");
		FilterStateManager = mod.FilterStateManager;
		filterState = createMockFilterState();
	});

	// -------------------------------------------------------------------------
	// isEnabled
	// -------------------------------------------------------------------------

	describe("isEnabled", () => {
		test("returns false when extension is not enabled in workspace", () => {
			const manager = new FilterStateManager(filterState, ["ws1"]);
			expect(manager.isEnabled(".ts", "ws1")).toBe(false);
		});

		test("returns true after enabling extension in workspace", () => {
			filterState.setExtensionEnabled("ws1", ".ts", true);
			const manager = new FilterStateManager(filterState, ["ws1"]);
			expect(manager.isEnabled(".ts", "ws1")).toBe(true);
		});

		test("returns false for workspace that has different extension enabled", () => {
			filterState.setExtensionEnabled("ws1", ".py", true);
			const manager = new FilterStateManager(filterState, ["ws1"]);
			expect(manager.isEnabled(".ts", "ws1")).toBe(false);
		});

		test("returns false for unknown workspace", () => {
			const manager = new FilterStateManager(filterState, []);
			expect(manager.isEnabled(".ts", "unknown")).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// setEnabled
	// -------------------------------------------------------------------------

	describe("setEnabled", () => {
		test("enables extension in specific workspace", () => {
			const manager = new FilterStateManager(filterState, ["ws1"]);
			manager.setEnabled(".ts", "ws1", true);
			expect(manager.isEnabled(".ts", "ws1")).toBe(true);
		});

		test("disables extension in specific workspace", () => {
			filterState.setExtensionEnabled("ws1", ".ts", true);
			const manager = new FilterStateManager(filterState, ["ws1"]);
			manager.setEnabled(".ts", "ws1", false);
			expect(manager.isEnabled(".ts", "ws1")).toBe(false);
		});

		test("fires onDidChange event with correct data when enabling", () => {
			const manager = new FilterStateManager(filterState, ["ws1"]);
			const events: import("../../src/state/filter-state-manager.js").StateChangeEvent[] =
				[];
			manager.onDidChange((e) => events.push(e));

			manager.setEnabled(".ts", "ws1", true);

			expect(events).toHaveLength(1);
			expect(events[0]).toEqual({
				extension: ".ts",
				workspace: "ws1",
				enabled: true,
			});
		});

		test("fires onDidChange event with correct data when disabling", () => {
			filterState.setExtensionEnabled("ws1", ".ts", true);
			const manager = new FilterStateManager(filterState, ["ws1"]);
			const events: import("../../src/state/filter-state-manager.js").StateChangeEvent[] =
				[];
			manager.onDidChange((e) => events.push(e));

			manager.setEnabled(".ts", "ws1", false);

			expect(events).toHaveLength(1);
			expect(events[0]).toEqual({
				extension: ".ts",
				workspace: "ws1",
				enabled: false,
			});
		});

		test("fires one event per setEnabled call", () => {
			const manager = new FilterStateManager(filterState, ["ws1", "ws2"]);
			const events: unknown[] = [];
			manager.onDidChange((e) => events.push(e));

			manager.setEnabled(".ts", "ws1", true);
			manager.setEnabled(".ts", "ws2", true);

			expect(events).toHaveLength(2);
		});

		test("does not affect other workspaces", () => {
			const manager = new FilterStateManager(filterState, ["ws1", "ws2"]);
			manager.setEnabled(".ts", "ws1", true);
			expect(manager.isEnabled(".ts", "ws2")).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// setAllWorkspaces
	// -------------------------------------------------------------------------

	describe("setAllWorkspaces", () => {
		test("enables extension in all managed workspaces", () => {
			const manager = new FilterStateManager(filterState, [
				"ws1",
				"ws2",
				"ws3",
			]);
			manager.setAllWorkspaces(".ts", true);

			expect(manager.isEnabled(".ts", "ws1")).toBe(true);
			expect(manager.isEnabled(".ts", "ws2")).toBe(true);
			expect(manager.isEnabled(".ts", "ws3")).toBe(true);
		});

		test("disables extension in all managed workspaces", () => {
			filterState.setExtensionEnabled("ws1", ".ts", true);
			filterState.setExtensionEnabled("ws2", ".ts", true);
			const manager = new FilterStateManager(filterState, ["ws1", "ws2"]);

			manager.setAllWorkspaces(".ts", false);

			expect(manager.isEnabled(".ts", "ws1")).toBe(false);
			expect(manager.isEnabled(".ts", "ws2")).toBe(false);
		});

		test("fires one event per workspace", () => {
			const manager = new FilterStateManager(filterState, [
				"ws1",
				"ws2",
				"ws3",
			]);
			const events: unknown[] = [];
			manager.onDidChange((e) => events.push(e));

			manager.setAllWorkspaces(".ts", true);

			expect(events).toHaveLength(3);
		});

		test("fires no events when workspace list is empty", () => {
			const manager = new FilterStateManager(filterState, []);
			const events: unknown[] = [];
			manager.onDidChange((e) => events.push(e));

			manager.setAllWorkspaces(".ts", true);

			expect(events).toHaveLength(0);
		});

		test("events contain correct workspace info", () => {
			const manager = new FilterStateManager(filterState, ["ws1", "ws2"]);
			const events: import("../../src/state/filter-state-manager.js").StateChangeEvent[] =
				[];
			manager.onDidChange((e) => events.push(e));

			manager.setAllWorkspaces(".py", true);

			const workspaces = events.map((e) => e.workspace).sort();
			expect(workspaces).toEqual(["ws1", "ws2"]);
			for (const e of events) {
				expect(e.extension).toBe(".py");
				expect(e.enabled).toBe(true);
			}
		});
	});

	// -------------------------------------------------------------------------
	// isGloballyEnabled
	// -------------------------------------------------------------------------

	describe("isGloballyEnabled", () => {
		test("returns false when workspace list is empty", () => {
			const manager = new FilterStateManager(filterState, []);
			expect(manager.isGloballyEnabled(".ts")).toBe(false);
		});

		test("returns false when no workspaces have extension enabled", () => {
			const manager = new FilterStateManager(filterState, ["ws1", "ws2"]);
			expect(manager.isGloballyEnabled(".ts")).toBe(false);
		});

		test("returns false when only some workspaces have extension enabled", () => {
			filterState.setExtensionEnabled("ws1", ".ts", true);
			const manager = new FilterStateManager(filterState, ["ws1", "ws2"]);
			expect(manager.isGloballyEnabled(".ts")).toBe(false);
		});

		test("returns true when ALL workspaces have extension enabled", () => {
			filterState.setExtensionEnabled("ws1", ".ts", true);
			filterState.setExtensionEnabled("ws2", ".ts", true);
			const manager = new FilterStateManager(filterState, ["ws1", "ws2"]);
			expect(manager.isGloballyEnabled(".ts")).toBe(true);
		});

		test("returns true for single workspace that has extension enabled", () => {
			filterState.setExtensionEnabled("ws1", ".ts", true);
			const manager = new FilterStateManager(filterState, ["ws1"]);
			expect(manager.isGloballyEnabled(".ts")).toBe(true);
		});

		// With relevantWorkspaces argument
		test("accepts optional relevantWorkspaces and returns false for empty list", () => {
			filterState.setExtensionEnabled("ws1", ".ts", true);
			const manager = new FilterStateManager(filterState, ["ws1"]);
			expect(manager.isGloballyEnabled(".ts", [])).toBe(false);
		});

		test("checks only relevantWorkspaces when provided", () => {
			// ws1 has .ts, ws2 does not — but we only ask about ws1
			filterState.setExtensionEnabled("ws1", ".ts", true);
			const manager = new FilterStateManager(filterState, ["ws1", "ws2"]);
			expect(manager.isGloballyEnabled(".ts", ["ws1"])).toBe(true);
		});

		test("returns false when relevantWorkspaces has workspace without extension", () => {
			filterState.setExtensionEnabled("ws1", ".ts", true);
			const manager = new FilterStateManager(filterState, ["ws1", "ws2"]);
			// ws2 does not have .ts
			expect(manager.isGloballyEnabled(".ts", ["ws2"])).toBe(false);
		});

		test("uses managed workspaces when relevantWorkspaces is undefined", () => {
			filterState.setExtensionEnabled("ws1", ".ts", true);
			filterState.setExtensionEnabled("ws2", ".ts", true);
			const manager = new FilterStateManager(filterState, ["ws1", "ws2"]);
			// Both enabled → globally enabled
			expect(manager.isGloballyEnabled(".ts")).toBe(true);
		});

		test("sparse extension: only checks workspaces where extension exists", () => {
			// .example only in ws1, not ws2 — pass ws1 as relevantWorkspaces
			filterState.setExtensionEnabled("ws1", ".example", true);
			const manager = new FilterStateManager(filterState, ["ws1", "ws2"]);
			expect(manager.isGloballyEnabled(".example", ["ws1"])).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// setWorkspaces
	// -------------------------------------------------------------------------

	describe("setWorkspaces", () => {
		test("updates the list of managed workspaces", () => {
			const manager = new FilterStateManager(filterState, ["ws1"]);
			manager.setWorkspaces(["ws2", "ws3"]);

			// After update, setAllWorkspaces should target new workspaces
			manager.setAllWorkspaces(".ts", true);
			expect(manager.isEnabled(".ts", "ws2")).toBe(true);
			expect(manager.isEnabled(".ts", "ws3")).toBe(true);
			// ws1 no longer managed — was never enabled
			expect(manager.isEnabled(".ts", "ws1")).toBe(false);
		});

		test("makes a defensive copy so external array changes do not affect manager", () => {
			const workspaces = ["ws1", "ws2"];
			const manager = new FilterStateManager(filterState, ["ws1"]);
			manager.setWorkspaces(workspaces);

			// Mutate original array
			workspaces.push("ws3");

			// Manager should still have only ws1, ws2
			const events: unknown[] = [];
			manager.onDidChange((e) => events.push(e));
			manager.setAllWorkspaces(".ts", true);
			expect(events).toHaveLength(2);
		});

		test("can be set to empty list", () => {
			const manager = new FilterStateManager(filterState, ["ws1", "ws2"]);
			manager.setWorkspaces([]);

			const events: unknown[] = [];
			manager.onDidChange((e) => events.push(e));
			manager.setAllWorkspaces(".ts", true);
			expect(events).toHaveLength(0);
		});

		test("isGloballyEnabled uses updated workspace list", () => {
			filterState.setExtensionEnabled("ws2", ".ts", true);
			const manager = new FilterStateManager(filterState, ["ws1"]);

			// Before update: ws1 doesn't have .ts
			expect(manager.isGloballyEnabled(".ts")).toBe(false);

			// After update to only ws2 which has .ts
			manager.setWorkspaces(["ws2"]);
			expect(manager.isGloballyEnabled(".ts")).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Constructor defensive copy
	// -------------------------------------------------------------------------

	describe("constructor", () => {
		test("makes defensive copy of workspaces array", () => {
			const workspaces = ["ws1", "ws2"];
			const manager = new FilterStateManager(filterState, workspaces);

			// Mutate original array
			workspaces.push("ws3");

			const events: unknown[] = [];
			manager.onDidChange((e) => events.push(e));
			manager.setAllWorkspaces(".ts", true);

			// Should only fire for original 2 workspaces
			expect(events).toHaveLength(2);
		});
	});

	// -------------------------------------------------------------------------
	// onDidChange subscription
	// -------------------------------------------------------------------------

	describe("onDidChange", () => {
		test("multiple listeners all receive events", () => {
			const manager = new FilterStateManager(filterState, ["ws1"]);
			const received1: unknown[] = [];
			const received2: unknown[] = [];

			manager.onDidChange((e) => received1.push(e));
			manager.onDidChange((e) => received2.push(e));

			manager.setEnabled(".ts", "ws1", true);

			expect(received1).toHaveLength(1);
			expect(received2).toHaveLength(1);
		});

		test("listener can be disposed", () => {
			const manager = new FilterStateManager(filterState, ["ws1"]);
			const received: unknown[] = [];

			const disposable = manager.onDidChange((e) => received.push(e));
			disposable.dispose();

			manager.setEnabled(".ts", "ws1", true);

			expect(received).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// dispose
	// -------------------------------------------------------------------------

	describe("dispose", () => {
		test("dispose does not throw", () => {
			const manager = new FilterStateManager(filterState, ["ws1"]);
			expect(() => manager.dispose()).not.toThrow();
		});

		test("after dispose, events are no longer fired", () => {
			const manager = new FilterStateManager(filterState, ["ws1"]);
			const received: unknown[] = [];
			manager.onDidChange((e) => received.push(e));

			manager.dispose();
			manager.setEnabled(".ts", "ws1", true);

			expect(received).toHaveLength(0);
		});
	});
});
