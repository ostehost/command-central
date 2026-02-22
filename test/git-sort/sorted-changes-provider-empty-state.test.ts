/**
 * Tests for empty state message distinction between 'no repo' and 'no changes'
 *
 * Bug: When a git repo exists but has NO uncommitted changes, the sidebar shows
 * "Open a Git repository to see time-sorted changes." (from viewsWelcome).
 * This is wrong — that message should only show when there's truly no git repo.
 *
 * Fix: Use TreeView.message API which takes PRIORITY over viewsWelcome.
 * - No git repo → message stays undefined (viewsWelcome handles it)
 * - Repo exists, zero changes → message = "No changes to display."
 * - Repo exists, has changes → message = undefined (cleared)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LoggerService } from "../../src/services/logger-service.js";
import {
	createMockExtensionContext,
	createMockLogger,
} from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

/**
 * Helper: create a mock TreeView that tracks message changes
 */
function createMessageTrackingTreeView() {
	const messages: (string | undefined)[] = [];
	let currentMessage: string | undefined;
	return {
		view: {
			get title() {
				return "";
			},
			set title(_value: string) {
				// no-op for these tests
			},
			description: "",
			get message() {
				return currentMessage;
			},
			set message(value: string | undefined) {
				currentMessage = value;
				messages.push(value);
			},
			badge: undefined as { value: number; tooltip: string } | undefined,
			visible: true,
			onDidChangeVisibility: mock(() => ({ dispose: mock() })),
			onDidChangeSelection: mock(() => ({ dispose: mock() })),
			reveal: mock(() => Promise.resolve()),
			dispose: mock(),
		},
		messages,
	};
}

/**
 * Helper: set up git extension mock with given git API
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
				// biome-ignore lint/suspicious/noExplicitAny: GitExtension API has dynamic export structure
			}) as import("vscode").Extension<any>,
	);
}

describe("Empty State Message Distinction", () => {
	let mockLogger: LoggerService;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();

		// Mock filesystem
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

	test("no git API → message stays undefined (viewsWelcome handles it)", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// No git extension
		vscode.extensions.getExtension = mock(() => undefined);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		// Set up tree view to track messages
		const activityBar = createMessageTrackingTreeView();
		// biome-ignore lint/suspicious/noExplicitAny: test mock cast
		provider.setActivityBarTreeView(activityBar.view as any);

		await provider.initialize();
		const children = await provider.getChildren();

		expect(children).toEqual([]);
		// Message should be undefined so viewsWelcome shows
		expect(activityBar.view.message).toBeUndefined();
	});

	test("git API with no repositories → message stays undefined (viewsWelcome handles it)", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Git API exists but with no repos
		const mockGitApi = {
			repositories: [],
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
		};

		setupGitExtensionMock(vscode, mockGitApi);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const activityBar = createMessageTrackingTreeView();
		// biome-ignore lint/suspicious/noExplicitAny: test mock cast
		provider.setActivityBarTreeView(activityBar.view as any);

		await provider.initialize();
		const children = await provider.getChildren();

		expect(children).toEqual([]);
		// Message should be undefined so viewsWelcome shows
		expect(activityBar.view.message).toBeUndefined();
	});

	test("repo exists, zero working+index changes → message is 'No changes to display.'", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

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

		setupGitExtensionMock(vscode, mockGitApi);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const activityBar = createMessageTrackingTreeView();
		// biome-ignore lint/suspicious/noExplicitAny: test mock cast
		provider.setActivityBarTreeView(activityBar.view as any);

		await provider.initialize();
		const children = await provider.getChildren();

		expect(children).toEqual([]);
		// Message should be "No changes to display." since repo exists
		expect(activityBar.view.message).toBe("No changes to display.");
	});

	test("repo exists, has changes → message is undefined (cleared)", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockRepo = {
			rootUri: vscode.Uri.file("/workspace"),
			state: {
				workingTreeChanges: [
					{
						uri: vscode.Uri.file("/workspace/file1.ts"),
						originalUri: vscode.Uri.file("/workspace/file1.ts"),
						renameUri: undefined,
						status: 5, // Modified
					},
				],
				indexChanges: [],
				onDidChange: mock(() => ({ dispose: () => {} })),
			},
		};

		const mockGitApi = {
			repositories: [mockRepo],
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
		};

		setupGitExtensionMock(vscode, mockGitApi);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const activityBar = createMessageTrackingTreeView();
		// biome-ignore lint/suspicious/noExplicitAny: test mock cast
		provider.setActivityBarTreeView(activityBar.view as any);

		await provider.initialize();
		const children = await provider.getChildren();

		// Should have items
		expect(children.length).toBeGreaterThan(0);
		// Message should be undefined (cleared) since there are actual changes
		expect(activityBar.view.message).toBeUndefined();
	});

	test("panel tree view also receives empty state messages", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

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

		setupGitExtensionMock(vscode, mockGitApi);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(mockLogger, mockContext);

		const activityBar = createMessageTrackingTreeView();
		const panel = createMessageTrackingTreeView();
		// biome-ignore lint/suspicious/noExplicitAny: test mock cast
		provider.setActivityBarTreeView(activityBar.view as any);
		// biome-ignore lint/suspicious/noExplicitAny: test mock cast
		provider.setPanelTreeView(panel.view as any);

		await provider.initialize();
		await provider.getChildren();

		// Both views should show the "no changes" message
		expect(activityBar.view.message).toBe("No changes to display.");
		expect(panel.view.message).toBe("No changes to display.");
	});
});
