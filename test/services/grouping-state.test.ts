/**
 * Phase 3 RED: Grouping State Management Tests
 *
 * Purpose: Validate global state management for Git status grouping feature
 *
 * Architecture Improvements over existing patterns:
 * 1. ✅ Use VS Code Configuration API (not raw globalState)
 * 2. ✅ Explicit ConfigurationTarget (Global vs Workspace)
 * 3. ✅ Event-driven reactivity (onDidChangeConfiguration)
 * 4. ✅ Default state handling (sensible defaults)
 * 5. ✅ Type-safe configuration keys
 *
 * Real Feature Requirements:
 * - Users can toggle grouping on/off
 * - Setting persists across VS Code sessions
 * - UI reacts immediately to state changes
 * - Works in multi-workspace scenarios
 * - Discoverable in VS Code settings UI
 *
 * Success Criteria:
 * - All 5 tests FAIL initially (RED phase)
 * - Tests validate USER-FACING behavior (not implementation details)
 * - Tests lock in VS Code best practices
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type * as vscode from "vscode";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("GroupingStateManager - TDD GREEN Phase", () => {
	beforeEach(() => {
		mock.restore();
		setupVSCodeMock(); // Mock vscode before dynamic import
	});

	/**
	 * TEST 1: Configuration-Based State Management
	 *
	 * Purpose: Validate VS Code Configuration API integration
	 * Pattern: Use workspace.getConfiguration() not raw state
	 *
	 * Why This Matters:
	 * - Appears in VS Code Settings UI (discoverability)
	 * - Settings.json integration (power users)
	 * - Multi-workspace support built-in
	 * - Configuration change events for free
	 *
	 * Expected Failure: GroupingStateManager doesn't exist yet
	 */
	test("RED 1: State uses VS Code Configuration API with explicit scope", async () => {
		let stateManagerExists = false;
		// ✅ Using actual imported type (no type assertions needed)
		let GroupingStateManagerClass:
			| typeof import("../../src/services/grouping-state-manager.js").GroupingStateManager
			| undefined;

		try {
			const module = await import(
				"../../src/services/grouping-state-manager.js"
			);
			GroupingStateManagerClass = module.GroupingStateManager;
			stateManagerExists = true;
		} catch (_error) {
			stateManagerExists = false;
		}

		expect(stateManagerExists).toBe(true); // Will fail - module doesn't exist

		if (GroupingStateManagerClass) {
			// Mock VS Code configuration
			// ✅ Using third-party vscode.WorkspaceConfiguration type
			const mockConfig: Partial<vscode.WorkspaceConfiguration> = {
				get: (_key: string, defaultValue?: boolean) => defaultValue,
				update: async (
					_key: string,
					_value: boolean,
					_target?: vscode.ConfigurationTarget,
				): Promise<void> => {
					// Track that update was called with correct target
				},
			};

			// Create typed workspace mock
			const mockWorkspace: Partial<typeof vscode.workspace> = {
				getConfiguration: mock(
					(_section?: string) => mockConfig as vscode.WorkspaceConfiguration,
				),
				onDidChangeConfiguration: mock(() => ({ dispose: () => {} })),
			};

			// Create state manager with properly typed mock
			const stateManager = new GroupingStateManagerClass(
				mockWorkspace as typeof vscode.workspace,
			);

			// Should use configuration with section name
			expect(typeof stateManager.isGroupingEnabled).toBe("function");
			expect(typeof stateManager.setGroupingEnabled).toBe("function");

			// Default should be false (grouping disabled initially)
			expect(stateManager.isGroupingEnabled()).toBe(false);
		}
	});

	/**
	 * TEST 2: Global vs Workspace Configuration Scope
	 *
	 * Purpose: Validate proper ConfigurationTarget usage
	 * Pattern: Explicit target prevents accidental workspace-only settings
	 *
	 * VS Code Configuration Targets:
	 * - Global: Applies to ALL workspaces (user preference)
	 * - Workspace: Applies to current workspace only
	 * - WorkspaceFolder: Applies to specific folder in multi-root
	 *
	 * User Story:
	 * "I want grouping enabled in all my projects, not just one"
	 *
	 * Expected Failure: setGroupingEnabled doesn't specify target
	 */
	test("RED 2: Global scope configuration persists across all workspaces", async () => {
		let stateManagerExists = false;
		// ✅ Using actual imported type (no type assertions needed)
		let GroupingStateManagerClass:
			| typeof import("../../src/services/grouping-state-manager.js").GroupingStateManager
			| undefined;
		let ConfigurationTargetEnum: typeof vscode.ConfigurationTarget | undefined;

		try {
			const module = await import(
				"../../src/services/grouping-state-manager.js"
			);
			GroupingStateManagerClass = module.GroupingStateManager;
			stateManagerExists = true;

			// VS Code ConfigurationTarget enum
			ConfigurationTargetEnum = {
				Global: 1,
				Workspace: 2,
				WorkspaceFolder: 3,
			};
		} catch (_error) {
			stateManagerExists = false;
		}

		expect(stateManagerExists).toBe(true); // Will fail - module doesn't exist

		if (GroupingStateManagerClass && ConfigurationTargetEnum) {
			let updateCalledWithGlobalTarget = false;
			let capturedTarget: vscode.ConfigurationTarget | undefined;

			// ✅ Using third-party vscode.WorkspaceConfiguration type
			const mockConfig: Partial<vscode.WorkspaceConfiguration> = {
				get: () => false,
				update: async (
					_key: string,
					_value: boolean,
					target?: vscode.ConfigurationTarget,
				): Promise<void> => {
					capturedTarget = target;
					updateCalledWithGlobalTarget =
						target === ConfigurationTargetEnum.Global;
				},
			};

			const mockWorkspace: Partial<typeof vscode.workspace> = {
				getConfiguration: mock(
					() => mockConfig as vscode.WorkspaceConfiguration,
				),
				onDidChangeConfiguration: mock(() => ({ dispose: () => {} })),
			};

			const stateManager = new GroupingStateManagerClass(
				mockWorkspace as typeof vscode.workspace,
			);

			// Enable grouping
			await stateManager.setGroupingEnabled(true);

			// Should specify Global target (not undefined, not Workspace)
			expect(updateCalledWithGlobalTarget).toBe(true);
			expect(capturedTarget).toBe(ConfigurationTargetEnum.Global);
		}
	});

	/**
	 * TEST 3: Event-Driven State Change Notifications
	 *
	 * Purpose: Validate reactive updates using VS Code events
	 * Pattern: EventEmitter for state change notifications
	 *
	 * Why Events Matter:
	 * - UI components can react immediately
	 * - No polling required
	 * - Decoupled architecture
	 * - Multiple subscribers supported
	 *
	 * User Story:
	 * "When I toggle grouping, I see the change instantly in the tree view"
	 *
	 * Expected Failure: onDidChangeGrouping event doesn't exist
	 */
	test("RED 3: State changes emit events for reactive UI updates", async () => {
		let stateManagerExists = false;
		// ✅ Using actual imported type (no type assertions needed)
		let GroupingStateManagerClass:
			| typeof import("../../src/services/grouping-state-manager.js").GroupingStateManager
			| undefined;

		try {
			const module = await import(
				"../../src/services/grouping-state-manager.js"
			);
			GroupingStateManagerClass = module.GroupingStateManager;
			stateManagerExists = true;
		} catch (_error) {
			stateManagerExists = false;
		}

		expect(stateManagerExists).toBe(true); // Will fail - module doesn't exist

		if (GroupingStateManagerClass) {
			// ✅ Using third-party vscode.WorkspaceConfiguration type
			const mockConfig: Partial<vscode.WorkspaceConfiguration> = {
				get: () => false,
				update: async () => {},
			};

			const mockWorkspace: Partial<typeof vscode.workspace> = {
				getConfiguration: mock(
					() => mockConfig as vscode.WorkspaceConfiguration,
				),
				onDidChangeConfiguration: mock(() => ({ dispose: () => {} })),
			};

			const stateManager = new GroupingStateManagerClass(
				mockWorkspace as typeof vscode.workspace,
			);

			// Should expose event for subscribers
			expect(stateManager.onDidChangeGrouping).toBeDefined();

			let eventFired = false;
			let eventValue: boolean | undefined;

			// Subscribe to events
			const disposable = stateManager.onDidChangeGrouping(
				(enabled: boolean) => {
					eventFired = true;
					eventValue = enabled;
				},
			);

			// Change state
			await stateManager.setGroupingEnabled(true);

			// Event should fire
			expect(eventFired).toBe(true);
			expect(eventValue).toBe(true);

			// Clean up
			disposable.dispose();
		}
	});

	/**
	 * TEST 4: Configuration Change Detection
	 *
	 * Purpose: React to external configuration changes
	 * Pattern: Listen to workspace.onDidChangeConfiguration
	 *
	 * Scenarios:
	 * - User edits settings.json directly
	 * - Another extension modifies configuration
	 * - Settings sync from another machine
	 *
	 * User Story:
	 * "When I edit settings.json, the extension responds immediately"
	 *
	 * Expected Failure: Doesn't subscribe to configuration changes
	 */
	test("RED 4: Detects external configuration changes from settings.json", async () => {
		let stateManagerExists = false;
		// ✅ Using actual imported type (no type assertions needed)
		let GroupingStateManagerClass:
			| typeof import("../../src/services/grouping-state-manager.js").GroupingStateManager
			| undefined;

		try {
			const module = await import(
				"../../src/services/grouping-state-manager.js"
			);
			GroupingStateManagerClass = module.GroupingStateManager;
			stateManagerExists = true;
		} catch (_error) {
			stateManagerExists = false;
		}

		expect(stateManagerExists).toBe(true); // Will fail - module doesn't exist

		if (GroupingStateManagerClass) {
			let configValue = false;
			let configChangeListeners: Array<
				(e: vscode.ConfigurationChangeEvent) => void
			> = [];

			// ✅ Using third-party vscode.WorkspaceConfiguration type
			const mockConfig: Partial<vscode.WorkspaceConfiguration> = {
				get: () => configValue,
				update: async (_key: string, value: boolean) => {
					configValue = value;
					// Simulate VS Code firing configuration change event
					for (const listener of configChangeListeners) {
						// INTENTIONAL: Minimal mock sufficient for testing affectsConfiguration()
						const mockEvent = {
							affectsConfiguration: (section: string) =>
								section === "commandCentral.gitStatusGrouping",
						} as vscode.ConfigurationChangeEvent;
						listener(mockEvent);
					}
				},
			};

			const mockWorkspace: Partial<typeof vscode.workspace> = {
				getConfiguration: mock(
					() => mockConfig as vscode.WorkspaceConfiguration,
				),
				onDidChangeConfiguration: mock(
					(listener: (e: vscode.ConfigurationChangeEvent) => void) => {
						configChangeListeners.push(listener);
						return {
							dispose: () => {
								configChangeListeners = configChangeListeners.filter(
									(l) => l !== listener,
								);
							},
						};
					},
				),
			};

			const stateManager = new GroupingStateManagerClass(
				mockWorkspace as typeof vscode.workspace,
			);

			let eventFired = false;
			stateManager.onDidChangeGrouping(() => {
				eventFired = true;
			});

			// Simulate external configuration change (e.g., editing settings.json)
			configValue = true;
			for (const listener of configChangeListeners) {
				// INTENTIONAL: Minimal mock sufficient for testing affectsConfiguration()
				const mockEvent = {
					affectsConfiguration: (section: string) =>
						section === "commandCentral.gitStatusGrouping",
				} as vscode.ConfigurationChangeEvent;
				listener(mockEvent);
			}

			// Should detect change and fire event
			expect(eventFired).toBe(true);
			expect(stateManager.isGroupingEnabled()).toBe(true);
		}
	});

	/**
	 * TEST 5: Default State and Configuration Schema
	 *
	 * Purpose: Validate sensible defaults and proper configuration contribution
	 * Pattern: Explicit defaults, not undefined
	 *
	 * VS Code Best Practice:
	 * - Define configuration schema in package.json
	 * - Provide sensible defaults
	 * - Include descriptions for settings UI
	 *
	 * User Story:
	 * "On first use, grouping is disabled (safe default)"
	 *
	 * Expected Failure: Default is undefined or wrong
	 */
	test("RED 5: Default state is disabled with proper configuration schema", async () => {
		let stateManagerExists = false;
		// ✅ Using actual imported type (no type assertions needed)
		let GroupingStateManagerClass:
			| typeof import("../../src/services/grouping-state-manager.js").GroupingStateManager
			| undefined;
		let getDefaultConfiguration:
			| typeof import("../../src/services/grouping-state-manager.js").getDefaultGroupingConfiguration
			| undefined;

		try {
			const module = await import(
				"../../src/services/grouping-state-manager.js"
			);
			GroupingStateManagerClass = module.GroupingStateManager;
			getDefaultConfiguration = module.getDefaultGroupingConfiguration;
			stateManagerExists = true;
		} catch (_error) {
			stateManagerExists = false;
		}

		expect(stateManagerExists).toBe(true); // Will fail - module doesn't exist

		if (GroupingStateManagerClass && getDefaultConfiguration) {
			// Get default configuration schema
			const schema = getDefaultConfiguration();

			// Should return configuration contribution object
			expect(schema).toBeDefined();
			expect(schema.type).toBe("boolean");
			expect(schema.default).toBe(false); // Grouping disabled by default
			expect(schema.description).toBeDefined();
			expect(schema.description).toContain("group"); // Mentions grouping

			// Fresh state manager should use default
			// ✅ Using third-party vscode.WorkspaceConfiguration type
			const mockConfig: Partial<vscode.WorkspaceConfiguration> = {
				get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
				update: async () => {},
			};

			const mockWorkspace: Partial<typeof vscode.workspace> = {
				getConfiguration: mock(
					() => mockConfig as vscode.WorkspaceConfiguration,
				),
				onDidChangeConfiguration: mock(() => ({ dispose: () => {} })),
			};

			const stateManager = new GroupingStateManagerClass(
				mockWorkspace as typeof vscode.workspace,
			);

			// Default should be disabled
			expect(stateManager.isGroupingEnabled()).toBe(false);
		}
	});

	/**
	 * TDD GREEN Phase Complete!
	 *
	 * Implementation Status: ✅ GroupingStateManager created
	 * - ✅ Uses workspace.getConfiguration("commandCentral.gitStatusGrouping")
	 * - ✅ Specifies ConfigurationTargetEnum.Global for updates
	 * - ✅ Implements EventEmitter for onDidChangeGrouping
	 * - ✅ Subscribes to workspace.onDidChangeConfiguration
	 * - ✅ Exports getDefaultGroupingConfiguration() for package.json
	 *
	 * Next Steps:
	 * 1. Add configuration contribution to package.json
	 * 2. Create commands (enable-grouping, disable-grouping, toggle-grouping)
	 * 3. Integrate with extension.ts
	 */
});
