import type { AgentTask } from "../providers/agent-status-tree-provider.js";

export interface AgentCounts {
	working: number;
	attention: number;
	limbo: number;
	done: number;
	total: number;
}

export interface FormatCountSummaryOptions {
	includeAttention?: boolean;
}

export interface FormatAgentStatusHeaderSummaryOptions {
	includeLiveWhenZero?: boolean;
}

export interface CountAgentStatusesOptions {
	/**
	 * Task IDs the user has manually marked reviewed (ReviewTracker sidecar).
	 * A completed task whose review_status is still pending/changes_requested
	 * counts as `done` once reviewed — mirrors the tree provider's grouping so
	 * the badge and the Attention bucket stay in sync.
	 */
	reviewedTaskIds?: ReadonlySet<string>;
}

export function countAgentStatuses(
	tasks: AgentTask[],
	options: CountAgentStatusesOptions = {},
): AgentCounts {
	const counts: AgentCounts = {
		working: 0,
		attention: 0,
		limbo: 0,
		done: 0,
		total: 0,
	};

	for (const task of tasks) {
		counts.total++;
		switch (task.status) {
			case "running":
				counts.working++;
				break;
			case "completed":
				if (
					(task.review_status === "pending" ||
						task.review_status === "changes_requested") &&
					!options.reviewedTaskIds?.has(task.id)
				) {
					counts.attention++;
				} else {
					counts.done++;
				}
				break;
			case "completed_dirty":
			case "completed_stale":
			// `paused` is Needs Review (limbo) — same bucket as getNodeStatusGroup
			// and sectionFromSignals. Without this case the defaultless switch
			// drops it into no bucket, so a paused-only scope renders the green
			// "No agents" all-clear in the status bar/dashboard summary.
			case "paused":
				counts.limbo++;
				break;
			case "failed":
			case "killed":
			case "stopped":
			case "contract_failure":
				counts.attention++;
				break;
		}
	}

	return counts;
}

export function getAttentionCount(counts: AgentCounts): number {
	return counts.attention;
}

export function formatCountSummary(
	counts: AgentCounts,
	options: FormatCountSummaryOptions = {},
): string {
	const parts: string[] = [];
	const attention = getAttentionCount(counts);
	const doneTotal = counts.done + counts.limbo;
	if (counts.working > 0) parts.push(`${counts.working} working`);
	if (options.includeAttention && attention > 0) {
		parts.push(`${attention} attention`);
	}
	if (doneTotal > 0) parts.push(`${doneTotal} done`);
	return parts.join(" · ") || "No agents";
}

export function formatAgentStatusHeaderSummary(
	counts: AgentCounts,
	options: FormatAgentStatusHeaderSummaryOptions = {},
): string {
	const parts: string[] = [];
	if (counts.working > 0 || options.includeLiveWhenZero) {
		parts.push(`Live ${counts.working}`);
	}
	if (counts.attention > 0) parts.push(`Action ${counts.attention}`);
	if (counts.limbo > 0) parts.push(`Review ${counts.limbo}`);
	if (counts.done > 0) parts.push(`History ${counts.done}`);
	return parts.join(" · ") || "No agents";
}
