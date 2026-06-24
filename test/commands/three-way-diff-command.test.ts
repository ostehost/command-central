/**
 * Tests for Three-Way Diff Command
 *
 * PRD Requirement: Open three diff views side-by-side for files with both staged and unstaged changes (MM status)
 * - Column 1: HEAD ↔ Index (staged changes)
 * - Column 2: Index ↔ Working Tree (unstaged changes)
 * - Column 3: HEAD ↔ Working Tree (complete changes)
 *
 * Testing Pattern:
 * - Mock VS Code API and Git extension
 * - Test command execution with MM file state
 * - Verify correct vscode.diff calls with ViewColumns
 * - Test error cases (non-MM files, missing repo)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("Three-Way Diff Command", () => {
	let mockExecuteCommand: ReturnType<typeof mock>;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
		mockExecuteCommand = mock(() => Promise.resolve());
	});

	test("opens all three diff views with correct URIs, titles, and columns", async () => {
		const vscode = await import("vscode");
		vscode.commands.executeCommand = mockExecuteCommand;

		// Mock file URIs for MM file (modified in both index and working tree)
		const fileUri = vscode.Uri.file("/workspace/src/file.ts");
		const headUri = fileUri.with({ scheme: "git", query: "HEAD" });
		const indexUri = fileUri.with({ scheme: "git", query: "" });

		// Mock Git repository with MM change
		const stagedChange = {
			uri: indexUri,
			originalUri: headUri,
			status: 0, // INDEX_MODIFIED
		};

		const workingChange = {
			uri: fileUri,
			originalUri: headUri,
			status: 6, // MODIFIED
		};

		const mockRepo = {
			rootUri: vscode.Uri.file("/workspace"),
			state: {
				workingTreeChanges: [workingChange],
				indexChanges: [stagedChange],
				onDidChange: mock(() => ({ dispose: () => {} })),
			},
			status: mock(() => Promise.resolve()),
			diffWithHEAD: mock(() => Promise.resolve([])),
			diffWith: mock(() => Promise.resolve([])),
		};

		const mockGitApi = {
			repositories: [mockRepo],
			onDidChangeState: mock(() => ({ dispose: () => {} })),
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
		} as unknown as import("../../src/types/git-extension.types.js").GitAPI;

		const mockGitExtension = {
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

		// Import and execute command
		const { openThreeWayDiff } = await import(
			"../../src/commands/three-way-diff-command.js"
		);

		const mmItem = {
			type: "gitChangeItem" as const,
			uri: fileUri,
			status: "Modified",
			isStaged: false,
			contextValue: "staged-and-unstaged",
			timestamp: Date.now(),
			order: 0,
		};

		await openThreeWayDiff(mmItem, mockGitApi);

		// Assert: exactly three diff views opened (one per column)
		expect(mockExecuteCommand).toHaveBeenCalledTimes(3);

		const [call1, call2, call3] = mockExecuteCommand.mock.calls;
		if (!call1 || !call2 || !call3) {
			throw new Error("Expected three vscode.diff calls to be recorded");
		}

		// Column 1: HEAD ↔ Index (staged changes)
		const [cmd1, left1, right1, title1, opts1] = call1;
		expect(cmd1).toBe("vscode.diff");
		expect(left1.toString()).toBe(headUri.toString());
		expect(right1.toString()).toBe(indexUri.toString());
		expect(title1).toBe("file.ts (HEAD ↔ Staged)");
		expect(opts1).toEqual({ viewColumn: vscode.ViewColumn.One });

		// Column 2: Index ↔ Working Tree (unstaged changes)
		const [cmd2, left2, right2, title2, opts2] = call2;
		expect(cmd2).toBe("vscode.diff");
		expect(left2.toString()).toBe(indexUri.toString());
		expect(right2.toString()).toBe(fileUri.toString());
		expect(title2).toBe("file.ts (Staged ↔ Working)");
		expect(opts2).toEqual({ viewColumn: vscode.ViewColumn.Two });

		// Column 3: HEAD ↔ Working Tree (complete changes)
		const [cmd3, left3, right3, title3, opts3] = call3;
		expect(cmd3).toBe("vscode.diff");
		expect(left3.toString()).toBe(headUri.toString());
		expect(right3.toString()).toBe(fileUri.toString());
		expect(title3).toBe("file.ts (HEAD ↔ Working)");
		expect(opts3).toEqual({ viewColumn: vscode.ViewColumn.Three });
	});

	test("shows warning for non-MM file (staged only)", async () => {
		const vscode = await import("vscode");
		vscode.commands.executeCommand = mockExecuteCommand;

		const fileUri = vscode.Uri.file("/workspace/src/file.ts");

		const mockShowWarningMessage = mock();
		vscode.window.showWarningMessage = mockShowWarningMessage;

		const { openThreeWayDiff } = await import(
			"../../src/commands/three-way-diff-command.js"
		);

		const stagedOnlyItem = {
			type: "gitChangeItem" as const,
			uri: fileUri,
			status: "Modified",
			isStaged: true,
			contextValue: "staged",
			timestamp: Date.now(),
			order: 0,
		};

		await openThreeWayDiff(stagedOnlyItem, null);

		// Assert: Warning shown, no diffs opened
		expect(mockShowWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining("both staged and unstaged"),
		);
		expect(mockExecuteCommand).not.toHaveBeenCalled();
	});

	test("shows warning for non-MM file (unstaged only)", async () => {
		const vscode = await import("vscode");
		vscode.commands.executeCommand = mockExecuteCommand;

		const fileUri = vscode.Uri.file("/workspace/src/file.ts");

		const mockShowWarningMessage = mock();
		vscode.window.showWarningMessage = mockShowWarningMessage;

		const { openThreeWayDiff } = await import(
			"../../src/commands/three-way-diff-command.js"
		);

		const unstagedOnlyItem = {
			type: "gitChangeItem" as const,
			uri: fileUri,
			status: "Modified",
			isStaged: false,
			contextValue: "unstaged",
			timestamp: Date.now(),
			order: 0,
		};

		await openThreeWayDiff(unstagedOnlyItem, null);

		// Assert: Warning shown, no diffs opened
		expect(mockShowWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining("both staged and unstaged"),
		);
		expect(mockExecuteCommand).not.toHaveBeenCalled();
	});

	test("handles missing Git API gracefully", async () => {
		const vscode = await import("vscode");
		const mockExecuteCommand = vscode.commands.executeCommand as ReturnType<
			typeof mock
		>;

		const fileUri = vscode.Uri.file("/workspace/src/file.ts");

		const mockShowErrorMessage = mock();
		vscode.window.showErrorMessage = mockShowErrorMessage;

		const { openThreeWayDiff } = await import(
			"../../src/commands/three-way-diff-command.js"
		);

		const mmItem = {
			type: "gitChangeItem" as const,
			uri: fileUri,
			status: "Modified",
			isStaged: false,
			contextValue: "staged-and-unstaged",
			timestamp: Date.now(),
			order: 0,
		};

		await openThreeWayDiff(mmItem, null);

		// Assert: Error shown
		expect(mockShowErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("Git extension not available"),
		);
		expect(mockExecuteCommand).not.toHaveBeenCalled();
	});

	test("handles missing repository gracefully", async () => {
		const vscode = await import("vscode");
		const mockExecuteCommand = vscode.commands.executeCommand as ReturnType<
			typeof mock
		>;

		const fileUri = vscode.Uri.file("/workspace/src/file.ts");

		// Mock Git API with no repositories
		const mockGitApi = {
			repositories: [],
			onDidChangeState: mock(() => ({ dispose: () => {} })),
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
		} as unknown as import("../../src/types/git-extension.types.js").GitAPI;

		const mockShowErrorMessage = mock();
		vscode.window.showErrorMessage = mockShowErrorMessage;

		const { openThreeWayDiff } = await import(
			"../../src/commands/three-way-diff-command.js"
		);

		const mmItem = {
			type: "gitChangeItem" as const,
			uri: fileUri,
			status: "Modified",
			isStaged: false,
			contextValue: "staged-and-unstaged",
			timestamp: Date.now(),
			order: 0,
		};

		await openThreeWayDiff(mmItem, mockGitApi);

		// Assert: Error shown
		expect(mockShowErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("No repository found"),
		);
		expect(mockExecuteCommand).not.toHaveBeenCalled();
	});

	test("handles missing staged change gracefully", async () => {
		const vscode = await import("vscode");
		const mockExecuteCommand = vscode.commands.executeCommand as ReturnType<
			typeof mock
		>;

		const fileUri = vscode.Uri.file("/workspace/src/file.ts");

		// Mock Git repository with only working tree change (no staged change)
		const workingChange = {
			uri: fileUri,
			originalUri: fileUri.with({ scheme: "git", query: "HEAD" }),
			status: 6, // MODIFIED
		};

		const mockRepo = {
			rootUri: vscode.Uri.file("/workspace"),
			state: {
				workingTreeChanges: [workingChange],
				indexChanges: [], // No staged changes
				onDidChange: mock(() => ({ dispose: () => {} })),
			},
			status: mock(() => Promise.resolve()),
			diffWithHEAD: mock(() => Promise.resolve([])),
			diffWith: mock(() => Promise.resolve([])),
		};

		const mockGitApi = {
			repositories: [mockRepo],
			onDidChangeState: mock(() => ({ dispose: () => {} })),
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
		} as unknown as import("../../src/types/git-extension.types.js").GitAPI;

		const mockShowErrorMessage = mock();
		vscode.window.showErrorMessage = mockShowErrorMessage;

		const { openThreeWayDiff } = await import(
			"../../src/commands/three-way-diff-command.js"
		);

		const mmItem = {
			type: "gitChangeItem" as const,
			uri: fileUri,
			status: "Modified",
			isStaged: false,
			contextValue: "staged-and-unstaged",
			timestamp: Date.now(),
			order: 0,
		};

		await openThreeWayDiff(mmItem, mockGitApi);

		// Assert: Error shown
		expect(mockShowErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("Could not find staged changes"),
		);
		expect(mockExecuteCommand).not.toHaveBeenCalled();
	});

	test("handles missing working tree change gracefully", async () => {
		const vscode = await import("vscode");
		const mockExecuteCommand = vscode.commands.executeCommand as ReturnType<
			typeof mock
		>;

		const fileUri = vscode.Uri.file("/workspace/src/file.ts");
		const headUri = fileUri.with({ scheme: "git", query: "HEAD" });
		const indexUri = fileUri.with({ scheme: "git", query: "" });

		// Mock Git repository with only staged change (no working tree change)
		const stagedChange = {
			uri: indexUri,
			originalUri: headUri,
			status: 0, // INDEX_MODIFIED
		};

		const mockRepo = {
			rootUri: vscode.Uri.file("/workspace"),
			state: {
				workingTreeChanges: [], // No working tree changes
				indexChanges: [stagedChange],
				onDidChange: mock(() => ({ dispose: () => {} })),
			},
			status: mock(() => Promise.resolve()),
			diffWithHEAD: mock(() => Promise.resolve([])),
			diffWith: mock(() => Promise.resolve([])),
		};

		const mockGitApi = {
			repositories: [mockRepo],
			onDidChangeState: mock(() => ({ dispose: () => {} })),
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
		} as unknown as import("../../src/types/git-extension.types.js").GitAPI;

		const mockShowErrorMessage = mock();
		vscode.window.showErrorMessage = mockShowErrorMessage;

		const { openThreeWayDiff } = await import(
			"../../src/commands/three-way-diff-command.js"
		);

		const mmItem = {
			type: "gitChangeItem" as const,
			uri: fileUri,
			status: "Modified",
			isStaged: false,
			contextValue: "staged-and-unstaged",
			timestamp: Date.now(),
			order: 0,
		};

		await openThreeWayDiff(mmItem, mockGitApi);

		// Assert: Error shown
		expect(mockShowErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("Could not find working tree changes"),
		);
		expect(mockExecuteCommand).not.toHaveBeenCalled();
	});

	test("derives diff titles from the file basename and preserves column order", async () => {
		const vscode = await import("vscode");
		vscode.commands.executeCommand = mockExecuteCommand;

		const fileUri = vscode.Uri.file("/workspace/src/component.tsx");
		const headUri = fileUri.with({ scheme: "git", query: "HEAD" });
		const indexUri = fileUri.with({ scheme: "git", query: "" });

		const stagedChange = {
			uri: indexUri,
			originalUri: headUri,
			status: 0,
		};

		const workingChange = {
			uri: fileUri,
			originalUri: headUri,
			status: 6,
		};

		const mockRepo = {
			rootUri: vscode.Uri.file("/workspace"),
			state: {
				workingTreeChanges: [workingChange],
				indexChanges: [stagedChange],
				onDidChange: mock(() => ({ dispose: () => {} })),
			},
			status: mock(() => Promise.resolve()),
			diffWithHEAD: mock(() => Promise.resolve([])),
			diffWith: mock(() => Promise.resolve([])),
		};

		const mockGitApi = {
			repositories: [mockRepo],
			onDidChangeState: mock(() => ({ dispose: () => {} })),
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
		} as unknown as import("../../src/types/git-extension.types.js").GitAPI;

		const mockGitExtension = {
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

		const { openThreeWayDiff } = await import(
			"../../src/commands/three-way-diff-command.js"
		);

		const mmItem = {
			type: "gitChangeItem" as const,
			uri: fileUri,
			status: "Modified",
			isStaged: false,
			contextValue: "staged-and-unstaged",
			timestamp: Date.now(),
			order: 0,
		};

		await openThreeWayDiff(mmItem, mockGitApi);

		// Assert: three diffs opened, titles built from the actual basename
		expect(mockExecuteCommand).toHaveBeenCalledTimes(3);

		const [call1, call2, call3] = mockExecuteCommand.mock.calls;
		if (!call1 || !call2 || !call3) {
			throw new Error("Expected three vscode.diff calls to be recorded");
		}

		const [, , , title1] = call1;
		expect(title1).toBe("component.tsx (HEAD ↔ Staged)");

		const [, , , title2] = call2;
		expect(title2).toBe("component.tsx (Staged ↔ Working)");

		const [, , , title3] = call3;
		expect(title3).toBe("component.tsx (HEAD ↔ Working)");
	});
});
