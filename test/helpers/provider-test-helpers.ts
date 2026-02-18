/**
 * Test helpers for SortedGitChangesProvider
 *
 * These helpers handle:
 * 1. Provider initialization (setGitApi + initialize)
 * 2. TimeGroup[] to GitChangeItem[] flattening
 * 3. Extracting files from specific time periods
 *
 * Created: 2025-10-19 (Phase 2 of test refactoring)
 * Purpose: Systematic fix for 150+ tests expecting flat arrays vs TimeGroup[]
 */

import * as vscode from "vscode";
import { SortedGitChangesProvider } from "../../src/git-sort/sorted-changes-provider.js";
import type { LoggerService } from "../../src/services/logger-service.js";
import type {
	GitExtensionAPI,
	Repository,
} from "../../src/types/git-extension.types.js";
import type {
	GitChangeItem,
	TimeGroup,
	TreeElement,
} from "../../src/types/tree-element.js";

/**
 * Set up a fully initialized provider with mock git changes
 *
 * This handles ALL the initialization that tests often forget:
 * - Creates mock git API with changes
 * - Calls provider.setGitApi()
 * - Calls provider.initialize()
 * - Sets workspace if provided
 *
 * @example
 * ```typescript
 * const provider = await setupProviderWithChanges([
 *   { uri: "/workspace/Button.tsx", status: 0 },
 *   { uri: "/workspace/Header.tsx", status: 0 }
 * ]);
 * const groups = await provider.getChildren();
 * // groups is TimeGroup[] - properly initialized!
 * ```
 */
export async function setupProviderWithChanges(
	changes: { uri: string; status: number }[],
	workspaceUri?: vscode.Uri,
	mockLogger?: LoggerService,
): Promise<SortedGitChangesProvider> {
	// Create default logger if not provided
	const logger =
		mockLogger ||
		({
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
			setLevel: () => {},
		} as unknown as LoggerService);

	// Create mock extension context
	const mockContext = {
		extensionUri: vscode.Uri.file("/mock/extension"),
		globalStorageUri: vscode.Uri.file("/mock/storage"),
	} as vscode.ExtensionContext;

	// Create provider instance
	const provider = new SortedGitChangesProvider(
		logger,
		mockContext,
		undefined, // No storage adapter (in-memory mode)
		undefined, // No workspace root URI
		undefined, // No filter state
		undefined, // No workspace ID
		undefined, // No grouping state manager
	);

	// Create mock repository with changes
	const mockRepo: Repository = {
		rootUri: workspaceUri || vscode.Uri.file("/workspace"),
		state: {
			workingTreeChanges: changes.map((c) => ({
				uri: vscode.Uri.file(c.uri),
				status: c.status,
				originalUri: vscode.Uri.file(c.uri),
			})),
			indexChanges: [],
			mergeChanges: [],
			onDidChange: () => ({ dispose: () => {} }),
		},
	} as unknown as Repository;

	// Create mock git API
	const mockGitApi = {
		repositories: [mockRepo],
		getRepository: (uri: vscode.Uri) => {
			// Return repo if URI is within repo's root
			if (uri.fsPath.startsWith(mockRepo.rootUri.fsPath)) {
				return mockRepo;
			}
			return null;
		},
		onDidOpenRepository: () => ({ dispose: () => {} }),
		onDidCloseRepository: () => ({ dispose: () => {} }),
	} as unknown as GitExtensionAPI;

	// Mock vscode.extensions.getExtension to return our git API
	// This is required for provider.initialize() to work
	const mockGitExtension: vscode.Extension<{ getAPI: () => GitExtensionAPI }> =
		{
			id: "vscode.git",
			extensionUri: vscode.Uri.file("/mock/git"),
			extensionPath: "/mock/git",
			isActive: true,
			packageJSON: {},
			extensionKind: vscode.ExtensionKind.Workspace,
			activate: async () => ({ getAPI: () => mockGitApi }),
			exports: { getAPI: () => mockGitApi },
		};

	// Override getExtension to return our mock (tests should restore after use)
	const originalGetExtension = vscode.extensions.getExtension;
	vscode.extensions.getExtension = ((_id: string) =>
		mockGitExtension) as typeof vscode.extensions.getExtension;

	// Initialize provider
	await provider.initialize();

	// Restore original getExtension
	vscode.extensions.getExtension = originalGetExtension;

	return provider;
}

/**
 * Flatten TimeGroup[] to GitChangeItem[]
 *
 * Provider returns TimeGroup[] but many tests expect flat GitChangeItem[].
 * This helper extracts all files from all groups.
 *
 * @example
 * ```typescript
 * const groups = await provider.getChildren(); // TimeGroup[]
 * const files = flattenTimeGroups(groups);      // GitChangeItem[]
 * const filePaths = files.map(f => f.uri.fsPath);
 * expect(filePaths).toContain("/workspace/Button.tsx");
 * ```
 */
export function flattenTimeGroups(children: TreeElement[]): GitChangeItem[] {
	return children.flatMap((item) => {
		// Check if item is a TimeGroup (has 'children' property)
		if ("children" in item && Array.isArray(item.children)) {
			return item.children; // Extract files from group
		}
		return [item]; // Item is already a file
	}) as GitChangeItem[];
}

/**
 * Get files from a specific time period
 *
 * When tests need files from a specific group (e.g., "today", "yesterday")
 *
 * @example
 * ```typescript
 * const groups = await provider.getChildren();
 * const todayFiles = getFilesInGroup(groups, "today");
 * expect(todayFiles.length).toBeGreaterThan(0);
 * ```
 */
export function getFilesInGroup(
	children: TreeElement[],
	timePeriod: TimeGroup["timePeriod"],
): GitChangeItem[] {
	const group = children.find(
		(item): item is TimeGroup =>
			"timePeriod" in item && item.timePeriod === timePeriod,
	);
	return group?.children || [];
}

/**
 * Get all time groups (filter out individual files)
 *
 * When tests need to work specifically with TimeGroup objects
 *
 * @example
 * ```typescript
 * const groups = getTimeGroups(await provider.getChildren());
 * expect(groups.length).toBe(2); // Today and Yesterday
 * ```
 */
export function getTimeGroups(children: TreeElement[]): TimeGroup[] {
	return children.filter((item): item is TimeGroup => "timePeriod" in item);
}
