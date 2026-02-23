import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LoggerService } from "../../src/services/logger-service.js";
import type { GitChangeItem } from "../../src/types/tree-element.js";
import { createMockLogger } from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

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

	test("should assign branded SVG icon for staged status group", async () => {
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

		const icon = treeItem.iconPath as {
			light: { path: string };
			dark: { path: string };
		};
		expect(icon.light).toBeDefined();
		expect(icon.dark).toBeDefined();
		expect(icon.light.path).toContain("staged.svg");
		expect(icon.dark.path).toContain("staged.svg");
	});

	test("should assign branded SVG icon for working status group", async () => {
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

		const icon = treeItem.iconPath as {
			light: { path: string };
			dark: { path: string };
		};
		expect(icon.light).toBeDefined();
		expect(icon.dark).toBeDefined();
		expect(icon.light.path).toContain("working.svg");
		expect(icon.dark.path).toContain("working.svg");
	});

	test("should use branded SVG { light, dark } paths for group icons", async () => {
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

		// Branded SVG icons use { light, dark } file paths
		const icon = treeItem.iconPath as {
			light: { path: string };
			dark: { path: string };
		};
		expect(icon.light).toBeDefined();
		expect(icon.dark).toBeDefined();
		expect(icon.light.path).toContain("git-status/light/staged.svg");
		expect(icon.dark.path).toContain("git-status/dark/staged.svg");
	});

	test("group icons use extension path for branded SVGs", async () => {
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

		// Branded SVGs are relative to extension path
		const icon = treeItem.iconPath as {
			light: { path: string };
			dark: { path: string };
		};
		expect(icon.light.path).toContain("/mock/extension/path");
		expect(icon.dark.path).toContain("/mock/extension/path");
	});
});
