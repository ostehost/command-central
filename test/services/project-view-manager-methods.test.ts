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
});
