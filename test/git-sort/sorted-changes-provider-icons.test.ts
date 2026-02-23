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

	test("should assign ThemeIcon for staged status group", async () => {
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

		expect(treeItem.iconPath).toBeInstanceOf(vscode.ThemeIcon);
		expect(
			(treeItem.iconPath as InstanceType<typeof vscode.ThemeIcon>).id,
		).toBe("check");
	});

	test("should assign ThemeIcon for working status group", async () => {
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

		expect(treeItem.iconPath).toBeInstanceOf(vscode.ThemeIcon);
		expect(
			(treeItem.iconPath as InstanceType<typeof vscode.ThemeIcon>).id,
		).toBe("edit");
	});

	test("should use ThemeIcon (not file paths) for group icons", async () => {
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

		// ThemeIcon is a single object, not { light, dark } file paths
		expect(treeItem.iconPath).toBeInstanceOf(vscode.ThemeIcon);
		expect(treeItem.iconPath).not.toHaveProperty("light");
		expect(treeItem.iconPath).not.toHaveProperty("dark");
	});

	test("group icons are ThemeIcons independent of extension path", async () => {
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

		// ThemeIcons don't depend on extension path — they're built into VS Code
		expect(treeItem.iconPath).toBeInstanceOf(vscode.ThemeIcon);
		const icon = treeItem.iconPath as InstanceType<typeof vscode.ThemeIcon>;
		expect(icon.id).toBe("edit");
	});
});
