import type { AgentTask } from "../providers/agent-status-tree-provider.js";

export interface AgentCounts {
	running: number;
	completed: number;
	failed: number;
	stopped: number;
	total: number;
}

export interface FormatCountSummaryOptions {
	includeAttention?: boolean;
}

export function countAgentStatuses(tasks: AgentTask[]): AgentCounts {
	const counts: AgentCounts = {
		running: 0,
		completed: 0,
		failed: 0,
		stopped: 0,
		total: 0,
	};

	for (const task of tasks) {
		counts.total++;
		switch (task.status) {
			case "running":
				counts.running++;
				break;
			case "completed":
			case "completed_dirty":
			case "completed_stale":
				counts.completed++;
				break;
			case "failed":
			case "killed":
			case "contract_failure":
				counts.failed++;
				break;
			case "stopped":
				counts.stopped++;
				break;
		}
	}

	return counts;
}

export function getAttentionCount(counts: AgentCounts): number {
	return counts.failed + counts.stopped;
}

export function formatCountSummary(
	counts: AgentCounts,
	options: FormatCountSummaryOptions = {},
): string {
	const parts: string[] = [];
	const attention = getAttentionCount(counts);
	if (counts.running > 0) parts.push(`${counts.running} running`);
	if (options.includeAttention && attention > 0) {
		parts.push(`${attention} attention`);
	}
	if (counts.completed > 0) parts.push(`${counts.completed} completed`);
	if (counts.failed > 0) parts.push(`${counts.failed} failed`);
	if (counts.stopped > 0) parts.push(`${counts.stopped} stopped`);
	return parts.join(" · ") || "No agents";
}
