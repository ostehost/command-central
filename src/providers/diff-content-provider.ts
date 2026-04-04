import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export const BINARY_FILE_PLACEHOLDER = "<<binary file>>";

interface DiffContentUriOptions {
	projectDir: string;
	ref: string;
	relativePath: string;
	taskId: string;
}

interface DiffContentProviderDependencies {
	execFileSync?: typeof execFileSync;
	readFileSync?: typeof fs.readFileSync;
	join?: typeof path.join;
}

function encodeRelativePath(relativePath: string): string {
	return relativePath
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

function decodeRelativePath(uriPath: string): string {
	const trimmedPath = uriPath.startsWith("/") ? uriPath.slice(1) : uriPath;
	return trimmedPath
		.split("/")
		.map((segment) => decodeURIComponent(segment))
		.join("/");
}

function decodeBuffer(content: Buffer | string): string {
	const buffer = Buffer.isBuffer(content)
		? content
		: Buffer.from(String(content));
	if (buffer.includes(0x00)) return BINARY_FILE_PLACEHOLDER;
	return buffer.toString("utf-8");
}

export function buildDiffContentUri({
	projectDir,
	ref,
	relativePath,
	taskId,
}: DiffContentUriOptions): vscode.Uri {
	const params = new URLSearchParams({
		project: projectDir,
		ref,
		taskId,
	});

	return vscode.Uri.parse(
		`${DiffContentProvider.scheme}:/${encodeRelativePath(relativePath)}?${params.toString()}`,
	);
}

/**
 * Provides git-backed content for per-file agent diffs without temp files.
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
	static readonly scheme = "cc-diff";

	constructor(
		private readonly dependencies: DiffContentProviderDependencies = {},
	) {}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const params = new URLSearchParams(uri.query);
		const projectDir = params.get("project");
		const ref = params.get("ref");

		if (!projectDir || !ref) return "";

		const relativePath = decodeRelativePath(uri.path);

		if (ref === "empty") return "";
		if (ref === "working-tree") {
			return this.readWorkingTree(projectDir, relativePath);
		}

		return this.readGitRef(projectDir, ref, relativePath);
	}

	private readGitRef(
		projectDir: string,
		ref: string,
		relativePath: string,
	): string {
		try {
			const runExecFileSync = this.dependencies.execFileSync ?? execFileSync;
			const content = runExecFileSync(
				"git",
				["-C", projectDir, "show", `${ref}:${relativePath}`],
				{ timeout: 5000 },
			);
			return decodeBuffer(content);
		} catch {
			return "";
		}
	}

	private readWorkingTree(projectDir: string, relativePath: string): string {
		try {
			const joinPath = this.dependencies.join ?? path.join;
			const readFileSync = this.dependencies.readFileSync ?? fs.readFileSync;
			const absolutePath = joinPath(projectDir, relativePath);
			const content = readFileSync(absolutePath);
			return decodeBuffer(content);
		} catch {
			return "";
		}
	}
}
