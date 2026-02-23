/**
 * Regression test: catch block in getChildren() must show "No changes to display."
 *
 * Bug: When getChildren() encounters an internal error (e.g., enrichWithTimestamps
 * throws), the catch block called setEmptyStateMessage(false) which set the
 * TreeView.message to undefined. This allowed the viewsWelcome content
 * ("Open a Git repository to see time-sorted changes.") to show — misleading
 * because a repo DOES exist, the error is internal.
 *
 * Fix: The catch block now calls setEmptyStateMessage(true) which sets
 * TreeView.message to "No changes to display." — this takes priority over
 * viewsWelcome and correctly indicates the issue is not about missing repos.
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
	let currentMessage: string | undefined;
	const messages: (string | undefined)[] = [];
	return {
		view: {
			get title() {
				return "";
			},
			set title(_value: string) {
				// no-op
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
 * Helper: set up git extension mock
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
				// biome-ignore lint/suspicious/noExplicitAny: GitExtension mock
			}) as import("vscode").Extension<any>,
	);
}

describe("Regression: catch block shows 'No changes' instead of 'Open a Git repo'", () => {
	let mockLogger: LoggerService;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
		mockLogger = createMockLogger();
	});

	test("internal error in getChildren shows 'No changes to display.' not viewsWelcome", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Create a repo whose state throws when accessed — triggers catch block
		// without needing mock.module on git-timestamps (which poisons other tests)
		let callCount = 0;
		const mockRepo = {
			rootUri: vscode.Uri.file("/workspace"),
			get state() {
				callCount++;
				// Let initialize() succeed (first few calls), then throw during getChildren
				if (callCount > 2) {
					throw new Error("Simulated internal error");
				}
				return {
					workingTreeChanges: [
						{
							uri: vscode.Uri.file("/workspace/file1.ts"),
							originalUri: vscode.Uri.file("/workspace/file1.ts"),
							renameUri: undefined,
							status: 5, // MODIFIED
						},
					],
					indexChanges: [],
					onDidChange: mock(() => ({ dispose: () => {} })),
				};
			},
			diffWithHEAD: mock(() => Promise.resolve([])),
		};

		setupGitExtensionMock(vscode, {
			repositories: [mockRepo],
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
		});

		const provider = new SortedGitChangesProvider(
			mockLogger,
			createMockExtensionContext(),
		);

		// Track messages on the TreeView
		const activityBar = createMessageTrackingTreeView();
		// biome-ignore lint/suspicious/noExplicitAny: test mock cast
		provider.setActivityBarTreeView(activityBar.view as any);

		await provider.initialize();
		const children = await provider.getChildren();

		// Tree should return empty (error occurred)
		expect(children).toEqual([]);

		// CRITICAL: Message must be "No changes to display." — NOT undefined.
		// If message is undefined, viewsWelcome shows "Open a Git repository..."
		// which is WRONG because a repo exists; the issue is internal.
		expect(activityBar.view.message).toBe("No changes to display.");

		// Should also log the error for debugging
		// biome-ignore lint/suspicious/noExplicitAny: mock type access
		const errorCalls = (mockLogger.error as any).mock.calls;
		const sortedChangesErrors = errorCalls.filter(
			// biome-ignore lint/suspicious/noExplicitAny: mock call args
			(call: any[]) =>
				typeof call[0] === "string" &&
				call[0].includes("Failed to get sorted changes"),
		);
		expect(sortedChangesErrors.length).toBe(1);
	});
});
