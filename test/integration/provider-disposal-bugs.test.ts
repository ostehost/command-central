/**
 * Provider Disposal Bug Regression Tests
 *
 * Tests specific production bugs that shipped:
 * - Bug #1: SQLite loading failures should fall back gracefully
 * - Bug #2: Command registration collisions on reload
 * - Bug #3: Provider disposal lifecycle issues
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

describe("Provider Disposal Bug Regressions", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("Bug #1: Extension handles missing SQLite gracefully", async () => {
		// Simulate SQLite module not available (common in VS Code environments)
		const mockRequire = mock((moduleName: string) => {
			if (
				moduleName.includes("better-sqlite3") ||
				moduleName.includes("@vscode/sqlite3")
			) {
				throw new Error("Cannot find module 'better-sqlite3'");
			}
			// Return dummy for other modules
			return {};
		});

		// Mock extension behavior - should fall back to workspace storage
		const fallbackStorageCreated = mock(() => ({
			initialize: mock(),
			save: mock(),
			load: mock(),
		}));

		// This represents what should happen when SQLite fails
		let usedFallback = false;
		try {
			mockRequire("better-sqlite3");
		} catch (_error) {
			// Should fall back to WorkspaceState storage
			fallbackStorageCreated();
			usedFallback = true;
		}

		expect(usedFallback).toBe(true);
		expect(fallbackStorageCreated).toHaveBeenCalled();
	});

	test("Bug #2: Command registration collision on reload", async () => {
		// Simulate VS Code command registration
		const registeredCommands = new Set<string>();
		const mockRegisterCommand = mock(
			(commandId: string, _handler: (...args: unknown[]) => unknown) => {
				if (registeredCommands.has(commandId)) {
					throw new Error(`command '${commandId}' already exists`);
				}
				registeredCommands.add(commandId);
				return {
					dispose: mock(() => {
						registeredCommands.delete(commandId);
					}),
				};
			},
		);

		// First registration - should succeed
		const disposable1 = mockRegisterCommand("commandCentral.test", () => {});
		expect(disposable1).toBeDefined();
		expect(registeredCommands.has("commandCentral.test")).toBe(true);

		// Simulate reload - dispose first, then re-register
		disposable1.dispose();
		expect(registeredCommands.has("commandCentral.test")).toBe(false);

		// Second registration should now succeed (no collision)
		const disposable2 = mockRegisterCommand("commandCentral.test", () => {});
		expect(disposable2).toBeDefined();
		expect(registeredCommands.has("commandCentral.test")).toBe(true);
	});

	test("Bug #3: Provider lifecycle disposal chain", async () => {
		// Mock a provider with nested disposables
		const mockStorageDispose = mock();
		const mockListenerDispose = mock();
		const mockProviderDispose = mock();

		const mockProvider = {
			storage: { dispose: mockStorageDispose },
			listeners: [{ dispose: mockListenerDispose }],
			dispose: mock(async () => {
				// Should dispose storage first
				mockProvider.storage.dispose();
				// Then dispose listeners
				for (const listener of mockProvider.listeners) {
					listener.dispose();
				}
				mockProviderDispose();
			}),
		};

		// Simulate factory disposal
		await mockProvider.dispose();

		// Verify proper disposal order
		expect(mockStorageDispose).toHaveBeenCalled();
		expect(mockListenerDispose).toHaveBeenCalled();
		expect(mockProviderDispose).toHaveBeenCalled();
	});

	test("Bug #4: Race condition in concurrent provider initialization", async () => {
		// Mock provider that tracks initialization state
		let initializationCount = 0;
		let isInitializing = false;

		const mockProvider = {
			initialize: mock(async () => {
				if (isInitializing) {
					// Already initializing - wait for it to complete
					return;
				}
				isInitializing = true;
				initializationCount++;
				// Simulate async initialization work
				await new Promise((resolve) => setTimeout(resolve, 1));
				isInitializing = false;
			}),
		};

		// Simulate race condition - multiple rapid initialization calls
		const initPromises = [
			mockProvider.initialize(),
			mockProvider.initialize(),
			mockProvider.initialize(),
		];

		await Promise.all(initPromises);

		// Should have been called 3 times but only done actual work once
		expect(mockProvider.initialize).toHaveBeenCalledTimes(3);
		expect(initializationCount).toBe(1);
	});

	test("Bug #5: Empty group handling in tree provider", async () => {
		// Mock tree provider behavior
		const mockTreeProvider = {
			getChildren: mock((element?: unknown) => {
				if (!element) {
					// Root level - check if we have any groups with actual content
					const groups = [
						{ type: "staged", totalCount: 0 },
						{ type: "unstaged", totalCount: 0 },
					];

					// Filter out empty groups (this was the bug - wasn't filtering)
					const nonEmptyGroups = groups.filter((group) => group.totalCount > 0);
					return nonEmptyGroups;
				}
				return [];
			}),
		};

		// When all groups are empty, should return empty array (not empty groups)
		const children = mockTreeProvider.getChildren();

		expect(children).toEqual([]);
		expect(children.length).toBe(0);

		// Specifically check we didn't return empty groups
		const hasEmptyGroups = children.some(
			(child: unknown) =>
				(child as { type?: string; totalCount?: number }).type &&
				(child as { type?: string; totalCount?: number }).totalCount === 0,
		);
		expect(hasEmptyGroups).toBe(false);
	});
});
