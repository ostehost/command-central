/**
 * Tree View Utility Commands
 *
 * Minimal wrappers around VS Code's built-in commands.
 * These commands provide Explorer-like functionality for our custom tree views.
 *
 * Design Philosophy:
 * - Delegate to VS Code built-ins whenever possible
 * - Minimal custom logic (just argument translation)
 * - Graceful error handling (log but don't crash)
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type { GitChangeItem } from "../types/tree-element.js";

/**
 * Module-level state for file comparison workflow
 * Stores the URI of the file selected for comparison
 */
let compareSelection: vscode.Uri | undefined;

/**
 * Reveal file in Explorer sidebar
 *
 * Delegates to VS Code's built-in 'revealInExplorer' command.
 * This is a standard command available in all VS Code tree views.
 *
 * USER WORKFLOW:
 * 1. Right-click file in git changes
 * 2. Select "Reveal in Explorer"
 * 3. Explorer sidebar opens and focuses on file
 *
 * @param item - Git change item to reveal
 */
export async function revealInExplorer(item: GitChangeItem): Promise<void> {
	try {
		await vscode.commands.executeCommand("revealInExplorer", item.uri);
	} catch (_error) {
		// Graceful fallback - if file doesn't exist or reveal fails
		vscode.window.showWarningMessage(
			`Could not reveal file: ${item.uri.fsPath}`,
		);
	}
}

/**
 * Copy absolute file path to clipboard
 *
 * Uses VS Code's clipboard API to copy the full file path.
 * Shows confirmation message to user.
 *
 * USER WORKFLOW:
 * 1. Right-click file in git changes
 * 2. Select "Copy Path"
 * 3. Absolute path copied to clipboard
 * 4. Paste into terminal/chat/docs
 *
 * @param item - Git change item to copy path from
 */
export async function copyPath(item: GitChangeItem): Promise<void> {
	try {
		await vscode.env.clipboard.writeText(item.uri.fsPath);
		vscode.window.showInformationMessage(`Copied: ${item.uri.fsPath}`);
	} catch (_error) {
		vscode.window.showErrorMessage(`Failed to copy path: ${item.uri.fsPath}`);
	}
}

/**
 * Copy workspace-relative file path to clipboard
 *
 * Uses VS Code's workspace API to get relative path.
 * Handles multi-root workspaces correctly (finds correct root).
 *
 * USER WORKFLOW:
 * 1. Right-click file in git changes
 * 2. Select "Copy Relative Path"
 * 3. Workspace-relative path copied (e.g., "src/file.ts" instead of "/full/path/src/file.ts")
 * 4. Shorter paths for sharing with team
 *
 * MULTI-ROOT SUPPORT:
 * - Automatically finds correct workspace folder
 * - Returns shortest relative path
 *
 * @param item - Git change item to copy path from
 */
export async function copyRelativePath(item: GitChangeItem): Promise<void> {
	try {
		const relativePath = vscode.workspace.asRelativePath(item.uri);
		await vscode.env.clipboard.writeText(relativePath);
		vscode.window.showInformationMessage(`Copied: ${relativePath}`);
	} catch (_error) {
		vscode.window.showErrorMessage(
			`Failed to copy relative path: ${item.uri.fsPath}`,
		);
	}
}

/**
 * Open file in split editor (to the side)
 *
 * Uses VS Code's built-in command with ViewColumn.Beside to open in split view.
 * This matches Explorer's "Open to the Side" behavior.
 *
 * USER WORKFLOW:
 * 1. Right-click file in git changes
 * 2. Select "Open to the Side"
 * 3. File opens in split editor alongside current file
 * 4. Perfect for comparing or referencing files
 *
 * @param item - Git change item to open
 */
export async function openToSide(item: GitChangeItem): Promise<void> {
	try {
		await vscode.commands.executeCommand(
			"vscode.open",
			item.uri,
			vscode.ViewColumn.Beside,
		);
	} catch (_error) {
		vscode.window.showErrorMessage(
			`Failed to open file to the side: ${item.uri.fsPath}`,
		);
	}
}

/**
 * Select file for comparison (step 1 of compare workflow)
 *
 * Stores the file URI for later comparison. This matches VS Code Explorer's
 * "Select for Compare" command behavior.
 *
 * USER WORKFLOW:
 * 1. Right-click first file → Select "Select for Compare"
 * 2. Notification shows which file was selected
 * 3. Right-click second file → Select "Compare with Selected"
 * 4. Diff viewer opens showing differences
 *
 * @param item - Git change item to select for comparison
 */
export async function selectForCompare(item: GitChangeItem): Promise<void> {
	compareSelection = item.uri;
	const fileName = path.basename(item.uri.fsPath);
	vscode.window.showInformationMessage(`Selected for compare: ${fileName}`);
}

/**
 * Compare file with previously selected file (step 2 of compare workflow)
 *
 * Opens VS Code's built-in diff viewer comparing the previously selected file
 * (via selectForCompare) with the current file.
 *
 * USER WORKFLOW:
 * 1. User must first call selectForCompare on a file
 * 2. Right-click different file → Select "Compare with Selected"
 * 3. Diff viewer opens side-by-side
 *
 * ERROR HANDLING:
 * - Shows warning if no file was previously selected
 * - Shows error if diff viewer fails to open
 *
 * @param item - Git change item to compare with selected file
 */
export async function compareWithSelected(item: GitChangeItem): Promise<void> {
	if (!compareSelection) {
		vscode.window.showWarningMessage(
			"Select a file to compare with first (right-click → Select for Compare)",
		);
		return;
	}

	try {
		const leftName = path.basename(compareSelection.fsPath);
		const rightName = path.basename(item.uri.fsPath);

		await vscode.commands.executeCommand(
			"vscode.diff",
			compareSelection,
			item.uri,
			`${leftName} ↔ ${rightName}`,
		);
	} catch (_error) {
		vscode.window.showErrorMessage("Failed to open comparison");
	}
}

/**
 * Reveal file in operating system file manager
 *
 * Uses VS Code's built-in command to show the file in:
 * - macOS: Finder
 * - Windows: File Explorer
 * - Linux: File Manager
 *
 * This is DIFFERENT from "Reveal in Explorer" which reveals in VS Code's Explorer sidebar.
 * This command opens the OS-native file browser.
 *
 * USER WORKFLOW:
 * 1. Right-click file → Select "Reveal in Finder" (macOS) / "Reveal in File Explorer" (Windows)
 * 2. OS file manager opens showing the file location
 * 3. File is highlighted/selected in the file manager
 *
 * CROSS-PLATFORM:
 * - Command name adapts to OS (Finder/File Explorer/File Manager)
 * - Uses native OS file browser
 * - Highlights the specific file in its containing folder
 *
 * @param item - Git change item to reveal in OS file manager
 */
export async function revealInFinder(item: GitChangeItem): Promise<void> {
	try {
		await vscode.commands.executeCommand("revealFileInOS", item.uri);
	} catch (_error) {
		vscode.window.showErrorMessage(
			`Failed to reveal file in file manager: ${item.uri.fsPath}`,
		);
	}
}

/**
 * Open integrated terminal in file's directory
 *
 * Creates and shows a new integrated terminal with the working directory
 * set to the file's containing folder.
 *
 * USER WORKFLOW:
 * 1. Right-click file → Select "Open in Integrated Terminal"
 * 2. Terminal opens in VS Code's terminal panel
 * 3. Current directory is set to file's folder
 * 4. User can immediately run commands related to the file
 *
 * COMMON USE CASES:
 * - Run tests for the file
 * - Execute scripts in the same directory
 * - Use git commands on the file
 * - Build/compile the file
 *
 * @param item - Git change item to open terminal for
 */
export async function openInIntegratedTerminal(
	item: GitChangeItem,
): Promise<void> {
	try {
		const directory = path.dirname(item.uri.fsPath);
		const fileName = path.basename(item.uri.fsPath);

		const terminal = vscode.window.createTerminal({
			name: `Terminal - ${fileName}`,
			cwd: directory,
		});

		terminal.show();
	} catch (_error) {
		vscode.window.showErrorMessage(
			`Failed to open terminal: ${item.uri.fsPath}`,
		);
	}
}

/**
 * Open file with editor picker
 *
 * Uses VS Code's built-in command to show a picker dialog that lets
 * the user choose which editor to use for opening the file.
 *
 * USER WORKFLOW:
 * 1. Right-click file → Select "Open With..."
 * 2. VS Code shows picker with available editors
 * 3. User selects preferred editor (e.g., text editor, JSON editor, hex editor)
 * 4. File opens in selected editor
 *
 * USEFUL FOR:
 * - JSON files (choose between text editor or JSON editor)
 * - Markdown files (choose between text editor or preview)
 * - Images (choose between image viewer or hex editor)
 * - Binary files (choose appropriate viewer)
 *
 * @param item - Git change item to open with picker
 */
export async function openWith(item: GitChangeItem): Promise<void> {
	try {
		await vscode.commands.executeCommand("vscode.openWith", item.uri);
	} catch (_error) {
		vscode.window.showErrorMessage(
			`Failed to open editor picker: ${item.uri.fsPath}`,
		);
	}
}

/**
 * Open file in preview mode
 *
 * Opens the file in preview mode (single-click behavior) rather than
 * pinning it as a permanent tab.
 *
 * USER WORKFLOW:
 * 1. Right-click file → Select "Open Preview"
 * 2. File opens in preview tab (italicized tab title)
 * 3. Opening another preview replaces this one
 * 4. User can pin it by editing or double-clicking
 *
 * PREVIEW MODE BENEFITS:
 * - Quickly scan through multiple files
 * - Doesn't clutter tab bar with many tabs
 * - Matches single-click behavior in Explorer
 * - Can be promoted to permanent tab by editing
 *
 * @param item - Git change item to open in preview
 */
export async function openPreview(item: GitChangeItem): Promise<void> {
	try {
		await vscode.commands.executeCommand("vscode.open", item.uri, {
			preview: true,
			preserveFocus: false,
		});
	} catch (_error) {
		vscode.window.showErrorMessage(
			`Failed to open preview: ${item.uri.fsPath}`,
		);
	}
}
