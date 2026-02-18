/**
 * Tests for ProjectViewManager provider lookup and command registration
 * Covers: Provider lookup methods, per-view commands, helper methods
 *
 * Testing Pattern:
 * - Use setupVSCodeMock() before dynamic imports
 * - Import ProjectViewManager dynamically after mock setup
 * - Test public API methods that provide real value
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type * as vscode from "vscode";
import type { ProjectConfigSource } from "../../src/config/project-config-source.js";
import type { ProjectViewConfig } from "../../src/config/project-views.js";
import type { ProviderFactory } from "../../src/factories/provider-factory.js";
import type { SortedGitChangesProvider } from "../../src/git-sort/sorted-changes-provider.js";
import type { LoggerService } from "../../src/services/logger-service.js";
import { createMockExtensionContext } from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// Mock logger
const createMockLogger = (): LoggerService =>
	({
		debug: mock(() => {}),
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		setLevel: mock(() => {}),
	}) as unknown as LoggerService;

// Mock extension context - using factory from typed-mocks.ts
const createMockContext = () => createMockExtensionContext();

// Mock provider with additional methods for testing
const createMockProvider = (): SortedGitChangesProvider => {
	const provider = {
		initialize: mock(async () => {}),
		dispose: mock(async () => {}),
		refresh: mock(() => {}),
		getChildren: mock(async () => []),
		getTreeItem: mock(() => ({})),
		onDidChangeTreeData: mock(() => ({ dispose: () => {} })),
		setSortOrder: mock(() => {}),
		getSortOrder: mock(() => "newest" as "newest" | "oldest"),
		setFileTypeFilter: mock(() => {}),
		setProjectIcon: mock(() => {}),
		findItemByUri: mock(() => undefined),
	} as unknown as SortedGitChangesProvider;
	return provider;
};

describe("ProjectViewManager Provider Lookup Methods", () => {
	let mockLogger: LoggerService;
	let mockContext: import("vscode").ExtensionContext;
	let mockConfigSource: ProjectConfigSource;
	let mockProviderFactory: ProviderFactory;
	let mockProviders: Map<string, SortedGitChangesProvider>;
	// @ts-expect-error - Placeholder for future feature
	let _mockTreeViews: Map<string, unknown>;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock(); // CRITICAL: Mock vscode before imports

		mockLogger = createMockLogger();
		mockContext = createMockContext();
		mockProviders = new Map();
		_mockTreeViews = new Map();

		// Mock config source with 2 projects
		mockConfigSource = {
			loadProjects: mock(
				async (): Promise<ProjectViewConfig[]> => [
					{
						id: "slot1",
						displayName: "Frontend",
						iconPath: "resources/icons/icon1.svg",
						gitPath: "/workspace/frontend",
						sortOrder: 1,
					},
					{
						id: "slot2",
						displayName: "Backend",
						iconPath: "resources/icons/icon2.svg",
						gitPath: "/workspace/backend",
						sortOrder: 2,
					},
				],
			),
		};

		// Mock provider factory
		mockProviderFactory = {
			createProvider: mock(async (config: ProjectViewConfig) => {
				const provider = createMockProvider();
				mockProviders.set(config.id, provider);
				return provider;
			}),
			dispose: mock(async () => {}),
			getProviderForFile: mock(() => undefined),
		} as unknown as ProviderFactory;
	});

	test("getProviderForTreeView returns provider for valid TreeView", async () => {
		const vscode = await import("vscode");
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		// Get a registered TreeView (they're created during registration)
		// We need to intercept createTreeView to capture the TreeView objects
		const registeredViews = new Map<string, unknown>();

		// Re-create with createTreeView spy
		const originalCreateTreeView = vscode.window.createTreeView;
		vscode.window.createTreeView = mock(
			<T>(
				viewId: string,
				options: vscode.TreeViewOptions<T>,
			): vscode.TreeView<T> => {
				const treeView = originalCreateTreeView<T>(viewId, options);
				registeredViews.set(viewId, treeView);
				return treeView;
			},
		) as typeof vscode.window.createTreeView;

		const manager2 = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager2.registerAllProjects();

		// Get the registered TreeView
		const treeView = registeredViews.get("commandCentral.project.slot1");
		expect(treeView).toBeDefined();

		const provider = manager2.getProviderForTreeView(
			treeView as vscode.TreeView<unknown>,
		);

		expect(provider).toBeDefined();
	});

	test("getProviderForTreeView returns undefined for undefined TreeView", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		// Test defensive programming: function signature doesn't allow undefined,
		// but implementation handles it gracefully (line 315: if (!treeView))
		const provider = manager.getProviderForTreeView(
			undefined as unknown as vscode.TreeView<unknown>,
		);

		expect(provider).toBeUndefined();
		// Verify warning was logged
		const warnCalls = (mockLogger.warn as ReturnType<typeof mock>).mock.calls;
		const nullWarning = warnCalls.some((call: unknown[]) =>
			call[0]?.toString().includes("called with null/undefined"),
		);
		expect(nullWarning).toBe(true);
	});

	test("getProviderByViewId returns provider for valid view ID", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		const provider = manager.getProviderByViewId(
			"commandCentral.project.slot1",
		);

		expect(provider).toBeDefined();
	});

	test("getProviderByViewId returns undefined for invalid view ID", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		const provider = manager.getProviderByViewId("nonexistent.view.id");

		expect(provider).toBeUndefined();
		// Verify warning was logged
		const warnCalls = (mockLogger.warn as ReturnType<typeof mock>).mock.calls;
		const notFoundWarning = warnCalls.some((call: unknown[]) =>
			call[0]?.toString().includes("No TreeView found for view ID"),
		);
		expect(notFoundWarning).toBe(true);
	});

	test("getAllProviders returns all registered providers with slot IDs", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		const allProviders = manager.getAllProviders();

		expect(allProviders).toHaveLength(2);
		expect(allProviders[0]).toHaveProperty("provider");
		expect(allProviders[0]).toHaveProperty("slotId");

		// Verify both slots are present
		const slotIds = allProviders.map((p) => p.slotId);
		expect(slotIds).toContain("slot1");
		expect(slotIds).toContain("slot2");
	});

	test("getAllProviders returns empty array before registration", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		const allProviders = manager.getAllProviders();

		expect(allProviders).toHaveLength(0);
	});

	test("getAnyVisibleProvider returns first visible provider", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		// Mock TreeViews are visible: true by default (see vscode-mock.ts:113)
		// With 2 projects, both views are visible, so it logs a warning about multiple visible
		const provider = manager.getAnyVisibleProvider();

		// Should return a provider (the first visible one)
		expect(provider).toBeDefined();
		// Should have logged something (either single visible or multiple visible warning)
		const allLogCalls =
			(mockLogger.info as ReturnType<typeof mock>).mock.calls.length +
			(mockLogger.warn as ReturnType<typeof mock>).mock.calls.length;
		expect(allLogCalls).toBeGreaterThan(0);
	});

	test("isReloading returns false initially", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		expect(manager.isReloading()).toBe(false);
	});

	test("isReloading returns false after reload completes", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();
		await manager.reload();

		expect(manager.isReloading()).toBe(false);
	});
});

describe("ProjectViewManager Per-View Commands", () => {
	let mockLogger: LoggerService;
	let mockContext: import("vscode").ExtensionContext;
	let mockConfigSource: ProjectConfigSource;
	let mockProviderFactory: ProviderFactory;
	let mockProvider: SortedGitChangesProvider;
	let commandCallbacks: Map<string, (...args: unknown[]) => unknown>;

	beforeEach(() => {
		mock.restore();
		const vscodeMock = setupVSCodeMock(); // CRITICAL: Mock vscode before imports

		mockLogger = createMockLogger();
		mockContext = createMockContext();
		mockProvider = createMockProvider();
		commandCallbacks = new Map();

		// Configure showQuickPick to return a valid choice (user selected "All Files")
		(vscodeMock.window.showQuickPick as unknown) = mock(
			(_items: string[] | Thenable<string[]>, _options?: unknown) =>
				Promise.resolve("all" as string | undefined),
		) as unknown as typeof vscode.window.showQuickPick;

		// Intercept command registration to capture callbacks
		const originalRegisterCommand = vscodeMock.commands.registerCommand;
		vscodeMock.commands.registerCommand = mock(
			(command: string, callback: (...args: unknown[]) => unknown) => {
				commandCallbacks.set(command, callback);
				return originalRegisterCommand(command, callback);
			},
		);

		// Mock config source with 1 project
		mockConfigSource = {
			loadProjects: mock(
				async (): Promise<ProjectViewConfig[]> => [
					{
						id: "slot1",
						displayName: "TestProject",
						iconPath: "resources/icons/icon1.svg",
						gitPath: "/workspace/test",
						sortOrder: 1,
					},
				],
			),
		};

		// Mock provider factory
		mockProviderFactory = {
			createProvider: mock(async () => mockProvider),
			dispose: mock(async () => {}),
		} as unknown as ProviderFactory;
	});

	test("registerAllProjects registers per-view commands", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const initialSubscriptions = mockContext.subscriptions.length;

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		// Per-view commands are now tracked internally (perViewCommandDisposables)
		// rather than on context.subscriptions, to support clean reload.
		// Verify commands were registered via registerCommand calls.
		const vscodeMod = await import("vscode");
		const registerCalls = (
			vscodeMod.commands.registerCommand as ReturnType<typeof mock>
		).mock.calls;
		const perViewCmds = registerCalls.filter((call: unknown[]) =>
			call[0]?.toString().includes(".slot"),
		);
		// At least 6 per-view commands (sort, refresh, filter × AB + Panel)
		expect(perViewCmds.length).toBeGreaterThanOrEqual(6);
	});

	test("sort order command toggles from newest to oldest", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		// Get and execute the sort command
		const sortCommand = commandCallbacks.get(
			"commandCentral.gitSort.changeSortOrder.slot1",
		);
		expect(sortCommand).toBeDefined();

		// TypeScript knows sortCommand is defined after check
		if (!sortCommand) throw new Error("sortCommand should be defined");
		sortCommand();

		// Should toggle to "oldest"
		expect(mockProvider.setSortOrder).toHaveBeenCalledWith("oldest");
	});

	test("sort order Panel command toggles sort order", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		// Get and execute the Panel sort command
		const sortPanelCommand = commandCallbacks.get(
			"commandCentral.gitSort.changeSortOrder.slot1Panel",
		);
		expect(sortPanelCommand).toBeDefined();

		sortPanelCommand?.();

		// Should toggle to "oldest"
		expect(mockProvider.setSortOrder).toHaveBeenCalledWith("oldest");
	});

	test("refresh command calls provider.refresh()", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		// Get and execute the refresh command
		const refreshCommand = commandCallbacks.get(
			"commandCentral.gitSort.refreshView.slot1",
		);
		expect(refreshCommand).toBeDefined();

		refreshCommand?.();

		expect(mockProvider.refresh).toHaveBeenCalled();
	});

	test("refresh Panel command calls provider.refresh()", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		// Get and execute the Panel refresh command
		const refreshPanelCommand = commandCallbacks.get(
			"commandCentral.gitSort.refreshView.slot1Panel",
		);
		expect(refreshPanelCommand).toBeDefined();

		refreshPanelCommand?.();

		expect(mockProvider.refresh).toHaveBeenCalled();
	});

	test("file filter command shows quick pick", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		// Get and execute the file filter command
		const filterCommand = commandCallbacks.get(
			"commandCentral.gitSort.changeFileFilter.slot1",
		);
		expect(filterCommand).toBeDefined();

		await filterCommand?.();

		// Should call setFileTypeFilter
		expect(mockProvider.setFileTypeFilter).toHaveBeenCalled();
	});

	test("file filter Panel command shows quick pick", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		// Get and execute the Panel file filter command
		const filterPanelCommand = commandCallbacks.get(
			"commandCentral.gitSort.changeFileFilter.slot1Panel",
		);
		expect(filterPanelCommand).toBeDefined();

		await filterPanelCommand?.();

		// Should call setFileTypeFilter
		expect(mockProvider.setFileTypeFilter).toHaveBeenCalled();
	});

	test("dispose cleans up manager", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		// Dispose should not throw
		expect(() => manager.dispose()).not.toThrow();

		// Should have logged disposal
		const infoCalls = (mockLogger.info as ReturnType<typeof mock>).mock.calls;
		const disposalLog = infoCalls.some((call: unknown[]) =>
			call[0]?.toString().includes("Disposing project view manager"),
		);
		expect(disposalLog).toBe(true);
	});
});

describe("ProjectViewManager Active File Tracking", () => {
	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
	});

	test("setupActiveFileTracking adds subscription on construction", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const mockLogger = createMockLogger();
		const mockContext = createMockContext();
		const mockConfigSource = { loadProjects: mock(async () => []) };
		const mockProviderFactory = {
			createProvider: mock(async () => createMockProvider()),
			dispose: mock(async () => {}),
		} as unknown as ProviderFactory;

		const initialSubscriptions = mockContext.subscriptions.length;

		// Constructor should set up active file tracking
		new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		// Verify subscription was added (active file tracking adds a subscription)
		expect(mockContext.subscriptions.length).toBeGreaterThan(
			initialSubscriptions,
		);
	});
});
