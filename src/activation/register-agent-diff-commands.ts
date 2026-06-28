/**
 * Agent diff / file-viewing command registration — viewAgentDiff (git diff
 * since the agent started, surfaced as a file picker), smartOpenFile (open
 * the on-disk file, falling back to the diff for deleted files), and
 * openFileDiff (focused two-ref diff for a single changed file via the
 * cc-diff virtual document scheme).
 *
 * Diff routing contract: openFileDiff payloads carry an explicit
 * `diffMode` ("workingTree" | "boundedCommit") — task status is never the
 * routing signal. Payloads without a diffMode are treated as
 * bounded-commit and hit the "No bounded diff" guard when no end ref is
 * supplied.
 *
 * Fully self-contained: no extension.ts module state is touched, so the
 * registration function takes no dependencies. All node:fs / node:child_process
 * access stays behind lazy dynamic imports inside the handlers (activation
 * cost contract).
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type {
	AgentDiffMode,
	AgentTask,
} from "../providers/agent-status-tree-provider.js";
import { buildDiffContentUri } from "../providers/diff-content-provider.js";

export type GitFileReadResult =
	| { kind: "text"; content: string }
	| { kind: "missing" }
	| { kind: "binary" };

/**
 * Classify raw file bytes the way the diff view needs them: NUL byte means
 * binary (no text diff), otherwise decode as UTF-8 text.
 */
export function classifyFileContent(
	content: Buffer | string,
): GitFileReadResult {
	const asBuffer = Buffer.isBuffer(content)
		? content
		: Buffer.from(String(content));
	if (asBuffer.includes(0x00)) return { kind: "binary" };
	return { kind: "text", content: asBuffer.toString("utf-8") };
}

/** Read a file from the working tree; missing/unreadable → "missing". */
export async function readWorkingTreeFile(
	absolutePath: string,
): Promise<GitFileReadResult> {
	const fs = await import("node:fs");
	try {
		return classifyFileContent(fs.readFileSync(absolutePath));
	} catch {
		return { kind: "missing" };
	}
}

/** Read a file at a git ref via `git show`; missing at that ref → "missing". */
export async function readFileAtRef(
	projectDir: string,
	ref: string,
	relativePath: string,
): Promise<GitFileReadResult> {
	const { execFileSync } = await import("node:child_process");
	try {
		const content = execFileSync(
			"git",
			["-C", projectDir, "show", `${ref}:${relativePath}`],
			{ timeout: 3000 },
		);
		return classifyFileContent(content);
	} catch {
		return { kind: "missing" };
	}
}

const showGitDiffAsFilePicker = async (
	projectDir: string,
	rangeArgs: string[],
	_title: string,
	noChangesMessage: string,
	diffMode: AgentDiffMode,
	startCommit?: string,
	endCommit?: string,
): Promise<void> => {
	const { execFileSync } = await import("node:child_process");
	let numstat: string;
	try {
		numstat = execFileSync(
			"git",
			["-C", projectDir, "diff", ...rangeArgs, "--numstat"],
			{ encoding: "utf-8", timeout: 5000 },
		).trim();
	} catch {
		vscode.window.showWarningMessage("Failed to read git diff.");
		return;
	}

	if (!numstat) {
		vscode.window.showInformationMessage(noChangesMessage);
		return;
	}

	const files = numstat
		.split("\n")
		.filter((l) => l.trim())
		.map((line) => {
			const parts = line.split("\t");
			const add = parts[0] ?? "0";
			const del = parts[1] ?? "0";
			const filePath = parts[2];
			const additions = add === "-" ? -1 : Number.parseInt(add, 10);
			const deletions = del === "-" ? -1 : Number.parseInt(del, 10);
			const isBinary = add === "-" && del === "-";
			const statsLabel = isBinary ? "binary" : `+${additions} / -${deletions}`;
			return {
				filePath: filePath ?? "",
				additions,
				deletions,
				isBinary,
				statsLabel,
			};
		});

	if (files.length === 1 && files[0]) {
		// Single file — open diff directly
		await vscode.commands.executeCommand("commandCentral.openFileDiff", {
			projectDir,
			filePath: files[0].filePath,
			startCommit: startCommit,
			endCommit: endCommit,
			diffMode,
			additions: files[0].additions,
			deletions: files[0].deletions,
		});
		return;
	}

	type DiffPickItem = vscode.QuickPickItem & {
		filePath: string;
		additions: number;
		deletions: number;
	};
	const items: DiffPickItem[] = files.map((f) => ({
		label: `$(file) ${f.filePath}`,
		description: f.statsLabel,
		filePath: f.filePath,
		additions: f.additions,
		deletions: f.deletions,
	}));

	const totalAdd = files.reduce((s, f) => s + Math.max(0, f.additions), 0);
	const totalDel = files.reduce((s, f) => s + Math.max(0, f.deletions), 0);

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: `${files.length} files changed (+${totalAdd} / -${totalDel}) — select a file to diff`,
	});
	if (!selected) return;

	await vscode.commands.executeCommand("commandCentral.openFileDiff", {
		projectDir,
		filePath: selected.filePath,
		startCommit: startCommit,
		endCommit: endCommit,
		diffMode,
		additions: selected.additions,
		deletions: selected.deletions,
	});
};

/**
 * Register the three agent diff / file-viewing commands. Returns one
 * disposable per command; the caller owns their lifecycle.
 */
export function registerAgentDiffCommands(): vscode.Disposable[] {
	return [
		// View Agent Diff — opens git diff since agent started
		vscode.commands.registerCommand(
			"commandCentral.viewAgentDiff",
			async (node?: {
				type: string;
				task?: AgentTask;
				agent?: { pid: number; projectDir: string; startTime?: Date };
			}) => {
				const task = node?.task;
				const agent = node?.agent;

				// Discovered agent: diff working tree vs HEAD
				if (agent) {
					const projectDir = agent.projectDir;
					let sinceRef = "HEAD";
					if (agent.startTime) {
						try {
							const { execFileSync } = await import("node:child_process");
							const commitHash = execFileSync(
								"git",
								[
									"-C",
									projectDir,
									"log",
									`--before=${agent.startTime.toISOString()}`,
									"-1",
									"--format=%H",
								],
								{ encoding: "utf-8", timeout: 3000 },
							).trim();
							if (commitHash) sinceRef = commitHash;
						} catch {
							/* fallback to HEAD */
						}
					}
					await showGitDiffAsFilePicker(
						projectDir,
						[sinceRef],
						`Diff: ${path.basename(projectDir)}`,
						"No changes found for this agent.",
						"workingTree",
						sinceRef,
					);
					return;
				}

				// Launcher task: diff since started_at
				if (!task?.project_dir) {
					vscode.window.showWarningMessage(
						"No agent selected. Right-click an agent in the tree.",
					);
					return;
				}

				// Find commit closest to started_at for a precise diff
				let sinceRef = "HEAD~5";
				if (task.started_at) {
					try {
						const { execFileSync } = await import("node:child_process");
						const commitHash = execFileSync(
							"git",
							[
								"-C",
								task.project_dir,
								"log",
								`--before=${task.started_at}`,
								"-1",
								"--format=%H",
							],
							{ encoding: "utf-8", timeout: 3000 },
						).trim();
						if (commitHash) sinceRef = commitHash;
					} catch {
						/* fallback to HEAD~5 */
					}
				}

				// paused is non-terminal (alive WIP, no end_commit) → working-tree
				// diff like running, so View Diff on a parked lane shows its WIP
				// instead of dead-ending on the missing end commit.
				const isRunningTask =
					task.status === "running" || task.status === "paused";
				const endRef =
					task.end_commit && task.end_commit !== "unknown"
						? task.end_commit
						: undefined;
				if (!isRunningTask && !endRef) {
					vscode.window.showInformationMessage(
						"No bounded diff is available for this task.",
					);
					return;
				}
				await showGitDiffAsFilePicker(
					task.project_dir,
					isRunningTask ? [sinceRef] : [`${sinceRef}..${endRef}`],
					`Diff: ${task.id}`,
					"No changes found for this agent.",
					isRunningTask ? "workingTree" : "boundedCommit",
					task.start_sha ?? sinceRef,
					isRunningTask ? undefined : endRef,
				);
			},
		),
		// Smart Open File — opens the actual file on disk (falls back to diff for deleted files)
		vscode.commands.registerCommand(
			"commandCentral.smartOpenFile",
			async (node?: {
				projectDir?: string;
				filePath?: string;
				status?: string;
			}) => {
				if (!node?.projectDir || !node.filePath) {
					vscode.window.showWarningMessage("No file change selected.");
					return;
				}

				const absolutePath = path.isAbsolute(node.filePath)
					? node.filePath
					: path.join(node.projectDir, node.filePath);

				const fs = await import("node:fs");
				if (!fs.existsSync(absolutePath)) {
					// File was deleted — fall back to showing the diff
					await vscode.commands.executeCommand(
						"commandCentral.openFileDiff",
						node,
					);
					return;
				}

				await vscode.commands.executeCommand(
					"vscode.open",
					vscode.Uri.file(absolutePath),
				);
			},
		),
		// Open File Diff — opens a focused diff for a specific changed file
		vscode.commands.registerCommand(
			"commandCentral.openFileDiff",
			async (node?: {
				projectDir?: string;
				projectName?: string;
				filePath?: string;
				taskId?: string;
				diffMode?: AgentDiffMode;
				startCommit?: string;
				endCommit?: string;
				additions?: number;
				deletions?: number;
			}) => {
				if (!node?.projectDir || !node.filePath) {
					vscode.window.showWarningMessage("No file change selected.");
					return;
				}

				const projectDir = node.projectDir;
				const absolutePath = path.isAbsolute(node.filePath)
					? node.filePath
					: path.join(projectDir, node.filePath);
				const relativePath = path
					.relative(projectDir, absolutePath)
					.split(path.sep)
					.join("/");
				const projectName =
					node.projectName || path.basename(projectDir) || projectDir;

				// Routing intent must be explicit: only diffMode selects the
				// working-tree path. Payloads without it (including legacy
				// taskStatus-bearing ones) get the bounded-commit guard.
				const isWorkingTreeDiff = node.diffMode === "workingTree";
				const beforeRef = isWorkingTreeDiff
					? (node.startCommit ?? "HEAD")
					: (node.startCommit ?? "HEAD~1");
				const afterRef = isWorkingTreeDiff ? "Working Tree" : node.endCommit;

				if (!isWorkingTreeDiff && !afterRef) {
					vscode.window.showInformationMessage(
						"No bounded diff is available for this task.",
					);
					return;
				}

				try {
					const fs = await import("node:fs");

					const openFileIfPresent = async (): Promise<boolean> => {
						if (!fs.existsSync(absolutePath)) return false;
						await vscode.commands.executeCommand(
							"vscode.open",
							vscode.Uri.file(absolutePath),
						);
						return true;
					};

					if (
						typeof node.additions === "number" &&
						typeof node.deletions === "number" &&
						(node.additions < 0 || node.deletions < 0)
					) {
						const opened = await openFileIfPresent();
						vscode.window.showInformationMessage(
							opened
								? "Binary file detected — opened file directly."
								: "Binary file detected — no text diff is available.",
						);
						return;
					}

					const beforeFile = await readFileAtRef(
						projectDir,
						beforeRef,
						relativePath,
					);
					const afterFile: GitFileReadResult = isWorkingTreeDiff
						? await readWorkingTreeFile(absolutePath)
						: afterRef
							? await readFileAtRef(projectDir, afterRef, relativePath)
							: { kind: "missing" };

					if (beforeFile.kind === "binary" || afterFile.kind === "binary") {
						const opened = await openFileIfPresent();
						vscode.window.showInformationMessage(
							opened
								? "Binary content detected — opened file directly."
								: "Binary content detected — no text diff is available.",
						);
						return;
					}

					if (beforeFile.kind === "missing" && afterFile.kind === "missing") {
						vscode.window.showInformationMessage(
							"File does not exist in the selected revisions.",
						);
						return;
					}

					const beforeUri = buildDiffContentUri({
						projectDir,
						ref: beforeFile.kind === "missing" ? "empty" : beforeRef,
						relativePath,
						taskId: node.taskId ?? "unknown",
					});
					const afterUri = buildDiffContentUri({
						projectDir,
						ref:
							afterFile.kind === "missing"
								? "empty"
								: isWorkingTreeDiff
									? "working-tree"
									: (afterRef ?? "HEAD"),
						relativePath,
						taskId: node.taskId ?? "unknown",
					});

					const changeHint =
						beforeFile.kind === "missing" && afterFile.kind === "text"
							? " · added"
							: beforeFile.kind === "text" && afterFile.kind === "missing"
								? " · deleted"
								: "";

					await vscode.commands.executeCommand(
						"vscode.diff",
						beforeUri,
						afterUri,
						`${path.basename(relativePath)} (${beforeRef} ↔ ${afterRef}${changeHint}) — ${projectName}`,
					);
				} catch (err) {
					vscode.window.showErrorMessage(
						`Failed to open file diff: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			},
		),
	];
}
