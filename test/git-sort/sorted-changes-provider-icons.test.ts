import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LoggerService } from "../../src/services/logger-service.js";
import type { GitChangeItem } from "../../src/types/tree-element.js";
import { createMockLogger } from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// Type helper for icon path testing
interface IconPath {
	light: { path: string; scheme: string; toString: () => string };
	dark: { path: string; scheme: string; toString: () => string };
}

describe("Git Status Icon Integration", () => {
	let mockLogger: LoggerService;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
		mockLogger = createMockLogger();
	});

	test("should use resourceUri for individual file icons (not custom icons)", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = {
			extensionUri: vscode.Uri.file("/mock/extension/path"),
		} as unknown as import("vscode").ExtensionContext;

		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const stagedElement: GitChangeItem = {
			type: "gitChangeItem",
			uri: vscode.Uri.file("/mock/file.ts"),
			status: "M",
			isStaged: true,
			timestamp: Date.now(),
		};

		const treeItem = provider.getTreeItem(stagedElement);

		// Individual files should use resourceUri for VS Code's default file icons
		expect(treeItem.iconPath).toBeUndefined();
		expect(treeItem.resourceUri).toBeDefined();
		expect(treeItem.resourceUri?.fsPath).toBe("/mock/file.ts");
	});

	test("should use resourceUri for unstaged file icons (not custom icons)", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = {
			extensionUri: vscode.Uri.file("/mock/extension/path"),
		} as unknown as import("vscode").ExtensionContext;

		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const workingElement: GitChangeItem = {
			type: "gitChangeItem",
			uri: vscode.Uri.file("/mock/file.ts"),
			status: "M",
			isStaged: false,
			timestamp: Date.now(),
		};

		const treeItem = provider.getTreeItem(workingElement);

		// Individual files should use resourceUri for VS Code's default file icons
		expect(treeItem.iconPath).toBeUndefined();
		expect(treeItem.resourceUri).toBeDefined();
		expect(treeItem.resourceUri?.fsPath).toBe("/mock/file.ts");
	});

	test("should assign staged icon path for staged status group", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);
		const { GitStatusGroupBuilder } = await import(
			"../builders/tree-element-builder.js"
		);

		const mockContext = {
			extensionUri: vscode.Uri.file("/mock/extension/path"),
		} as unknown as import("vscode").ExtensionContext;

		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const stagedGroup = new GitStatusGroupBuilder()
			.staged()
			.withTotalCount(3)
			.build();

		const treeItem = provider.getTreeItem(stagedGroup);
		const iconPath = treeItem.iconPath as unknown as IconPath;

		expect(iconPath.light.path).toContain("staged.svg");
		expect(iconPath.dark.path).toContain("staged.svg");
	});

	test("should assign working icon path for working status group", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);
		const { GitStatusGroupBuilder } = await import(
			"../builders/tree-element-builder.js"
		);

		const mockContext = {
			extensionUri: vscode.Uri.file("/mock/extension/path"),
		} as unknown as import("vscode").ExtensionContext;

		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const workingGroup = new GitStatusGroupBuilder()
			.unstaged()
			.withTotalCount(5)
			.build();

		const treeItem = provider.getTreeItem(workingGroup);
		const iconPath = treeItem.iconPath as unknown as IconPath;

		expect(iconPath.light.path).toContain("working.svg");
		expect(iconPath.dark.path).toContain("working.svg");
	});

	test("should maintain iconPath structure with light and dark URIs for groups", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);
		const { GitStatusGroupBuilder } = await import(
			"../builders/tree-element-builder.js"
		);

		const mockContext = {
			extensionUri: vscode.Uri.file("/mock/extension/path"),
		} as unknown as import("vscode").ExtensionContext;

		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const group = new GitStatusGroupBuilder()
			.staged()
			.withTotalCount(3)
			.build();

		const treeItem = provider.getTreeItem(group);
		const iconPath = treeItem.iconPath as unknown as IconPath;

		expect(iconPath.light).toBeDefined();
		expect(iconPath.dark).toBeDefined();
		expect(iconPath.light.scheme).toBeDefined();
		expect(iconPath.dark.scheme).toBeDefined();
	});

	test("should use extension context for path resolution in groups", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);
		const { GitStatusGroupBuilder } = await import(
			"../builders/tree-element-builder.js"
		);

		const mockContext = {
			extensionUri: vscode.Uri.file("/mock/extension/path"),
		} as unknown as import("vscode").ExtensionContext;

		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const group = new GitStatusGroupBuilder()
			.unstaged()
			.withTotalCount(5)
			.build();

		const treeItem = provider.getTreeItem(group);
		const iconPath = treeItem.iconPath as unknown as IconPath;

		// Paths should be resolved from extension URI
		expect(iconPath.light.toString()).toContain("mock/extension/path");
		expect(iconPath.dark.toString()).toContain("mock/extension/path");
	});
});
