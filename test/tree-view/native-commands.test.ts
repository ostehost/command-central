/**
 * Native Command Behavior Tests
 *
 * TIER 1: Prevent Production Crashes
 *
 * Tests that verify the MOST COMMON tree view pitfall is avoided:
 * Setting commands on folder/group items breaks VS Code's native
 * expand/collapse behavior.
 *
 * USER IMPACT:
 * - Time groups won't expand/collapse on double-click (broken UX)
 * - Files won't open on double-click (core functionality broken)
 * - Deleted files can't show diffs (important for reviewing changes)
 *
 * CURRENT STATUS: SHOULD PASS
 * - Code at sorted-changes-provider.ts lines 747-757 looks correct (no command on groups)
 * - Code at sorted-changes-provider.ts lines 865-869 sets command on files
 * - These tests prevent regressions
 *
 * PITFALL #1: Commands on Folders Break Expand/Collapse ⚠️ MOST COMMON
 * This is the #1 mistake developers make with VS Code tree views.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as vscode from "vscode";
import type { LoggerService } from "../../src/services/logger-service.js";
import { createMockExtensionContext } from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// Create mock logger
const createMockLogger = (): LoggerService =>
	({
		info: mock(),
		error: mock(),
		warn: mock(),
		debug: mock(),
		performance: mock(),
		process: mock(),
		setLogLevel: mock(),
		getLogLevel: mock(() => 1),
		show: mock(),
		hide: mock(),
		clear: mock(),
		getOutputChannel: mock(),
		getHistory: mock(() => []),
		exportLogs: mock(() => ""),
		dispose: mock(),
	}) as unknown as LoggerService;

describe("Native Command Behavior (TIER 1)", () => {
	let logger: LoggerService;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
		logger = createMockLogger();

		// Mock git-timestamps module
		mock.module("../../src/git-sort/git-timestamps.js", () => ({
			getGitAwareTimestamps: mock(async () => new Map()),
			getDeletedFileTimestamp: mock(async () => undefined),
		}));
	});

	test("PITFALL #1: Time groups have NO command (native expand/collapse)", async () => {
		/**
		 * USER IMPACT: If this fails, double-clicking time groups won't expand them
		 *
		 * WHY CRITICAL: This is the #1 mistake in VS Code tree views
		 * - Setting item.command overrides native expand/collapse behavior
		 * - Users expect folders/groups to expand like Explorer
		 * - Breaking this breaks core tree navigation
		 *
		 * BEHAVIOR: VS Code automatically handles:
		 * - Double-click → expand/collapse
		 * - Arrow Right → expand
		 * - Arrow Left → collapse
		 * - Space → toggle expansion
		 *
		 * REGRESSION: If this fails, time groups become un-expandable
		 *
		 * CURRENT STATUS: SHOULD PASS (code at line 747-757 is correct)
		 */

		// Import provider
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Create provider
		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(logger, mockContext);

		// Create time group element (like "Today", "Yesterday", etc.)
		const timeGroup = {
			type: "timeGroup" as const,
			label: "Today (5 files)",
			timePeriod: "today" as const,
			children: [],
			collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
			contextValue: "timeGroup" as const,
		};

		// Act: Get tree item
		const treeItem = provider.getTreeItem(timeGroup);

		// Assert: No command set (VS Code handles expand/collapse)
		expect(treeItem.command).toBeUndefined();

		// Assert: Has correct collapsible state
		expect(treeItem.collapsibleState).toBe(
			vscode.TreeItemCollapsibleState.Collapsed,
		);

		// Assert: Has context value for menus
		expect(treeItem.contextValue).toBe("timeGroup");

		// Cleanup
		await provider.dispose();
	});

	test("TIER 1: File items HAVE command (double-click opens file)", async () => {
		/**
		 * USER IMPACT: If this fails, files won't open on double-click
		 *
		 * WHY CRITICAL: Core functionality of a git changes view
		 * - Users expect to double-click files to open them
		 * - This is muscle memory from Explorer
		 *
		 * BEHAVIOR: VS Code automatically handles:
		 * - Double-click → execute command
		 * - Enter key → execute command
		 * - Single-click → execute command (if setting enabled)
		 *
		 * REGRESSION: If this fails, files can't be opened from tree
		 *
		 * CURRENT STATUS: SHOULD PASS (code at line 865-869 is correct)
		 */

		// Import provider
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Create provider
		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(logger, mockContext);

		// Create file change element
		const fileChange = {
			uri: vscode.Uri.file("/workspace/src/file.ts"),
			status: "Modified",
			isStaged: false,
			timestamp: Date.now(),
		};

		// Act: Get tree item
		const treeItem = provider.getTreeItem(fileChange);

		// Assert: Command is set (using native diff behavior like Source Control)
		expect(treeItem.command).toBeDefined();
		expect(treeItem.command?.command).toBe("commandCentral.gitSort.openChange");
		expect(treeItem.command?.title).toBe("Open Changes");

		// Assert: Command receives the file change item as argument
		expect(treeItem.command?.arguments).toEqual([fileChange]);

		// Assert: Correct collapsible state (files don't collapse)
		expect(treeItem.collapsibleState).toBe(
			vscode.TreeItemCollapsibleState.None,
		);

		// Cleanup
		await provider.dispose();
	});

	test("TIER 1: Deleted files HAVE command (can view diff)", async () => {
		/**
		 * USER IMPACT: If this fails, users can't see what was deleted
		 *
		 * WHY CRITICAL: Deleted files can still show diff (HEAD vs deleted)
		 * - Important for reviewing what changed
		 * - Common workflow: see what was deleted, decide to restore
		 *
		 * REGRESSION: If this fails, deleted files become "dead" items
		 *
		 * CURRENT STATUS: SHOULD PASS (code handles deleted files)
		 */

		// Import provider
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Create provider
		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(logger, mockContext);

		// Create deleted file change
		const deletedFile = {
			uri: vscode.Uri.file("/workspace/src/deleted.ts"),
			status: "Deleted",
			isStaged: false,
			timestamp: Date.now(),
		};

		// Act: Get tree item
		const treeItem = provider.getTreeItem(deletedFile);

		// Assert: Command is set (can still view diff)
		expect(treeItem.command).toBeDefined();
		expect(treeItem.command?.command).toBe("commandCentral.gitSort.openChange");

		// Assert: Has special deleted file context
		expect(treeItem.contextValue).toBe("unstaged-deleted");

		// Assert: Has trash icon (visual indicator)
		expect(treeItem.iconPath).toBeDefined();

		// Cleanup
		await provider.dispose();
	});

	test("TIER 1: Staged files have command (same as unstaged)", async () => {
		/**
		 * USER IMPACT: Consistent behavior for staged/unstaged files
		 *
		 * REGRESSION: If staged files don't open, workflow broken
		 */

		// Import provider
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Create provider
		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(logger, mockContext);

		// Create staged file change
		const stagedFile = {
			uri: vscode.Uri.file("/workspace/src/file.ts"),
			status: "Modified",
			isStaged: true, // Staged!
			timestamp: Date.now(),
		};

		// Act: Get tree item
		const treeItem = provider.getTreeItem(stagedFile);

		// Assert: Command is set (same as unstaged)
		expect(treeItem.command).toBeDefined();
		expect(treeItem.command?.command).toBe("commandCentral.gitSort.openChange");

		// Assert: Different context value (for menus)
		expect(treeItem.contextValue).toBe("staged");

		// Cleanup
		await provider.dispose();
	});

	test("TIER 1: Files with both staged+unstaged changes have command", async () => {
		/**
		 * USER IMPACT: Edge case - file modified after staging
		 *
		 * BEHAVIOR: Should still open (show working tree version)
		 *
		 * REGRESSION: If this fails, partially-staged files can't be opened
		 */

		// Import provider
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Create provider
		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(logger, mockContext);

		// Create file with both staged and unstaged changes
		const mixedFile = {
			uri: vscode.Uri.file("/workspace/src/file.ts"),
			status: "Modified (staged+unstaged)",
			isStaged: false, // Working tree version
			timestamp: Date.now(),
		};

		// Act: Get tree item
		const treeItem = provider.getTreeItem(mixedFile);

		// Assert: Command is set
		expect(treeItem.command).toBeDefined();
		expect(treeItem.command?.command).toBe("commandCentral.gitSort.openChange");

		// Assert: Special context value for this state
		expect(treeItem.contextValue).toBe("staged-and-unstaged");

		// Cleanup
		await provider.dispose();
	});

	test("TIER 1: Time groups use native collapsible state", async () => {
		/**
		 * USER IMPACT: Time groups should expand/collapse naturally
		 *
		 * BEHAVIOR: Verify both collapsed and expanded states work
		 */

		// Import provider
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Create provider
		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(logger, mockContext);

		// Test collapsed state
		const collapsedGroup = {
			type: "timeGroup" as const,
			label: "Yesterday (3 files)",
			timePeriod: "yesterday" as const,
			children: [],
			collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
			contextValue: "timeGroup" as const,
		};

		const collapsedItem = provider.getTreeItem(collapsedGroup);
		expect(collapsedItem.collapsibleState).toBe(
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		expect(collapsedItem.command).toBeUndefined(); // CRITICAL

		// Test expanded state
		const expandedGroup = {
			type: "timeGroup" as const,
			label: "Today (5 files)",
			timePeriod: "today" as const,
			children: [],
			collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
			contextValue: "timeGroup" as const,
		};

		const expandedItem = provider.getTreeItem(expandedGroup);
		expect(expandedItem.collapsibleState).toBe(
			vscode.TreeItemCollapsibleState.Expanded,
		);
		expect(expandedItem.command).toBeUndefined(); // CRITICAL

		// Cleanup
		await provider.dispose();
	});
});
