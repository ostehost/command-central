/**
 * Regression tests for two bugs in sorted-changes-provider:
 *
 * Bug 1 (timestamp error on empty input):
 *   When grouping is enabled and one group has 0 files (e.g., no staged files),
 *   enrichWithTimestamps([]) logged "No files with valid timestamps" and showed
 *   a user-facing error toast. Empty input is normal — not an error.
 *   Root cause: no early-return for empty arrays in enrichWithTimestamps().
 *
 * Bug 2 (missing group header icons):
 *   GitStatusGroup headers (Staged/Working) referenced SVG files at
 *   resources/icons/git-status/{light,dark}/{staged,working}.svg that were
 *   deleted in commit 7ab54ce (v0.2.0 cleanup). VS Code silently failed
 *   to load them, rendering group headers without icons.
 *   Root cause: getGitStatusIcon() built file URIs to non-existent SVGs.
 *   Fix: restored branded SVG icons in resources/icons/git-status/.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LoggerService } from "../../src/services/logger-service.js";
import {
	createMockExtensionContext,
	createMockGroupingStateManager,
	createMockLogger,
} from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

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

describe("Regression: enrichWithTimestamps false error on empty input", () => {
	let mockLogger: LoggerService;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();

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

	test("no staged files does not log timestamp error or show error toast", async () => {
		// Reproduces: grouping enabled, 0 staged files, enrichWithTimestamps([])
		// was called → logged "No files with valid timestamps" + showed error toast.
		// This is the exact scenario from the bug report.
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
						status: 5, // MODIFIED
					},
				],
				indexChanges: [], // NO staged files — triggers the bug
				onDidChange: mock(() => ({ dispose: () => {} })),
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
			undefined,
			undefined,
			undefined,
			undefined,
			createMockGroupingStateManager(true) as unknown,
		);

		await provider.initialize();
		await provider.getChildren();

		// The bug: enrichWithTimestamps([]) logged this error
		const errorCalls = (
			mockLogger.error as unknown as { mock: { calls: unknown[][] } }
		).mock.calls;
		const timestampErrors = errorCalls.filter(
			(call: unknown[]) =>
				typeof call[0] === "string" &&
				call[0].includes("No files with valid timestamps"),
		);
		expect(timestampErrors.length).toBe(0);

		// The bug also showed a user-facing error toast
		const showErrorCalls = (
			vscode.window.showErrorMessage as unknown as {
				mock: { calls: unknown[][] };
			}
		).mock.calls;
		const toastErrors = showErrorCalls.filter(
			(call: unknown[]) =>
				typeof call[0] === "string" &&
				call[0].includes("Failed to get timestamps"),
		);
		expect(toastErrors.length).toBe(0);
	});

	test("no working files does not log timestamp error or show error toast", async () => {
		// Same bug, inverse case: 0 working files, some staged files.
		// enrichWithTimestamps([]) was called for the working array.
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockRepo = {
			rootUri: vscode.Uri.file("/workspace"),
			state: {
				workingTreeChanges: [], // NO working files — triggers the bug
				indexChanges: [
					{
						uri: vscode.Uri.file("/workspace/staged.ts"),
						originalUri: vscode.Uri.file("/workspace/staged.ts"),
						renameUri: undefined,
						status: 0, // INDEX_MODIFIED
					},
				],
				onDidChange: mock(() => ({ dispose: () => {} })),
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
			undefined,
			undefined,
			undefined,
			undefined,
			createMockGroupingStateManager(true) as unknown,
		);

		await provider.initialize();
		await provider.getChildren();

		const errorCalls = (
			mockLogger.error as unknown as { mock: { calls: unknown[][] } }
		).mock.calls;
		const timestampErrors = errorCalls.filter(
			(call: unknown[]) =>
				typeof call[0] === "string" &&
				call[0].includes("No files with valid timestamps"),
		);
		expect(timestampErrors.length).toBe(0);
	});

	test("staged and working files appear in separate groups", async () => {
		// Guards against the reported symptom: "staged files appearing under Working."
		// If someone merges the arrays or breaks the grouping path, this catches it.
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockRepo = {
			rootUri: vscode.Uri.file("/workspace"),
			state: {
				workingTreeChanges: [
					{
						uri: vscode.Uri.file("/workspace/working.ts"),
						originalUri: vscode.Uri.file("/workspace/working.ts"),
						renameUri: undefined,
						status: 5, // MODIFIED
					},
				],
				indexChanges: [
					{
						uri: vscode.Uri.file("/workspace/staged.ts"),
						originalUri: vscode.Uri.file("/workspace/staged.ts"),
						renameUri: undefined,
						status: 0, // INDEX_MODIFIED
					},
				],
				onDidChange: mock(() => ({ dispose: () => {} })),
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
			undefined,
			undefined,
			undefined,
			undefined,
			createMockGroupingStateManager(true) as unknown,
		);

		await provider.initialize();
		const children = await provider.getChildren();

		// Must be 2 separate groups, not 1 merged group
		expect(children.length).toBe(2);

		const staged = children[0] as { statusType: string; totalCount: number };
		const working = children[1] as { statusType: string; totalCount: number };

		expect(staged.statusType).toBe("staged");
		expect(staged.totalCount).toBe(1);
		expect(working.statusType).toBe("unstaged");
		expect(working.totalCount).toBe(1);
	});
});

describe("Regression: group header icons reference deleted SVGs", () => {
	let mockLogger: LoggerService;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
		mockLogger = createMockLogger();
	});

	test("staged group header uses branded SVG icons", async () => {
		// Previously: getGitStatusIcon("staged") returned URI to
		// resources/icons/git-status/light/staged.svg — deleted in 7ab54ce.
		// Now: SVGs are restored as branded icons with { light, dark } paths.
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);
		const { GitStatusGroupBuilder } = await import(
			"../builders/tree-element-builder.js"
		);

		const provider = new SortedGitChangesProvider(
			mockLogger,
			createMockExtensionContext(),
		);

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

	test("working group header uses branded SVG icons", async () => {
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);
		const { GitStatusGroupBuilder } = await import(
			"../builders/tree-element-builder.js"
		);

		const provider = new SortedGitChangesProvider(
			mockLogger,
			createMockExtensionContext(),
		);

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
});
