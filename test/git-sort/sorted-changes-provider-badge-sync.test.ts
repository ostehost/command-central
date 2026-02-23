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

/**
 * Helper: create a mock TreeView that tracks title changes
 */
function createTitleTrackingTreeView() {
	const titles: string[] = [];
	return {
		view: {
			get title() {
				return titles[titles.length - 1] ?? "";
			},
			set title(value: string) {
				titles.push(value);
			},
			description: "",
			message: undefined as string | undefined,
			badge: undefined as { value: number; tooltip: string } | undefined,
			visible: true,
			onDidChangeVisibility: mock(() => ({ dispose: mock() })),
			onDidChangeSelection: mock(() => ({ dispose: mock() })),
			reveal: mock(() => Promise.resolve()),
			dispose: mock(),
		},
		titles,
	};
}

/**
 * Helper: set up git extension mock with given repos
 */
function setupGitExtensionMock(
	vscode: typeof import("vscode"),
	mockGitApi: unknown,
) {
	vscode.extensions.getExtension = mock(
		() =>
			({
				id: "vscode.git",
				extensionUri: vscode.Uri.file("/mock/extension"),
				extensionPath: "/mock/extension",
				isActive: true,
				packageJSON: {},
				extensionKind: vscode.ExtensionKind.Workspace,
				activate: mock(() => Promise.resolve({ getAPI: () => mockGitApi })),
				exports: { getAPI: () => mockGitApi },
			}) as unknown,
	);
}

describe("Badge/Title Count Synchronization", () => {
	let mockLogger: LoggerService;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();

		// Mock filesystem to return timestamps for mock files
		mock.module("node:fs/promises", () => ({
			stat: mock(async () => ({
				mtime: new Date(),
				isDirectory: () => false,
			})),
			readFile: mock(async () => Buffer.from("{}")),
			writeFile: mock(async () => {}),
			mkdir: mock(async () => {}),
			access: mock(async () => {}),
			realpath: mock(async (p: string) => p),
		}));

		mockLogger = createMockLogger();
	});

	test("title count resets when tree transitions from items to empty", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		// Set up title-tracking tree view
		const { view } = createTitleTrackingTreeView();
		provider.setActivityBarTreeView(view as unknown);

		// Mock repo with 3 modified files
		const mockRepo = {
			rootUri: vscode.Uri.file("/workspace"),
			state: {
				workingTreeChanges: [
					{
						uri: vscode.Uri.file("/workspace/file1.ts"),
						status: 5,
						originalUri: vscode.Uri.file("/workspace/file1.ts"),
						renameUri: undefined,
					},
					{
						uri: vscode.Uri.file("/workspace/file2.ts"),
						status: 5,
						originalUri: vscode.Uri.file("/workspace/file2.ts"),
						renameUri: undefined,
					},
					{
						uri: vscode.Uri.file("/workspace/file3.ts"),
						status: 5,
						originalUri: vscode.Uri.file("/workspace/file3.ts"),
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

		setupGitExtensionMock(vscode, mockGitApi);
		await provider.initialize();

		// First call: should have 3 files
		const children1 = await provider.getChildren();
		expect(children1.length).toBeGreaterThan(0);

		// Verify title contains "(3)"
		const titleAfterFirstCall = provider.getViewTitle();
		expect(titleAfterFirstCall).toContain("(3)");

		// Now remove all changes (simulate renames/deletions being committed)
		mockRepo.state.workingTreeChanges = [];
		mockRepo.state.indexChanges = [];

		// Second call: should have 0 files
		const children2 = await provider.getChildren();
		expect(children2).toEqual([]);

		// CRITICAL: Title should NOT contain "(3)" anymore
		const titleAfterSecondCall = provider.getViewTitle();
		expect(titleAfterSecondCall).not.toMatch(/\(\d+\)/);
	});

	test("title count resets when getChildren returns empty (no git API)", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// No git extension
		vscode.extensions.getExtension = mock(() => undefined);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const { view } = createTitleTrackingTreeView();
		provider.setActivityBarTreeView(view as unknown);

		await provider.initialize();
		const children = await provider.getChildren();

		expect(children).toEqual([]);
		// Title should have no count
		expect(provider.getViewTitle()).not.toMatch(/\(\d+\)/);
	});

	test("title count resets when getChildren returns empty (no repositories)", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const { view } = createTitleTrackingTreeView();
		provider.setActivityBarTreeView(view as unknown);

		setupGitExtensionMock(vscode, {
			repositories: [],
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
		});

		await provider.initialize();
		const children = await provider.getChildren();

		expect(children).toEqual([]);
		expect(provider.getViewTitle()).not.toMatch(/\(\d+\)/);
	});

	test("title count resets when getChildren catches an error", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const { view } = createTitleTrackingTreeView();
		provider.setActivityBarTreeView(view as unknown);

		// Repo that throws during access
		setupGitExtensionMock(vscode, {
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
		});

		await provider.initialize();
		const children = await provider.getChildren();

		expect(children).toEqual([]);
		expect(provider.getViewTitle()).not.toMatch(/\(\d+\)/);
	});

	test("both activity bar and panel titles update when count goes to 0", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const activityBar = createTitleTrackingTreeView();
		const panel = createTitleTrackingTreeView();
		provider.setActivityBarTreeView(activityBar.view as unknown);
		provider.setPanelTreeView(panel.view as unknown);

		// Mock repo with files
		const mockRepo = {
			rootUri: vscode.Uri.file("/workspace"),
			state: {
				workingTreeChanges: [
					{
						uri: vscode.Uri.file("/workspace/a.ts"),
						status: 5,
						originalUri: vscode.Uri.file("/workspace/a.ts"),
						renameUri: undefined,
					},
				],
				indexChanges: [],
				onDidChange: mock(() => ({ dispose: () => {} })),
			},
			diffWithHEAD: mock(() => Promise.resolve([])),
		};

		setupGitExtensionMock(vscode, {
			repositories: [mockRepo],
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
		});

		await provider.initialize();

		// First call populates with 1 file
		await provider.getChildren();
		expect(provider.getViewTitle()).toContain("(1)");

		// Remove all changes
		mockRepo.state.workingTreeChanges = [];

		// Second call should clear the count
		await provider.getChildren();

		const finalTitle = provider.getViewTitle();
		expect(finalTitle).not.toMatch(/\(\d+\)/);

		// Both views should have the updated title
		const lastActivityBarTitle =
			activityBar.titles[activityBar.titles.length - 1];
		const lastPanelTitle = panel.titles[panel.titles.length - 1];

		expect(lastActivityBarTitle).not.toMatch(/\(\d+\)/);
		expect(lastPanelTitle).not.toMatch(/\(\d+\)/);
	});
});
