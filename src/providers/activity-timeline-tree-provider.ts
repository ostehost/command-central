/**
 * Activity Timeline Tree Provider
 *
 * Displays agent activity events in a chronological tree grouped by time period.
 * Top-level nodes are time groups (Last Hour, Today, Yesterday, etc.),
 * child nodes are individual ActivityEvents with type-appropriate icons.
 */

import * as vscode from "vscode";
import type { ActivityCollector } from "../services/activity-collector.js";
import type {
	ActivityAction,
	ActivityEvent,
	TimelineGroup,
	TimelinePeriod,
} from "../services/activity-event-types.js";

// ── Tree node types ──────────────────────────────────────────────────

export interface TimelineGroupNode {
	type: "timelineGroup";
	group: TimelineGroup;
}

export interface ActivityEventNode {
	type: "activityEvent";
	event: ActivityEvent;
}

export type TimelineNode = TimelineGroupNode | ActivityEventNode;

// ── Period labels and ordering ───────────────────────────────────────

const PERIOD_CONFIG: Record<TimelinePeriod, { label: string; order: number }> =
	{
		lastHour: { label: "Last Hour", order: 0 },
		today: { label: "Today", order: 1 },
		yesterday: { label: "Yesterday", order: 2 },
		last7days: { label: "Last 7 Days", order: 3 },
		older: { label: "Older", order: 4 },
	};

// ── Action icon mapping (ThemeIcon for VS Code native look) ─────────

const ACTION_ICONS: Record<ActivityAction["type"], vscode.ThemeIcon> = {
	commit: new vscode.ThemeIcon("git-commit"),
	"task-completed": new vscode.ThemeIcon("check"),
	"task-failed": new vscode.ThemeIcon("error"),
	"task-started": new vscode.ThemeIcon("play"),
};

// ── Provider ─────────────────────────────────────────────────────────

export class ActivityTimelineTreeProvider
	implements vscode.TreeDataProvider<TimelineNode>, vscode.Disposable
{
	private _onDidChangeTreeData = new vscode.EventEmitter<
		TimelineNode | undefined | null
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private groups: TimelineGroup[] = [];
	private collector: ActivityCollector;
	private workspaceFolders: string[];
	private lookbackDays: number;

	constructor(
		collector: ActivityCollector,
		workspaceFolders: string[],
		lookbackDays = 7,
	) {
		this.collector = collector;
		this.workspaceFolders = workspaceFolders;
		this.lookbackDays = lookbackDays;
	}

	async refresh(): Promise<void> {
		const events = await this.collector.collectEvents(
			this.workspaceFolders,
			this.lookbackDays,
		);
		this.groups = this.groupByPeriod(events);
		this._onDidChangeTreeData.fire(undefined);
	}

	updateWorkspaceFolders(folders: string[]): void {
		this.workspaceFolders = folders;
	}

	getTreeItem(element: TimelineNode): vscode.TreeItem {
		if (element.type === "timelineGroup") {
			return this.createGroupItem(element.group);
		}
		return this.createEventItem(element.event);
	}

	getChildren(element?: TimelineNode): TimelineNode[] {
		if (!element) {
			if (this.groups.length === 0) {
				return [];
			}
			return this.groups.map((group) => ({
				type: "timelineGroup" as const,
				group,
			}));
		}

		if (element.type === "timelineGroup") {
			return element.group.events.map((event) => ({
				type: "activityEvent" as const,
				event,
			}));
		}

		return [];
	}

	getParent(element: TimelineNode): TimelineNode | undefined {
		if (element.type === "activityEvent") {
			const group = this.groups.find((g) =>
				g.events.some((e) => e.id === element.event.id),
			);
			if (group) {
				return { type: "timelineGroup", group };
			}
		}
		return undefined;
	}

	// ── Private helpers ──────────────────────────────────────────────

	private createGroupItem(group: TimelineGroup): vscode.TreeItem {
		const count = group.events.length;
		const label = `${group.label} (${count} event${count !== 1 ? "s" : ""})`;
		const item = new vscode.TreeItem(
			label,
			vscode.TreeItemCollapsibleState.Expanded,
		);
		item.contextValue = "timelineGroup";
		item.iconPath = new vscode.ThemeIcon("calendar");
		return item;
	}

	private createEventItem(event: ActivityEvent): vscode.TreeItem {
		const { label, description } = this.formatEvent(event);
		const item = new vscode.TreeItem(
			label,
			vscode.TreeItemCollapsibleState.None,
		);
		item.description = description;
		item.iconPath = ACTION_ICONS[event.action.type];
		item.contextValue = `activityEvent.${event.action.type}`;
		item.tooltip = this.formatTooltip(event);
		return item;
	}

	private formatEvent(event: ActivityEvent): {
		label: string;
		description: string;
	} {
		const action = event.action;
		const ago = this.formatTimeAgo(event.timestamp);

		switch (action.type) {
			case "commit":
				return {
					label: action.message,
					description: `${event.agent.name} · ${action.filesChanged} file${action.filesChanged !== 1 ? "s" : ""} · ${ago}`,
				};
			case "task-completed":
				return {
					label: `${action.taskId} completed`,
					description: `${event.agent.role ?? "agent"} · ${event.project.name} · ${action.duration}`,
				};
			case "task-failed":
				return {
					label: `${action.taskId} failed`,
					description: `${event.agent.role ?? "agent"} · exit ${action.exitCode} · ${ago}`,
				};
			case "task-started":
				return {
					label: `${action.taskId} started`,
					description: `${event.agent.role ?? "agent"} · ${event.project.name}`,
				};
		}
	}

	private formatTooltip(event: ActivityEvent): vscode.MarkdownString {
		const lines: string[] = [];
		const action = event.action;

		lines.push(`**${action.type}** — ${event.agent.name}`);
		lines.push(`Project: ${event.project.name}`);
		lines.push(`Time: ${event.timestamp.toLocaleString()}`);

		if (action.type === "commit") {
			lines.push(`SHA: \`${action.sha.slice(0, 8)}\``);
			lines.push(
				`Changes: +${action.insertions} −${action.deletions} (${action.filesChanged} files)`,
			);
		} else if (action.type === "task-failed" && action.error) {
			lines.push(`Error: ${action.error}`);
		}

		return new vscode.MarkdownString(lines.join("\n\n"));
	}

	private formatTimeAgo(date: Date): string {
		const diffMs = Date.now() - date.getTime();
		const minutes = Math.floor(diffMs / 60_000);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);

		if (minutes < 1) return "just now";
		if (minutes < 60) return `${minutes}m ago`;
		if (hours < 24) return `${hours}h ago`;
		return `${days}d ago`;
	}

	private groupByPeriod(events: ActivityEvent[]): TimelineGroup[] {
		const now = new Date();
		const buckets = new Map<TimelinePeriod, ActivityEvent[]>();

		for (const event of events) {
			const period = this.classifyPeriod(event.timestamp, now);
			const bucket = buckets.get(period);
			if (bucket) {
				bucket.push(event);
			} else {
				buckets.set(period, [event]);
			}
		}

		const groups: TimelineGroup[] = [];
		for (const [period, periodEvents] of buckets) {
			groups.push({
				period,
				label: PERIOD_CONFIG[period].label,
				events: periodEvents,
			});
		}

		groups.sort(
			(a, b) => PERIOD_CONFIG[a.period].order - PERIOD_CONFIG[b.period].order,
		);

		return groups;
	}

	private classifyPeriod(timestamp: Date, now: Date): TimelinePeriod {
		const diffMs = now.getTime() - timestamp.getTime();
		const oneHour = 60 * 60 * 1000;

		if (diffMs < oneHour) return "lastHour";

		const todayStart = new Date(now);
		todayStart.setHours(0, 0, 0, 0);

		if (timestamp >= todayStart) return "today";

		const yesterdayStart = new Date(todayStart);
		yesterdayStart.setDate(yesterdayStart.getDate() - 1);

		if (timestamp >= yesterdayStart) return "yesterday";

		const weekAgo = new Date(todayStart);
		weekAgo.setDate(weekAgo.getDate() - 6);

		if (timestamp >= weekAgo) return "last7days";

		return "older";
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}
}
