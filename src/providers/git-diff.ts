/**
 * Stateless git-diff execution for the agent-status tree.
 *
 * These functions shell out to `git diff` to resolve a task's commit boundary
 * and compute per-file / summary diff stats. They were extracted from
 * AgentStatusTreeProvider, where they were stateless private methods (only a
 * static timeout, never instance state). The pure parsing/formatting lives in
 * diff-format.ts; this module owns the IO. The diff-summary *cache* stays on the
 * provider, which calls computeDiffSummaryAsync as its compute function.
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { PerFileDiff } from "./agent-status-tree-nodes.js";
import type { AgentTask } from "./agent-status-tree-provider.js";
import {
	buildGitDiffArgs,
	formatPerFileDiffSummary,
	parsePerFileDiffsFromNumstat,
} from "./diff-format.js";

/** Hard timeout for any single `git diff`/`git log` invocation. */
export const GIT_DIFF_TIMEOUT_MS = 1_500;

export function getTaskDiffStartCommit(t: AgentTask): string | undefined {
	if (t.status === "running") return undefined;

	if (t.start_commit && t.start_commit !== "unknown") {
		return t.start_commit;
	}
	if (t.start_sha && t.start_sha !== "unknown") {
		return t.start_sha;
	}

	if (t.started_at) {
		try {
			const commitHash = execFileSync(
				"git",
				[
					"-C",
					t.project_dir,
					"log",
					`--before=${t.started_at}`,
					"-1",
					"--format=%H",
				],
				{
					encoding: "utf-8",
					timeout: GIT_DIFF_TIMEOUT_MS,
				},
			).trim();
			if (commitHash) return commitHash;
		} catch {
			// Fallback to HEAD~1 below
		}
	}

	return "HEAD~1";
}

export function getTaskDiffEndCommit(t: AgentTask): string | undefined {
	if (t.end_commit && t.end_commit !== "unknown") {
		return t.end_commit;
	}
	return undefined;
}

export function runGitDiffOutput(
	projectDir: string,
	diffFlag: "--name-status" | "--numstat",
	startCommit?: string,
	endCommit?: string,
): string {
	if (startCommit && !endCommit) return "";

	const run = (args: string[]): string =>
		execFileSync("git", args, {
			encoding: "utf-8",
			timeout: GIT_DIFF_TIMEOUT_MS,
		}).trim();

	try {
		let output = "";
		try {
			output = run(
				buildGitDiffArgs(projectDir, diffFlag, startCommit, endCommit),
			);
		} catch {
			if (!startCommit) return "";
			output = run(["-C", projectDir, "diff", diffFlag, "HEAD~1..HEAD"]);
		}

		if (!output && startCommit) {
			output = run(["-C", projectDir, "diff", diffFlag, "HEAD~1..HEAD"]);
		}

		return output;
	} catch {
		return "";
	}
}

export function getPerFileNumstatDiffs(
	projectDir: string,
	startCommit?: string,
	endCommit?: string,
): PerFileDiff[] {
	const output = runGitDiffOutput(
		projectDir,
		"--numstat",
		startCommit,
		endCommit,
	);
	if (!output) return [];
	return parsePerFileDiffsFromNumstat(output);
}

export async function computeDiffSummaryAsync(
	projectDir: string,
	task: AgentTask,
): Promise<string | null> {
	const execFileAsync = promisify(execFile);
	const runNumstat = async (args: string[]): Promise<string> => {
		const { stdout } = await execFileAsync("git", args, {
			encoding: "utf-8",
			timeout: GIT_DIFF_TIMEOUT_MS,
		});
		return stdout.trim();
	};

	try {
		const startCommit = getTaskDiffStartCommit(task);
		const endCommit = getTaskDiffEndCommit(task);

		// Non-running task with no valid end boundary — no diff available.
		if (startCommit && !endCommit) return null;

		const resolvedEnd = endCommit ?? "HEAD";
		const primaryArgs = startCommit
			? [
					"-C",
					projectDir,
					"diff",
					"--numstat",
					`${startCommit}..${resolvedEnd}`,
				]
			: ["-C", projectDir, "diff", "--numstat"];

		let output = "";
		try {
			output = await runNumstat(primaryArgs);
		} catch {
			if (!startCommit) return null;
			output = await runNumstat([
				"-C",
				projectDir,
				"diff",
				"--numstat",
				"HEAD~1..HEAD",
			]);
		}

		if (!output && startCommit) {
			output = await runNumstat([
				"-C",
				projectDir,
				"diff",
				"--numstat",
				"HEAD~1..HEAD",
			]);
		}

		return formatPerFileDiffSummary(parsePerFileDiffsFromNumstat(output));
	} catch {
		return null;
	}
}
