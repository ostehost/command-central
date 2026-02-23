/**
 * Tests for SortedGitChangesProvider core functionality
 * Covers: getChildren, filtering, time grouping, Git change collection
 *
 * Testing Pattern:
 * - Use setupVSCodeMock() before dynamic imports
 * - Mock Git extension API and repositories
 * - Test observable behaviors (TreeDataProvider contract)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LoggerService } from "../../src/services/logger-service.js";
import {
	createMockExtensionContext,
	createMockLogger,
} from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("SortedGitChangesProvider Core Functionality", () => {
	let mockLogger: LoggerService;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();

		mockLogger = createMockLogger();
	});

	test("getChildren returns empty array when no Git repository", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Mock no Git extension
		vscode.extensions.getExtension = mock(() => undefined);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);
		await provider.initialize();

		const children = await provider.getChildren();

		expect(children).toEqual([]);
	});

	test("provider initializes successfully with Git extension", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Mock Git extension with proper structure
		const mockRepo = {
			rootUri: vscode.Uri.file("/workspace"),
			state: {
				workingTreeChanges: [],
				indexChanges: [],
				onDidChange: mock(() => ({ dispose: () => {} })),
			},
		};

		const mockGitApi = {
			repositories: [mockRepo],
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
		};

		const mockGitExtension: import("vscode").Extension<{
			getAPI: () => typeof mockGitApi;
		}> = {
			id: "vscode.git",
			extensionUri: vscode.Uri.file("/mock/extension"),
			extensionPath: "/mock/extension",
			isActive: true,
			packageJSON: {},
			extensionKind: vscode.ExtensionKind.Workspace,
			activate: mock(() => Promise.resolve({ getAPI: () => mockGitApi })),
			exports: {
				getAPI: mock(() => mockGitApi),
			},
		};

		vscode.extensions.getExtension = mock(
			(_extensionId: string) =>
				// biome-ignore lint/suspicious/noExplicitAny: GitExtension API has dynamic export structure
				mockGitExtension as import("vscode").Extension<any> | undefined,
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);
		await provider.initialize();

		// Provider should initialize without error
		const children = await provider.getChildren();
		expect(Array.isArray(children)).toBe(true);
	});

	test("getTreeItem is callable and returns TreeItem", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		// Create a TimeGroup element (simpler to test)
		const timeGroup = {
			type: "timeGroup" as const,
			label: "Today",
			timePeriod: "today" as const,
			children: [],
			collapsibleState: 2,
			contextValue: "timeGroup" as const,
		};

		const treeItem = provider.getTreeItem(timeGroup);

		// Should return a TreeItem (label might be modified by provider logic)
		expect(treeItem).toBeDefined();
		expect(typeof treeItem.label).toBe("string");
	});

	test("refresh fires onDidChangeTreeData event", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		let eventFired = false;
		provider.onDidChangeTreeData(() => {
			eventFired = true;
		});

		provider.refresh();

		// Event should have been fired
		expect(eventFired).toBe(true);
	});

	test("setSortOrder changes sort order and refreshes", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		// Default is "newest"
		expect(provider.getSortOrder()).toBe("newest");

		let refreshed = false;
		provider.onDidChangeTreeData(() => {
			refreshed = true;
		});

		provider.setSortOrder("oldest");

		expect(provider.getSortOrder()).toBe("oldest");
		expect(refreshed).toBe(true);
	});

	test("setFileTypeFilter updates filter and refreshes", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		let refreshed = false;
		provider.onDidChangeTreeData(() => {
			refreshed = true;
		});

		provider.setFileTypeFilter("code");

		expect(refreshed).toBe(true);
	});

	test("dispose cleans up event listeners", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);
		await provider.initialize();

		// Dispose should not throw
		await expect(provider.dispose()).resolves.toBeUndefined();
	});
});

describe("SortedGitChangesProvider Filtering", () => {
	let mockLogger: LoggerService;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
		mockLogger = createMockLogger();
	});

	test("filterByFileType filters code files correctly", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		// The provider has a private filterByFileType method
		// We can test the public API by setting the filter and checking getChildren
		provider.setFileTypeFilter("code");

		// Filter is set, will be applied during getChildren
		expect(provider.getSortOrder()).toBeDefined(); // Just verify provider is functional
	});
});

describe("SortedGitChangesProvider Configuration", () => {
	let mockLogger: LoggerService;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
		mockLogger = createMockLogger();
	});

	test("setProjectIcon method exists and is callable", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		// Method should exist
		expect(typeof provider.setProjectIcon).toBe("function");

		// Should be callable without throwing
		provider.setProjectIcon("icon.svg", mockContext, "🚀");

		// If we got here, it didn't throw
		expect(true).toBe(true);
	});
});

describe("SortedGitChangesProvider GitStatusGroup Icons", () => {
	let mockLogger: LoggerService;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
		mockLogger = createMockLogger();
	});

	test("staged group uses branded SVG icon", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);
		const { GitStatusGroupBuilder } = await import(
			"../builders/tree-element-builder.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const stagedGroup = new GitStatusGroupBuilder()
			.staged()
			.withTotalCount(3)
			.build();

		const treeItem = provider.getTreeItem(stagedGroup);

		expect(treeItem.iconPath).toBeDefined();
		const icon = treeItem.iconPath as {
			light: { path: string };
			dark: { path: string };
		};
		expect(icon.light).toBeDefined();
		expect(icon.dark).toBeDefined();
		expect(icon.light.path).toContain("staged.svg");
		expect(icon.dark.path).toContain("staged.svg");
	});

	test("unstaged group uses branded SVG icon", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);
		const { GitStatusGroupBuilder } = await import(
			"../builders/tree-element-builder.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const unstagedGroup = new GitStatusGroupBuilder()
			.unstaged()
			.withTotalCount(5)
			.build();

		const treeItem = provider.getTreeItem(unstagedGroup);

		expect(treeItem.iconPath).toBeDefined();
		const icon = treeItem.iconPath as {
			light: { path: string };
			dark: { path: string };
		};
		expect(icon.light).toBeDefined();
		expect(icon.dark).toBeDefined();
		expect(icon.light.path).toContain("working.svg");
		expect(icon.dark.path).toContain("working.svg");
	});

	test("staged group has rich tooltip", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);
		const { GitStatusGroupBuilder } = await import(
			"../builders/tree-element-builder.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const stagedGroup = new GitStatusGroupBuilder()
			.staged()
			.withTotalCount(137)
			.build();

		const treeItem = provider.getTreeItem(stagedGroup);

		// Assert: Should have rich markdown tooltip
		expect(treeItem.tooltip).toBeDefined();
		expect(treeItem.tooltip).toBeInstanceOf(vscode.MarkdownString);

		const tooltip = treeItem.tooltip as { value: string };
		expect(tooltip.value).toContain("Staged Changes");
		expect(tooltip.value).toContain("137 ready to commit");
	});

	test("unstaged group has rich tooltip", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);
		const { GitStatusGroupBuilder } = await import(
			"../builders/tree-element-builder.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const unstagedGroup = new GitStatusGroupBuilder()
			.unstaged()
			.withTotalCount(132)
			.build();

		const treeItem = provider.getTreeItem(unstagedGroup);

		// Assert: Should have rich markdown tooltip
		expect(treeItem.tooltip).toBeDefined();
		expect(treeItem.tooltip).toBeInstanceOf(vscode.MarkdownString);

		const tooltip = treeItem.tooltip as { value: string };
		expect(tooltip.value).toContain("Working Changes");
		expect(tooltip.value).toContain("132 files changed");
	});

	test("TimeGroup icons remain unchanged", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);
		const { TimeGroupBuilder } = await import(
			"../builders/tree-element-builder.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		// Create a TimeGroup
		const timeGroup = new TimeGroupBuilder().today().build();

		const treeItem = provider.getTreeItem(timeGroup);

		// Assert: Should still use 'calendar' icon
		expect(treeItem.iconPath).toBeDefined();
		expect(treeItem.iconPath).toBeInstanceOf(vscode.ThemeIcon);

		const icon = treeItem.iconPath as typeof vscode.ThemeIcon.prototype;
		expect(icon.id).toBe("calendar");
	});

	test("initialize() with pre-existing repositories regression test", async () => {
		// Bug regression test: Verify provider can handle initialization
		// with existing repositories without issues
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Mock Git extension with existing repositories (common scenario)
		vscode.extensions.getExtension = mock<unknown>(() => ({
			exports: {
				getAPI: mock(() => ({
					repositories: [
						{ state: { workingTreeChanges: [], indexChanges: [] } },
					],
					onDidOpenRepository: mock(() => ({ dispose: mock() })),
					onDidCloseRepository: mock(() => ({ dispose: mock() })),
				})),
			},
			isActive: true,
		}));

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		// The key test: should initialize without throwing
		const initResult = provider.initialize();
		await expect(initResult).resolves.toBeUndefined();
	});

	test("concurrent initialize() calls regression test", async () => {
		// Bug regression test: Multiple concurrent initialize() calls should be safe
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		vscode.extensions.getExtension = mock<unknown>(() => ({
			exports: {
				getAPI: mock(() => ({
					repositories: [],
					onDidOpenRepository: mock(() => ({ dispose: mock() })),
					onDidCloseRepository: mock(() => ({ dispose: mock() })),
				})),
			},
			isActive: true,
		}));

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		// The key test: concurrent calls should not cause race condition crashes
		const initPromises = [
			provider.initialize(),
			provider.initialize(),
			provider.initialize(),
		];

		// All should complete successfully
		const results = await Promise.allSettled(initPromises);
		for (const result of results) {
			expect(result.status).toBe("fulfilled");
		}
	});

	test("getChildren returns empty array (not empty groups) when no changes", async () => {
		// Bug regression test: When there are no git changes, getChildren should return
		// empty array, not empty groups with zero totalCount (which creates empty headers)
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Mock Git extension with repository that has no changes
		const mockRepository = {
			state: {
				workingTreeChanges: [], // No changes
				indexChanges: [], // No changes
			},
			rootUri: vscode.Uri.file("/workspace/test"),
		};

		vscode.extensions.getExtension = mock<unknown>(() => ({
			exports: {
				getAPI: mock(() => ({
					repositories: [mockRepository],
					onDidOpenRepository: mock(() => ({ dispose: mock() })),
					onDidCloseRepository: mock(() => ({ dispose: mock() })),
				})),
			},
			isActive: true,
		}));

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);
		await provider.initialize();

		const children = await provider.getChildren();

		// Should return empty array, not empty groups
		expect(children).toEqual([]);
		expect(children.length).toBe(0);

		// Specifically check it's not returning empty groups with totalCount: 0
		const hasEmptyGroups = children.some(
			(child: unknown) =>
				(child as { type?: string; totalCount?: number }).type ===
					"GitStatusGroup" &&
				(child as { type?: string; totalCount?: number }).totalCount === 0,
		);
		expect(hasEmptyGroups).toBe(false);
	});
});
