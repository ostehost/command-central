/**
 * CronTreeProvider — TreeDataProvider for the Cron Jobs sidebar view.
 *
 * Shows a summary node at top, job nodes with status icons, and
 * expandable detail children (Schedule, Model, Agent, Delivery, Last, Next).
 *
 * Pattern follows AgentStatusTreeProvider but much simpler (~400 lines).
 */

import * as vscode from "vscode";
import type { CronService } from "../services/cron-service.js";
import type {
	CronDetailNode,
	CronJob,
	CronJobNode,
	CronSummaryNode,
	CronTreeElement,
} from "../types/cron-types.js";

const REFRESH_INTERVAL_MS = 30_000;

export class CronTreeProvider
	implements vscode.TreeDataProvider<CronTreeElement>, vscode.Disposable
{
	private _onDidChangeTreeData = new vscode.EventEmitter<
		CronTreeElement | undefined
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private readonly service: CronService;

	constructor(service: CronService) {
		this.service = service;
		this.startAutoRefresh();
	}

	refresh(): void {
		this.service.reload();
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: CronTreeElement): vscode.TreeItem {
		switch (element.kind) {
			case "summary":
				return this.buildSummaryItem(element);
			case "job":
				return this.buildJobItem(element);
			case "detail":
				return this.buildDetailItem(element);
		}
	}

	getChildren(element?: CronTreeElement): CronTreeElement[] {
		if (!element) {
			return this.getRootChildren();
		}
		if (element.kind === "summary") {
			return this.getJobNodes();
		}
		if (element.kind === "job") {
			return this.getDetailNodes(element.job);
		}
		return [];
	}

	getParent(element: CronTreeElement): CronTreeElement | undefined {
		if (element.kind === "detail") {
			const job = this.service.getJobs().find((j) => j.id === element.jobId);
			if (job) return { kind: "job", job };
		}
		if (element.kind === "job") {
			return this.buildSummaryElement();
		}
		return undefined;
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		this._onDidChangeTreeData.dispose();
	}

	// ── Root & Children ─────────────────────────────────────────────────

	private getRootChildren(): CronTreeElement[] {
		if (!this.service.isInstalled) {
			return [this.buildNotInstalledNode()];
		}
		const jobs = this.service.getJobs();
		if (jobs.length === 0) {
			return [this.buildEmptyNode()];
		}
		return [this.buildSummaryElement()];
	}

	private getJobNodes(): CronTreeElement[] {
		const config = vscode.workspace.getConfiguration("commandCentral.cron");
		const showDisabled = config.get<boolean>("showDisabled", true);
		return this.service
			.getJobs()
			.filter((j) => showDisabled || j.enabled)
			.map((job): CronJobNode => ({ kind: "job", job }));
	}

	private getDetailNodes(job: CronJob): CronDetailNode[] {
		const details: CronDetailNode[] = [];
		details.push({
			kind: "detail",
			jobId: job.id,
			label: "Schedule",
			value: this.formatSchedule(job.schedule),
		});

		const model = this.resolveModel(job);
		details.push({
			kind: "detail",
			jobId: job.id,
			label: "Model",
			value: model,
		});

		if (job.agentId) {
			details.push({
				kind: "detail",
				jobId: job.id,
				label: "Agent",
				value: `${job.agentId} (${job.sessionTarget})`,
			});
		}

		if (job.delivery && job.delivery.mode !== "none") {
			details.push({
				kind: "detail",
				jobId: job.id,
				label: "Delivery",
				value: this.formatDelivery(job),
			});
		}

		if (job.state.lastRunAtMs) {
			const ago = formatRelativeTime(job.state.lastRunAtMs);
			const status = job.state.lastStatus ?? "unknown";
			const duration = job.state.lastDurationMs
				? `, ${Math.round(job.state.lastDurationMs / 1000)}s`
				: "";
			const errorInfo = this.formatLastError(job);
			details.push({
				kind: "detail",
				jobId: job.id,
				label: "Last",
				value: `${status} (${ago}${duration})${errorInfo}`,
			});
		}

		if (job.state.nextRunAtMs) {
			details.push({
				kind: "detail",
				jobId: job.id,
				label: "Next",
				value: formatRelativeTime(job.state.nextRunAtMs),
			});
		}

		return details;
	}

	// ── Tree Item Builders ──────────────────────────────────────────────

	private buildSummaryItem(node: CronSummaryNode): vscode.TreeItem {
		const label = `Cron Jobs (${node.activeCount} active, ${node.disabledCount} disabled)`;
		const item = new vscode.TreeItem(
			label,
			vscode.TreeItemCollapsibleState.Expanded,
		);
		item.iconPath = new vscode.ThemeIcon("calendar");
		item.contextValue = "cronSummary";
		return item;
	}

	private buildJobItem(node: CronJobNode): vscode.TreeItem {
		const { job } = node;
		const item = new vscode.TreeItem(
			this.formatJobLabel(job),
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.iconPath = getJobIcon(job);
		item.description = this.formatJobDescription(job);
		item.contextValue = job.enabled ? "cronJob" : "cronJobDisabled";
		item.tooltip = this.buildJobTooltip(job);
		return item;
	}

	private buildDetailItem(node: CronDetailNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			`${node.label}: ${node.value}`,
			vscode.TreeItemCollapsibleState.None,
		);
		item.contextValue = "cronDetail";
		return item;
	}

	private buildNotInstalledNode(): CronTreeElement {
		return {
			kind: "detail",
			jobId: "",
			label: "OpenClaw not installed",
			value: "Install OpenClaw to manage cron jobs",
		};
	}

	private buildEmptyNode(): CronTreeElement {
		return {
			kind: "detail",
			jobId: "",
			label: "No scheduled jobs",
			value: "Use + to create one",
		};
	}

	// ── Formatting ──────────────────────────────────────────────────────

	private formatJobLabel(job: CronJob): string {
		const suffix = job.enabled ? "" : " [disabled]";
		return `${job.name}${suffix}`;
	}

	private formatJobDescription(job: CronJob): string {
		const schedule = this.formatScheduleHuman(job.schedule);
		if (!job.enabled) return schedule;

		if (job.state.lastRunAtMs) {
			return `${schedule} · ${formatRelativeTime(job.state.lastRunAtMs)}`;
		}
		if (job.state.nextRunAtMs) {
			return `${schedule} · next ${formatRelativeTime(job.state.nextRunAtMs)}`;
		}
		return schedule;
	}

	private formatSchedule(schedule: CronJob["schedule"]): string {
		switch (schedule.kind) {
			case "cron": {
				const tz = schedule.tz ? ` (${schedule.tz})` : "";
				const stagger = schedule.staggerMs
					? ` +${Math.round(schedule.staggerMs / 60000)}m stagger`
					: "";
				return `cron ${schedule.expr}${tz}${stagger}`;
			}
			case "every":
				return `every ${formatDuration(schedule.everyMs)}`;
			case "at":
				return `at ${schedule.at}`;
		}
	}

	private formatScheduleHuman(schedule: CronJob["schedule"]): string {
		switch (schedule.kind) {
			case "cron":
				return this.cronToHuman(schedule.expr);
			case "every":
				return `every ${formatDuration(schedule.everyMs)}`;
			case "at":
				return `at ${schedule.at}`;
		}
	}

	private cronToHuman(expr: string): string {
		const parts = expr.split(" ");
		if (parts.length < 5) return expr;
		const min = parts[0] ?? "0";
		const hour = parts[1] ?? "*";
		const dow = parts[4] ?? "*";
		if (dow !== "*" && hour !== "*") {
			return `${this.dowName(dow)} ${this.formatHour(hour, min)}`;
		}
		if (hour !== "*") {
			return `Daily ${this.formatHour(hour, min)}`;
		}
		return expr;
	}

	private dowName(dow: string): string {
		const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
		const idx = Number.parseInt(dow, 10);
		return names[idx] ?? dow;
	}

	private formatHour(hour: string, min: string): string {
		const h = Number.parseInt(hour, 10);
		const m = Number.parseInt(min, 10);
		const suffix = h >= 12 ? "pm" : "am";
		const display = h > 12 ? h - 12 : h === 0 ? 12 : h;
		return m === 0 ? `${display}${suffix}` : `${display}:${min}${suffix}`;
	}

	private resolveModel(job: CronJob): string {
		if (job.payload.kind === "agentTurn" && job.payload.model) {
			return job.payload.model;
		}
		return "(inherited from agent)";
	}

	private formatDelivery(job: CronJob): string {
		if (!job.delivery) return "none";
		const { mode, channel, to } = job.delivery;
		const target = channel ?? to ?? "";
		return target ? `${mode} → ${target}` : mode;
	}

	private formatLastError(job: CronJob): string {
		const errors = job.state.consecutiveErrors ?? 0;
		if (errors > 0 && job.state.lastError) {
			return ` — ${job.state.lastError} (${errors} consecutive)`;
		}
		if (errors > 0) {
			return ` (${errors} consecutive errors)`;
		}
		return "";
	}

	private buildJobTooltip(job: CronJob): string {
		const lines = [
			`${job.name} (${job.id})`,
			`Status: ${job.enabled ? "enabled" : "disabled"}`,
			`Schedule: ${this.formatSchedule(job.schedule)}`,
		];
		if (job.state.lastStatus) {
			lines.push(`Last run: ${job.state.lastStatus}`);
		}
		if (job.state.lastError) {
			lines.push(`Error: ${job.state.lastError}`);
		}
		return lines.join("\n");
	}

	private buildSummaryElement(): CronSummaryNode {
		const jobs = this.service.getJobs();
		const activeCount = jobs.filter((j) => j.enabled).length;
		const disabledCount = jobs.filter((j) => !j.enabled).length;
		return { kind: "summary", activeCount, disabledCount };
	}

	// ── Auto-refresh ────────────────────────────────────────────────────

	private startAutoRefresh(): void {
		const config = vscode.workspace.getConfiguration("commandCentral.cron");
		const interval = config.get<number>(
			"refreshIntervalMs",
			REFRESH_INTERVAL_MS,
		);
		this.refreshTimer = setInterval(() => {
			this._onDidChangeTreeData.fire(undefined);
		}, interval);
	}
}

// ── Shared utilities ──────────────────────────────────────────────────

const GRAY = new vscode.ThemeColor("disabledForeground");
const RED = new vscode.ThemeColor("testing.iconFailed");
const GREEN = new vscode.ThemeColor("testing.iconPassed");
const YELLOW = new vscode.ThemeColor("editorWarning.foreground");

export function getJobIcon(job: CronJob): vscode.ThemeIcon {
	if (!job.enabled) {
		return new vscode.ThemeIcon("debug-pause", GRAY);
	}
	if (job.state.lastStatus === "error") {
		return new vscode.ThemeIcon("error", RED);
	}
	if ((job.state.consecutiveErrors ?? 0) > 0) {
		return new vscode.ThemeIcon("warning", YELLOW);
	}
	return new vscode.ThemeIcon("check", GREEN);
}

export function formatRelativeTime(timestampMs: number): string {
	const now = Date.now();
	const diffMs = timestampMs - now;
	const absDiffMs = Math.abs(diffMs);
	const isFuture = diffMs > 0;

	if (absDiffMs < 60_000) {
		return isFuture ? "in <1m" : "<1m ago";
	}

	const minutes = Math.floor(absDiffMs / 60_000);
	if (minutes < 60) {
		return isFuture ? `in ${minutes}m` : `${minutes}m ago`;
	}

	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return isFuture ? `in ${hours}h` : `${hours}h ago`;
	}

	const days = Math.floor(hours / 24);
	return isFuture ? `in ${days}d` : `${days}d ago`;
}

export function formatDuration(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${Math.round(ms / 3_600_000)}h`;
}
