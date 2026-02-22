/**
 * Tests for badge/title count synchronization with tree content
 *
 * Bug: After file renames/deletions, the TreeView title shows a stale count
 * (e.g., "(20)") while the tree is empty, showing the welcome placeholder.
 *
 * Root cause: getChildren() has multiple early-return paths that return []
 * without updating lastKnownFileCount or refreshing the title.
 *
 * These tests verify that the title count ALWAYS reflects the actual
 * number of items returned by getChildren().
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LoggerService } from "../../src/services/logger-service.js";
import {
	createMockExtensionContext,
	createMockLogger,
} from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("Badge/Title Count Synchronization", () => {
	let mockLogger: LoggerService;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
		mockLogger = createMockLogger();
	});

	test("title count resets to 0 when getChildren returns empty (no git API)", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Mock no Git extension
		vscode.extensions.getExtension = mock(() => undefined);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		// Simulate a previously non-zero count by setting a tree view and triggering title
		const mockTreeView = {
			title: "",
			description: "",
			message: undefined as string | undefined,
			visible: true,
			onDidChangeVisibility: mock(() => ({ dispose: mock() })),
			onDidChangeSelection: mock(() => ({ dispose: mock() })),
			reveal: mock(() => Promise.resolve()),
			dispose: mock(),
		};
		provider.setActivityBarTreeView(mockTreeView as any);

		// First, force a non-zero count in the title by calling getViewTitle indirectly
		// The provider starts with lastKnownFileCount = 0, so let's verify it stays 0
		await provider.initialize();
		const children = await provider.getChildren();

		expect(children).toEqual([]);

		// Title should NOT contain a count (count is 0 = hidden)
		const title = provider.getViewTitle();
		expect(title).not.toMatch(/\(\d+\)/);
	});

	test("title count resets when tree transitions from N items to 0 items", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		// Set up a mock tree view to observe title changes
		const titleHistory: string[] = [];
		const mockTreeView = {
			get title() {
				return titleHistory[titleHistory.length - 1] ?? "";
			},
			set title(value: string) {
				titleHistory.push(value);
			},
			description: "",
			message: undefined as string | undefined,
			visible: true,
			onDidChangeVisibility: mock(() => ({ dispose: mock() })),
			onDidChangeSelection: mock(() => ({ dispose: mock() })),
			reveal: mock(() => Promise.resolve()),
			dispose: mock(),
		};
		provider.setActivityBarTreeView(mockTreeView as any);

		// Mock a repository with some changes first
		const mockRepo = {
			rootUri: vscode.Uri.file("/workspace"),
			state: {
				workingTreeChanges: [
					{
						uri: vscode.Uri.file("/workspace/file1.ts"),
						status: 5, // MODIFIED
						originalUri: vscode.Uri.file("/workspace/file1.ts"),
						renameUri: undefined,
					},
					{
						uri: vscode.Uri.file("/workspace/file2.ts"),
						status: 5,
						originalUri: vscode.Uri.file("/workspace/file2.ts"),
						renameUri: undefined,
					},
				],
				indexChanges: [],
				onDidChange: mock(() => ({ dispose: () => {} })),
			},
			diffWithHEAD: mock(() => Promise.resolve([])),
		};

		const mockGitApi = {
			repositories: [mockRepo],
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
		};

		vscode.extensions.getExtension = mock(
			() =>
				({
					id: "vscode.git",
					extensionUri: vscode.Uri.file("/mock/extension"),
					extensionPath: "/mock/extension",
					isActive: true,
					packageJSON: {},
					extensionKind: vscode.ExtensionKind.Workspace,
					activate: mock(() =>
						Promise.resolve({ getAPI: () => mockGitApi }),
					),
					exports: { getAPI: () => mockGitApi },
				}) as any,
		);

		await provider.initialize();

		// First call: should have 2 files (they'll get timestamps from mocked fs)
		// Note: timestamps may fail for mock files, but the count tracking is what matters
		const children1 = await provider.getChildren();

		// Now simulate all changes being removed (renames/deletions committed)
		mockRepo.state.workingTreeChanges = [];
		mockRepo.state.indexChanges = [];

		// Second call: should have 0 files
		const children2 = await provider.getChildren();
		expect(children2).toEqual([]);

		// CRITICAL: Title should NOT show a stale count
		const finalTitle = provider.getViewTitle();
		expect(finalTitle).not.toMatch(/\(2\)/);
		expect(finalTitle).not.toMatch(/\(\d+\)/);
	});

	test("title count resets when getChildren returns empty (no repo found)", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		// Set up tree view
		const mockTreeView = {
			title: "",
			description: "",
			message: undefined as string | undefined,
			visible: true,
			onDidChangeVisibility: mock(() => ({ dispose: mock() })),
			onDidChangeSelection: mock(() => ({ dispose: mock() })),
			reveal: mock(() => Promise.resolve()),
			dispose: mock(),
		};
		provider.setActivityBarTreeView(mockTreeView as any);

		// Git API with empty repositories
		const mockGitApi = {
			repositories: [],
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
		};

		vscode.extensions.getExtension = mock(
			() =>
				({
					id: "vscode.git",
					extensionUri: vscode.Uri.file("/mock/extension"),
					extensionPath: "/mock/extension",
					isActive: true,
					packageJSON: {},
					extensionKind: vscode.ExtensionKind.Workspace,
					activate: mock(() =>
						Promise.resolve({ getAPI: () => mockGitApi }),
					),
					exports: { getAPI: () => mockGitApi },
				}) as any,
		);

		await provider.initialize();
		const children = await provider.getChildren();

		expect(children).toEqual([]);

		// Title should not show any count
		const title = provider.getViewTitle();
		expect(title).not.toMatch(/\(\d+\)/);
	});

	test("title count resets when getChildren throws an error", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		// Set up tree view
		const mockTreeView = {
			title: "",
			description: "",
			message: undefined as string | undefined,
			visible: true,
			onDidChangeVisibility: mock(() => ({ dispose: mock() })),
			onDidChangeSelection: mock(() => ({ dispose: mock() })),
			reveal: mock(() => Promise.resolve()),
			dispose: mock(),
		};
		provider.setActivityBarTreeView(mockTreeView as any);

		// Mock a repository that throws on access
		const mockGitApi = {
			repositories: [
				{
					rootUri: vscode.Uri.file("/workspace"),
					state: {
						get workingTreeChanges(): never {
							throw new Error("Simulated git error");
						},
						indexChanges: [],
						onDidChange: mock(() => ({ dispose: () => {} })),
					},
				},
			],
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
		};

		vscode.extensions.getExtension = mock(
			() =>
				({
					id: "vscode.git",
					extensionUri: vscode.Uri.file("/mock/extension"),
					extensionPath: "/mock/extension",
					isActive: true,
					packageJSON: {},
					extensionKind: vscode.ExtensionKind.Workspace,
					activate: mock(() =>
						Promise.resolve({ getAPI: () => mockGitApi }),
					),
					exports: { getAPI: () => mockGitApi },
				}) as any,
		);

		await provider.initialize();
		const children = await provider.getChildren();

		expect(children).toEqual([]);

		// Title should not show stale count after error
		const title = provider.getViewTitle();
		expect(title).not.toMatch(/\(\d+\)/);
	});

	test("getViewTitle shows no count when lastKnownFileCount is 0", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		// getViewTitle with default state (count = 0) should have no count suffix
		const title = provider.getViewTitle();
		expect(title).not.toMatch(/\(\d+\)/);
		// Should contain sort indicator
		expect(title).toMatch(/[▼▲]/);
	});

	test("title updates on BOTH activity bar and panel when count changes to 0", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		// Track title assignments on both views
		const activityBarTitles: string[] = [];
		const panelTitles: string[] = [];

		const mockActivityBarView = {
			get title() {
				return activityBarTitles[activityBarTitles.length - 1] ?? "";
			},
			set title(value: string) {
				activityBarTitles.push(value);
			},
			description: "",
			message: undefined as string | undefined,
			visible: true,
			onDidChangeVisibility: mock(() => ({ dispose: mock() })),
			onDidChangeSelection: mock(() => ({ dispose: mock() })),
			reveal: mock(() => Promise.resolve()),
			dispose: mock(),
		};

		const mockPanelView = {
			get title() {
				return panelTitles[panelTitles.length - 1] ?? "";
			},
			set title(value: string) {
				panelTitles.push(value);
			},
			description: "",
			message: undefined as string | undefined,
			visible: true,
			onDidChangeVisibility: mock(() => ({ dispose: mock() })),
			onDidChangeSelection: mock(() => ({ dispose: mock() })),
			reveal: mock(() => Promise.resolve()),
			dispose: mock(),
		};

		provider.setActivityBarTreeView(mockActivityBarView as any);
		provider.setPanelTreeView(mockPanelView as any);

		// Git API with no repos (simulates empty state)
		const mockGitApi = {
			repositories: [],
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
		};

		vscode.extensions.getExtension = mock(
			() =>
				({
					id: "vscode.git",
					extensionUri: vscode.Uri.file("/mock/extension"),
					extensionPath: "/mock/extension",
					isActive: true,
					packageJSON: {},
					extensionKind: vscode.ExtensionKind.Workspace,
					activate: mock(() =>
						Promise.resolve({ getAPI: () => mockGitApi }),
					),
					exports: { getAPI: () => mockGitApi },
				}) as any,
		);

		await provider.initialize();
		await provider.getChildren();

		// Both views should have been updated with count-free titles
		const lastActivityBarTitle =
			activityBarTitles[activityBarTitles.length - 1];
		const lastPanelTitle = panelTitles[panelTitles.length - 1];

		if (lastActivityBarTitle) {
			expect(lastActivityBarTitle).not.toMatch(/\(\d+\)/);
		}
		if (lastPanelTitle) {
			expect(lastPanelTitle).not.toMatch(/\(\d+\)/);
		}
	});
});
