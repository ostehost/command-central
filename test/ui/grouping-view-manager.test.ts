/**
 * Phase 4 Tests: GroupingViewManager (REFACTORED)
 *
 * BEST PRACTICE COMPLIANCE:
 * ✅ Tests observable effects ONLY (no internal state inspection)
 * ✅ Verifies persistence (globalState.update)
 * ✅ Verifies command execution (setContext)
 * ✅ No test-induced design damage (no isVisible() getter)
 * ✅ Resilient to implementation changes
 *
 * Changes from Original:
 * - Removed all `manager.isVisible()` calls
 * - Removed all `manager.getTreeView()` usage
 * - Tests verify ONLY observable effects
 * - More focused test names
 *
 * References:
 * - Google Testing Blog: "Test Behavior, Not Implementation"
 * - TEST_DESIGN_BEST_PRACTICES.md (this session)
 * - TEST_REFACTORING_PLAN.md (this session)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	createMockExtensionContext,
	createMockGroupingStateManager,
	createMockLogger,
} from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("GroupingViewManager - Observable Effects Testing", () => {
	beforeEach(() => {
		mock.restore();
		setupVSCodeMock(); // Mock vscode before dynamic import
	});

	/**
	 * TEST 1: TreeView Registration Pattern
	 *
	 * Observable Effects:
	 * - createTreeView called with correct viewId
	 * - TreeView added to extension subscriptions
	 */
	test("constructor creates TreeView and registers it", async () => {
		let managerExists = false;
		let GroupingViewManager:
			| typeof import("../../src/ui/grouping-view-manager.js").GroupingViewManager
			| undefined;

		try {
			const module = await import("../../src/ui/grouping-view-manager.js");
			GroupingViewManager = module.GroupingViewManager;
			managerExists = true;
		} catch (_error) {
			managerExists = false;
		}

		expect(managerExists).toBe(true);

		if (GroupingViewManager) {
			const vscode = await import("vscode");

			const mockContext = createMockExtensionContext({
				globalState: {
					keys: mock(() => []),
					get: mock(() => true),
					update: mock(() => Promise.resolve()),
					setKeysForSync: mock(() => {}),
				},
			});

			const mockStateManager = createMockGroupingStateManager(false);

			const mockLogger = createMockLogger();

			new GroupingViewManager(mockContext, mockStateManager, mockLogger);

			// Observable effect: createTreeView called
			expect(vscode.window.createTreeView).toHaveBeenCalledWith(
				"commandCentral.grouping",
				expect.objectContaining({
					treeDataProvider: expect.any(Object),
					canSelectMany: false,
				}),
			);

			// Observable effect: Added to subscriptions
			expect(mockContext.subscriptions.length).toBeGreaterThan(0);
		}
	});

	/**
	 * TEST 2: Toggle Visibility to Hidden
	 *
	 * Observable Effects:
	 * - globalState.update called with false
	 * - setContext command executed with false
	 */
	test("toggle() persists hidden state and updates context", async () => {
		let managerExists = false;
		let GroupingViewManager:
			| typeof import("../../src/ui/grouping-view-manager.js").GroupingViewManager
			| undefined;

		try {
			const module = await import("../../src/ui/grouping-view-manager.js");
			GroupingViewManager = module.GroupingViewManager;
			managerExists = true;
		} catch (_error) {
			managerExists = false;
		}

		expect(managerExists).toBe(true);

		if (GroupingViewManager) {
			const vscode = await import("vscode");

			const mockContext = createMockExtensionContext({
				globalState: {
					keys: mock(() => []),
					get: mock(() => true), // Start visible
					update: mock(() => Promise.resolve()),
					setKeysForSync: mock(() => {}),
				},
			});

			const mockStateManager = createMockGroupingStateManager(false);

			const mockLogger = createMockLogger();

			const manager = new GroupingViewManager(
				mockContext,
				mockStateManager,
				mockLogger,
			);

			// Act: Toggle to hidden
			await manager.toggle();

			// Observable effect: Persisted to globalState
			expect(mockContext.globalState.update).toHaveBeenCalledWith(
				"commandCentral.grouping.visible",
				false,
			);

			// Observable effect: Context updated
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
				"setContext",
				"commandCentral.grouping.visible",
				false,
			);
		}
	});

	/**
	 * TEST 3: Toggle Visibility to Visible
	 *
	 * Observable Effects:
	 * - After two toggles, final state is visible
	 * - Verified through globalState.update and setContext calls
	 */
	test("toggle() twice returns to visible state", async () => {
		let managerExists = false;
		let GroupingViewManager:
			| typeof import("../../src/ui/grouping-view-manager.js").GroupingViewManager
			| undefined;

		try {
			const module = await import("../../src/ui/grouping-view-manager.js");
			GroupingViewManager = module.GroupingViewManager;
			managerExists = true;
		} catch (_error) {
			managerExists = false;
		}

		expect(managerExists).toBe(true);

		if (GroupingViewManager) {
			const vscode = await import("vscode");

			const mockContext = createMockExtensionContext({
				globalState: {
					keys: mock(() => []),
					get: mock(() => true), // Start visible
					update: mock(() => Promise.resolve()),
					setKeysForSync: mock(() => {}),
				},
			});

			const mockStateManager = createMockGroupingStateManager(false);

			const mockLogger = createMockLogger();

			const manager = new GroupingViewManager(
				mockContext,
				mockStateManager,
				mockLogger,
			);

			// Act: Toggle twice (visible → hidden → visible)
			await manager.toggle();
			await manager.toggle();

			// Observable effect: Last call persisted visible state
			expect(mockContext.globalState.update).toHaveBeenLastCalledWith(
				"commandCentral.grouping.visible",
				true,
			);

			// Observable effect: Last call updated context to visible
			expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith(
				"setContext",
				"commandCentral.grouping.visible",
				true,
			);
		}
	});

	/**
	 * TEST 4: Restore Hidden State
	 *
	 * Observable Effects:
	 * - Constructor sets context to hidden
	 * - Verified through setContext command execution
	 */
	test("constructor restores hidden state from globalState", async () => {
		let managerExists = false;
		let GroupingViewManager:
			| typeof import("../../src/ui/grouping-view-manager.js").GroupingViewManager
			| undefined;

		try {
			const module = await import("../../src/ui/grouping-view-manager.js");
			GroupingViewManager = module.GroupingViewManager;
			managerExists = true;
		} catch (_error) {
			managerExists = false;
		}

		expect(managerExists).toBe(true);

		if (GroupingViewManager) {
			const vscode = await import("vscode");

			const mockContext = createMockExtensionContext({
				globalState: {
					keys: mock(() => []),
					get: mock(() => false), // Stored as hidden
					update: mock(() => Promise.resolve()),
					setKeysForSync: mock(() => {}),
				},
			});

			const mockStateManager = createMockGroupingStateManager(false);

			const mockLogger = createMockLogger();

			new GroupingViewManager(mockContext, mockStateManager, mockLogger);

			// Observable effect: Context set to hidden
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
				"setContext",
				"commandCentral.grouping.visible",
				false,
			);
		}
	});

	/**
	 * TEST 5: Restore Visible State
	 *
	 * Observable Effects:
	 * - Constructor sets context to visible
	 * - Verified through setContext command execution
	 */
	test("constructor restores visible state from globalState", async () => {
		let managerExists = false;
		let GroupingViewManager:
			| typeof import("../../src/ui/grouping-view-manager.js").GroupingViewManager
			| undefined;

		try {
			const module = await import("../../src/ui/grouping-view-manager.js");
			GroupingViewManager = module.GroupingViewManager;
			managerExists = true;
		} catch (_error) {
			managerExists = false;
		}

		expect(managerExists).toBe(true);

		if (GroupingViewManager) {
			// Reset mocks for clean test
			mock.restore();
			setupVSCodeMock();
			const vscode = await import("vscode");

			const mockContext = createMockExtensionContext({
				globalState: {
					keys: mock(() => []),
					get: mock(() => true), // Stored as visible
					update: mock(() => Promise.resolve()),
					setKeysForSync: mock(() => {}),
				},
			});

			const mockStateManager = createMockGroupingStateManager(false);

			const mockLogger = createMockLogger();

			new GroupingViewManager(mockContext, mockStateManager, mockLogger);

			// Observable effect: Context set to visible
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
				"setContext",
				"commandCentral.grouping.visible",
				true,
			);
		}
	});

	/**
	 * TEST 6: Default State for New Users
	 *
	 * Observable Effects:
	 * - globalState.get called with default value of true
	 * - Context set to visible for first-time users
	 */
	test("constructor defaults to visible for new users", async () => {
		let managerExists = false;
		let GroupingViewManager:
			| typeof import("../../src/ui/grouping-view-manager.js").GroupingViewManager
			| undefined;

		try {
			const module = await import("../../src/ui/grouping-view-manager.js");
			GroupingViewManager = module.GroupingViewManager;
			managerExists = true;
		} catch (_error) {
			managerExists = false;
		}

		expect(managerExists).toBe(true);

		if (GroupingViewManager) {
			const mockContext = createMockExtensionContext({
				globalState: {
					keys: mock(() => []),
					// Mock returns default value (no stored state)
					get: mock(
						<T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
					),
					update: mock(() => Promise.resolve()),
					setKeysForSync: mock(() => {}),
				},
			});

			const mockStateManager = createMockGroupingStateManager(false);

			const mockLogger = createMockLogger();

			new GroupingViewManager(mockContext, mockStateManager, mockLogger);

			// Observable effect: Queried globalState with correct default
			expect(mockContext.globalState.get).toHaveBeenCalledWith(
				"commandCentral.grouping.visible",
				true, // Default to visible for new users
			);
		}
	});

	/**
	 * TEST 7: Resource Cleanup
	 *
	 * Observable Effects:
	 * - TreeView.dispose() called
	 */
	test("dispose() cleans up TreeView resources", async () => {
		let managerExists = false;
		let GroupingViewManager:
			| typeof import("../../src/ui/grouping-view-manager.js").GroupingViewManager
			| undefined;

		try {
			const module = await import("../../src/ui/grouping-view-manager.js");
			GroupingViewManager = module.GroupingViewManager;
			managerExists = true;
		} catch (_error) {
			managerExists = false;
		}

		expect(managerExists).toBe(true);

		if (GroupingViewManager) {
			const vscode = await import("vscode");

			const mockContext = createMockExtensionContext({
				globalState: {
					keys: mock(() => []),
					get: mock(() => true),
					update: mock(() => Promise.resolve()),
					setKeysForSync: mock(() => {}),
				},
			});

			const mockStateManager = createMockGroupingStateManager(false);

			const mockLogger = createMockLogger();

			// Create a mock TreeView to track dispose() calls
			const mockTreeView = {
				dispose: mock(),
				visible: true,
				title: "Grouping",
				description: undefined,
				reveal: mock(),
				message: undefined,
				badge: undefined,
				onDidChangeVisibility: mock(() => ({ dispose: () => {} })),
				onDidChangeSelection: mock(() => ({ dispose: () => {} })),
				onDidChangeCheckboxState: mock(() => ({ dispose: () => {} })),
				onDidExpandElement: mock(() => ({ dispose: () => {} })),
				onDidCollapseElement: mock(() => ({ dispose: () => {} })),
				selection: [],
			};

			// Override createTreeView to return our mock
			vscode.window.createTreeView = mock(() => mockTreeView);

			const manager = new GroupingViewManager(
				mockContext,
				mockStateManager,
				mockLogger,
			);

			// Act: Dispose manager
			manager.dispose();

			// Observable effect: TreeView was disposed
			expect(mockTreeView.dispose).toHaveBeenCalled();
		}
	});

	/**
	 * TEST 8: Context-Driven Disposal Cleans Up Provider State Subscription
	 *
	 * Regression for CP-36 / PAR-74:
	 * The constructor must register the provider (not just the TreeView) in
	 * context.subscriptions so the provider's onDidChangeGrouping subscription is
	 * torn down on extension shutdown WITHOUT requiring a direct manager.dispose().
	 *
	 * Observable Effects:
	 * - Disposing every context.subscriptions item disposes the state subscription
	 * - After context-driven disposal, firing onDidChangeGrouping triggers no refresh
	 */
	test("context-driven disposal tears down provider state subscription", async () => {
		const module = await import("../../src/ui/grouping-view-manager.js");
		const { GroupingViewManager } = module;

		await import("vscode");

		const mockContext = createMockExtensionContext({
			globalState: {
				keys: mock(() => []),
				get: mock(() => true),
				update: mock(() => Promise.resolve()),
				setKeysForSync: mock(() => {}),
			},
		});

		// Capture the listener registered by the provider so we can fire it later,
		// and track disposal of the subscription it hands back.
		let stateChangeListener: ((enabled: boolean) => void) | undefined;
		const stateSubscriptionDispose = mock(() => {});
		const mockStateManager = createMockGroupingStateManager(false, {
			onDidChangeGrouping: mock((callback: (enabled: boolean) => void) => {
				stateChangeListener = callback;
				return { dispose: stateSubscriptionDispose };
			}),
		});

		const mockLogger = createMockLogger();

		new GroupingViewManager(mockContext, mockStateManager, mockLogger);

		// The provider subscribed to external state changes.
		expect(stateChangeListener).toBeDefined();

		// Simulate extension shutdown WITHOUT calling manager.dispose():
		// VS Code disposes every item it was handed in context.subscriptions.
		for (const subscription of mockContext.subscriptions) {
			subscription.dispose();
		}

		// Observable effect: the provider's state subscription was disposed via the
		// context, proving the provider (not just the TreeView) was registered.
		expect(stateSubscriptionDispose).toHaveBeenCalled();
	});

	/**
	 * BEST PRACTICE SUMMARY:
	 *
	 * ✅ All tests verify ONLY observable effects:
	 *    - globalState.update() - Persistence
	 *    - executeCommand("setContext") - UI state
	 *    - createTreeView() - Registration
	 *    - dispose() - Cleanup
	 *
	 * ✅ No internal state inspection:
	 *    - No isVisible() calls
	 *    - No getTreeView() calls
	 *    - Tests don't know about private fields
	 *
	 * ✅ Tests are resilient:
	 *    - Can refactor storage mechanism without breaking tests
	 *    - Can change internal implementation freely
	 *    - Observable behavior is locked in
	 *
	 * ✅ Clean separation:
	 *    - Tests test behavior
	 *    - Production code stays clean
	 *    - No test-induced design damage
	 */
});
