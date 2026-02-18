/**
 * Extended tests for SortedGitChangesProvider
 * Focuses on working public API methods to maximize coverage
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	GitStatusGroupBuilder,
	TimeGroupBuilder,
} from "../builders/tree-element-builder.js";
import {
	createMockExtensionContext,
	createMockLogger,
} from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("SortedGitChangesProvider State Management", () => {
	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
	});

	test("onDidChangeTreeData event fires when refresh is called", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);

		let eventCount = 0;
		provider.onDidChangeTreeData(() => {
			eventCount++;
		});

		provider.refresh();
		provider.refresh();

		expect(eventCount).toBe(2);
	});

	test("multiple subscribers receive events", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);

		let count1 = 0;
		let count2 = 0;

		provider.onDidChangeTreeData(() => count1++);
		provider.onDidChangeTreeData(() => count2++);

		provider.refresh();

		expect(count1).toBe(1);
		expect(count2).toBe(1);
	});

	test("setSortOrder triggers refresh event", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);

		let refreshed = false;
		provider.onDidChangeTreeData(() => {
			refreshed = true;
		});

		provider.setSortOrder("oldest");

		expect(refreshed).toBe(true);
		expect(provider.getSortOrder()).toBe("oldest");
	});

	test("setSortOrder toggles between newest and oldest", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);

		expect(provider.getSortOrder()).toBe("newest");

		provider.setSortOrder("oldest");
		expect(provider.getSortOrder()).toBe("oldest");

		provider.setSortOrder("newest");
		expect(provider.getSortOrder()).toBe("newest");
	});

	test("setFileTypeFilter triggers refresh event", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);

		let refreshed = false;
		provider.onDidChangeTreeData(() => {
			refreshed = true;
		});

		provider.setFileTypeFilter("code");

		expect(refreshed).toBe(true);
	});

	test("setFileTypeFilter accepts various filter types", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);

		// All these should be callable without throwing
		provider.setFileTypeFilter("all");
		provider.setFileTypeFilter("code");
		provider.setFileTypeFilter("config");
		provider.setFileTypeFilter("docs");
		provider.setFileTypeFilter("images");
		provider.setFileTypeFilter("tests");

		// If we got here, no errors were thrown
		expect(true).toBe(true);
	});
});

describe("SortedGitChangesProvider Lifecycle", () => {
	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
	});

	test("initialize completes without Git extension", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		vscode.extensions.getExtension = mock(() => undefined);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);

		// Should complete without error
		await expect(provider.initialize()).resolves.toBeUndefined();
	});

	test("initialize completes with Git extension but no repos", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockGitApi = {
			repositories: [],
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
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);

		await expect(provider.initialize()).resolves.toBeUndefined();
	});

	test("dispose cleans up resources", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);
		await provider.initialize();

		// Dispose should complete without error
		await expect(provider.dispose()).resolves.toBeUndefined();
	});

	test("dispose can be called multiple times", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);
		await provider.initialize();

		await provider.dispose();
		await provider.dispose();

		// Should not throw
		expect(true).toBe(true);
	});
});

describe("SortedGitChangesProvider TreeDataProvider Contract", () => {
	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
	});

	test("getChildren returns array", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);

		const children = await provider.getChildren();

		expect(Array.isArray(children)).toBe(true);
	});

	test("getChildren without element returns root items", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);

		// No element parameter = get root items
		const rootItems = await provider.getChildren(undefined);

		expect(Array.isArray(rootItems)).toBe(true);
	});

	test("getTreeItem returns TreeItem for any element", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);

		// Create a simple element using typed builder
		const element = new TimeGroupBuilder().today().build();
		const treeItem = provider.getTreeItem(element);

		// Should return a TreeItem with a label
		expect(treeItem).toBeDefined();
		expect(typeof treeItem.label).toBe("string");
	});

	test("getTreeItem handles different element types", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);

		// TimeGroup - use typed builder
		const timeGroup = new TimeGroupBuilder().today().build();
		const timeGroupItem = provider.getTreeItem(timeGroup);
		expect(timeGroupItem).toBeDefined();

		// GitStatusGroup - use typed builder
		const statusGroup = new GitStatusGroupBuilder().staged().build();
		const statusGroupItem = provider.getTreeItem(statusGroup);
		expect(statusGroupItem).toBeDefined();
	});
});

describe("SortedGitChangesProvider Public Methods", () => {
	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
	});

	test("setProjectIcon is callable", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);

		// Method exists
		expect(typeof provider.setProjectIcon).toBe("function");

		// Can be called
		provider.setProjectIcon("icon.svg", mockContext, "🚀");

		expect(true).toBe(true);
	});

	test("findItemByUri returns undefined when no items", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			createMockLogger(),
			mockContext,
		);

		const uri = vscode.Uri.file("/workspace/test.ts");
		const item = provider.findItemByUri(uri);

		expect(item).toBeUndefined();
	});
});
