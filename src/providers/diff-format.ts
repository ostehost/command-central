/**
 * Pure diff / file-change parsing and presentation helpers.
 *
 * These functions parse `git diff` output (numstat + name-status), build the
 * diff argument vectors, derive file-change statuses, and format the per-file /
 * notification summaries and file-change descriptions shown in the tree. They
 * were extracted from AgentStatusTreeProvider, where they were stateless
 * private methods. The git execution itself stays in the provider; only the
 * pure parsing/formatting moves here.
 */

import type {
	FileChangeNode,
	FileChangeStatus,
	PerFileDiff,
} from "./agent-status-tree-nodes.js";

export function formatNotificationDiffSummary(summary: string | null): string {
	if (!summary) return "no changes detected";
	const filesMatch = summary.match(/(\d+)\s+files?/i);
	const additionsMatch = summary.match(/\+(\d+)/);
	const deletionsMatch = summary.match(/-(\d+)/);
	if (!filesMatch || !additionsMatch || !deletionsMatch) {
		return summary;
	}
	const fileCount = Number.parseInt(filesMatch[1] ?? "0", 10);
	const fileLabel = fileCount === 1 ? "1 file" : `${fileCount} files`;
	return `${fileLabel} · +${additionsMatch[1]} -${deletionsMatch[1]}`;
}

export function formatPerFileDiffSummary(
	fileDiffs: PerFileDiff[],
): string | null {
	if (fileDiffs.length === 0) return null;

	const additions = fileDiffs.reduce(
		(total, diff) => total + Math.max(diff.additions, 0),
		0,
	);
	const deletions = fileDiffs.reduce(
		(total, diff) => total + Math.max(diff.deletions, 0),
		0,
	);
	const fileLabel =
		fileDiffs.length === 1 ? "1 file" : `${fileDiffs.length} files`;
	return `${fileLabel} · +${additions} / -${deletions}`;
}

export function parsePerFileStatusesFromNameStatus(
	output: string,
): Map<string, FileChangeStatus> {
	const statuses = new Map<string, FileChangeStatus>();
	if (!output.trim()) return statuses;

	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const [statusRaw, ...fileParts] = line.split("\t");
		if (!statusRaw || fileParts.length === 0) continue;
		const filePath = fileParts[fileParts.length - 1]?.trim();
		if (!filePath) continue;

		const normalizedStatus = statusRaw.startsWith("A")
			? "A"
			: statusRaw.startsWith("D")
				? "D"
				: "M";
		statuses.set(filePath, normalizedStatus);
	}

	return statuses;
}

export function parsePerFileDiffsFromNumstat(output: string): PerFileDiff[] {
	if (!output.trim()) return [];

	const diffs: PerFileDiff[] = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const [additionsRaw, deletionsRaw, ...fileParts] = line.split("\t");
		if (!additionsRaw || !deletionsRaw || fileParts.length === 0) continue;
		const filePath = fileParts.join("\t").trim();
		if (!filePath) continue;

		const isBinary = additionsRaw === "-" || deletionsRaw === "-";
		const additions = isBinary ? -1 : Number.parseInt(additionsRaw, 10);
		const deletions = isBinary ? -1 : Number.parseInt(deletionsRaw, 10);

		if (!isBinary && (Number.isNaN(additions) || Number.isNaN(deletions))) {
			continue;
		}

		diffs.push({ filePath, additions, deletions });
	}

	return diffs;
}

export function buildGitDiffArgs(
	projectDir: string,
	diffFlag: "--name-status" | "--numstat",
	startCommit?: string,
	endCommit?: string,
): string[] {
	if (!startCommit) {
		return ["-C", projectDir, "diff", diffFlag];
	}

	const resolvedEnd = endCommit ?? "HEAD";
	return ["-C", projectDir, "diff", diffFlag, `${startCommit}..${resolvedEnd}`];
}

export function deriveFallbackFileChangeStatus(
	diff: PerFileDiff,
): FileChangeStatus {
	if (diff.additions === 0 && diff.deletions > 0) return "D";
	if (diff.deletions === 0 && diff.additions > 0) return "A";
	return "M";
}

export function extractCommitHash(value: string): string | undefined {
	const firstToken = value.trim().split(/\s+/)[0];
	return firstToken && /^[0-9a-f]{7,40}$/i.test(firstToken)
		? firstToken
		: undefined;
}

export function shortenCommitHash(value: string): string {
	return value.slice(0, 7);
}

export function getFileChangePathParts(filePath: string): {
	filename: string;
	directory?: string;
} {
	const normalized = filePath.replace(/\\/g, "/");
	const segments = normalized.split("/").filter(Boolean);
	const filename = segments.pop() ?? normalized;
	return {
		filename,
		...(segments.length > 0 ? { directory: segments.join("/") } : {}),
	};
}

export function formatFileChangeDescription(node: FileChangeNode): string {
	const { directory } = getFileChangePathParts(node.filePath);
	const stats =
		node.additions < 0 || node.deletions < 0
			? `${node.status} binary`
			: `${node.status} +${node.additions} -${node.deletions}`;
	return directory ? `${directory} · ${stats}` : stats;
}
