/**
 * Terminal Link Provider - Smart file path resolution from terminal output.
 * Scans terminal lines for file references and opens them in VS Code.
 */

import * as path from "node:path";
import * as vscode from "vscode";

/** Parsed file reference from terminal output */
export interface FileReference {
	filePath: string;
	line?: number;
	column?: number;
	matchStart: number;
	matchLength: number;
}

/**
 * File reference patterns ordered by specificity.
 * Each pattern has a named group `file` and optional `line`/`col`.
 */
export const FILE_PATTERNS: { name: string; regex: RegExp }[] = [
	// Node.js / TypeScript stack traces: at Something (file:line:col)
	{
		name: "node-stack",
		regex: /\((?<file>[^\s()]+\.[a-zA-Z]{1,10}):(?<line>\d+):(?<col>\d+)\)/g,
	},
	// Generic file:line:col (most common)
	{
		name: "file-line-col",
		regex:
			/(?<file>(?:\.{0,2}\/)?[^\s:'"()[\]{}]+\.[a-zA-Z]{1,10}):(?<line>\d+):(?<col>\d+)/g,
	},
	// Generic file:line
	{
		name: "file-line",
		regex:
			/(?<file>(?:\.{0,2}\/)?[^\s:'"()[\]{}]+\.[a-zA-Z]{1,10}):(?<line>\d+)/g,
	},
	// Python traceback: File "path", line N
	{
		name: "python-traceback",
		regex: /File "(?<file>[^"]+)", line (?<line>\d+)/g,
	},
	// Go compiler: path/file.go:line:col: error
	{
		name: "go-compiler",
		regex: /(?<file>[^\s]+\.go):(?<line>\d+):(?<col>\d+):/g,
	},
	// Rust compiler: --> file:line:col
	{
		name: "rust-compiler",
		regex: /--> (?<file>[^\s]+):(?<line>\d+):(?<col>\d+)/g,
	},
];

/**
 * Extract file references from a terminal line.
 * Exported for testability.
 */
export function extractFileReferences(line: string): FileReference[] {
	const refs: FileReference[] = [];
	const seen = new Set<string>();

	for (const pattern of FILE_PATTERNS) {
		// Reset lastIndex for global regex
		pattern.regex.lastIndex = 0;
		let match: RegExpExecArray | null;

		while ((match = pattern.regex.exec(line)) !== null) {
			const groups = match.groups;
			if (!groups?.["file"]) continue;

			const filePath = groups["file"];

			// Skip obvious non-files
			if (filePath.startsWith("http://") || filePath.startsWith("https://"))
				continue;
			if (filePath.startsWith("node:")) continue;
			if (filePath.includes("node_modules")) continue;

			// Deduplicate by position
			const key = `${match.index}:${match[0].length}`;
			if (seen.has(key)) continue;
			seen.add(key);

			refs.push({
				filePath,
				line: groups["line"] ? Number.parseInt(groups["line"], 10) : undefined,
				column: groups["col"] ? Number.parseInt(groups["col"], 10) : undefined,
				matchStart: match.index,
				matchLength: match[0].length,
			});
		}
	}

	return refs;
}

interface CCTerminalLink extends vscode.TerminalLink {
	filePath: string;
	line?: number;
	column?: number;
}

export class CommandCentralTerminalLinkProvider
	implements vscode.TerminalLinkProvider<CCTerminalLink>
{
	async provideTerminalLinks(
		context: vscode.TerminalLinkContext,
	): Promise<CCTerminalLink[]> {
		const line = context.line;
		const refs = extractFileReferences(line);
		if (refs.length === 0) return [];

		const workspaceRoots = this.getWorkspaceRoots();
		if (workspaceRoots.length === 0) return [];

		const links: CCTerminalLink[] = [];

		for (const ref of refs) {
			const resolvedPath = await this.resolveFilePath(
				ref.filePath,
				workspaceRoots,
			);
			if (!resolvedPath) continue;

			links.push({
				startIndex: ref.matchStart,
				length: ref.matchLength,
				tooltip: `Open ${path.basename(resolvedPath)}${ref.line ? `:${ref.line}` : ""}`,
				filePath: resolvedPath,
				line: ref.line,
				column: ref.column,
			});
		}

		return links;
	}

	async handleTerminalLink(link: CCTerminalLink): Promise<void> {
		const uri = vscode.Uri.file(link.filePath);
		const doc = await vscode.workspace.openTextDocument(uri);

		const options: vscode.TextDocumentShowOptions = {};
		if (link.line) {
			const line = Math.max(0, link.line - 1);
			const col = Math.max(0, (link.column || 1) - 1);
			const pos = new vscode.Position(line, col);
			options.selection = new vscode.Range(pos, pos);
		}

		await vscode.window.showTextDocument(doc, options);
	}

	private getWorkspaceRoots(): string[] {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders) return [];
		return folders.map((f) => f.uri.fsPath);
	}

	private async resolveFilePath(
		filePath: string,
		roots: string[],
	): Promise<string | null> {
		// If absolute, check directly
		if (path.isAbsolute(filePath)) {
			return (await this.fileExists(filePath)) ? filePath : null;
		}

		// Strip leading ./
		const cleaned = filePath.replace(/^\.\//, "");

		// Try each workspace root
		for (const root of roots) {
			const fullPath = path.join(root, cleaned);
			if (await this.fileExists(fullPath)) {
				return fullPath;
			}
		}

		return null;
	}

	private async fileExists(filePath: string): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
			return true;
		} catch {
			return false;
		}
	}
}
