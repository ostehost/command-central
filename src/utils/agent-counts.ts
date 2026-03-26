import type { AgentTask } from "../providers/agent-status-tree-provider.js";

export interface AgentCounts {
	working: number;
	attention: number;
	done: number;
	total: number;
}

export interface FormatCountSummaryOptions {
	includeAttention?: boolean;
}

export function countAgentStatuses(tasks: AgentTask[]): AgentCounts {
	const counts: AgentCounts = {
		working: 0,
		attention: 0,
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
			case "completed_dirty":
			case "completed_stale":
				counts.done++;
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
	if (counts.working > 0) parts.push(`${counts.working} working`);
	if (options.includeAttention && attention > 0) {
		parts.push(`${attention} attention`);
	}
	if (counts.done > 0) parts.push(`${counts.done} done`);
	return parts.join(" · ") || "No agents";
}
