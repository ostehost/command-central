/**
 * SessionHistoryRecoveryPanel — read-only webview surfacing OpenClaw
 * session-history archive/recovery risk.
 *
 * Models the established AgentDashboardPanel pattern: a webview opened by a
 * command, rendering data sourced from a read-only service. It shows the count
 * and age of archived (`.jsonl.deleted.*`) transcripts and orphan session
 * files, the retention window, how many transcripts are past that window
 * (prune risk), backup-first manual-recovery guidance, and a link to the
 * recovery runbook.
 *
 * Hard guarantee: this surface is STRICTLY READ-ONLY. It renders a report and
 * opens an external runbook link. It never mutates session files or gateway
 * config — recovery itself stays a deliberate, operator-driven manual step.
 */

import * as vscode from "vscode";
import type {
	SessionHistoryRecoveryReport,
	SessionHistoryRecoveryService,
} from "../services/session-history-recovery-service.js";

/** External runbook describing the backup-first manual recovery procedure. */
export const SESSION_HISTORY_RECOVERY_RUNBOOK_URL =
	"https://dashboard.partnerai.dev/runbooks/openclaw-session-history-recovery";

const MAX_ROWS = 20;

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value.toFixed(1)} ${units[unitIndex] ?? "GB"}`;
}

function formatAgeDays(ageDays: number | null): string {
	if (ageDays === null) return "—";
	if (ageDays === 0) return "today";
	return ageDays === 1 ? "1 day" : `${ageDays} days`;
}

export class SessionHistoryRecoveryPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private disposables: vscode.Disposable[] = [];

	get isVisible(): boolean {
		return this.panel !== undefined;
	}

	show(report: SessionHistoryRecoveryReport): void {
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				"sessionHistoryRecovery",
				"Session History Recovery Risk",
				vscode.ViewColumn.One,
				{ enableScripts: false, retainContextWhenHidden: true },
			);
			this.panel.onDidDispose(
				() => {
					this.panel = undefined;
				},
				null,
				this.disposables,
			);
		}
		this.panel.webview.html = this.getHtml(report);
		this.panel.reveal();
	}

	update(report: SessionHistoryRecoveryReport): void {
		if (this.panel) {
			this.panel.webview.html = this.getHtml(report);
		}
	}

	getHtml(report: SessionHistoryRecoveryReport): string {
		const archivedCount = report.archivedTranscripts.length;
		const banner = report.atRisk
			? `<p class="risk">⚠️ ${report.pastRetentionCount} archived transcript${report.pastRetentionCount === 1 ? "" : "s"} ${report.pastRetentionCount === 1 ? "is" : "are"} past the ${report.retentionDays}-day retention window and may be pruned. Back up before recovering.</p>`
			: archivedCount > 0
				? `<p class="ok">All ${archivedCount} archived transcript${archivedCount === 1 ? "" : "s"} are within the ${report.retentionDays}-day retention window.</p>`
				: `<p class="ok">No archived session transcripts found.</p>`;

		return `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
h1 { font-size: 20px; margin-bottom: 12px; }
h2 { font-size: 16px; margin: 18px 0 8px; }
.summary { display: flex; gap: 16px; margin-bottom: 16px; padding: 12px; background: var(--vscode-sideBar-background); border-radius: 6px; }
.summary-item { text-align: center; }
.summary-count { font-size: 24px; font-weight: bold; }
.summary-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
.risk { margin: 8px 0 14px; padding: 8px 10px; border-left: 3px solid var(--vscode-charts-red); background: var(--vscode-editorWidget-background); font-size: 13px; }
.ok { margin: 8px 0 14px; padding: 8px 10px; border-left: 3px solid var(--vscode-charts-green); background: var(--vscode-editorWidget-background); font-size: 13px; color: var(--vscode-descriptionForeground); }
.guidance { margin: 8px 0 14px; padding: 8px 10px; border-left: 3px solid var(--vscode-charts-yellow); background: var(--vscode-editorWidget-background); font-size: 12px; color: var(--vscode-descriptionForeground); }
.guidance ol { margin: 6px 0 0; padding-left: 18px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
th { color: var(--vscode-descriptionForeground); font-weight: normal; }
td.past { color: var(--vscode-charts-red); }
.path { font-family: var(--vscode-editor-font-family); }
.empty { color: var(--vscode-descriptionForeground); font-style: italic; }
a { color: var(--vscode-textLink-foreground); }
</style>
</head>
<body>
<h1>Session History Recovery Risk</h1>
${banner}
<div class="summary">
	<div class="summary-item"><div class="summary-count">${archivedCount}</div><div class="summary-label">Archived transcripts</div></div>
	<div class="summary-item"><div class="summary-count" style="color:var(--vscode-charts-red)">${report.pastRetentionCount}</div><div class="summary-label">Past retention</div></div>
	<div class="summary-item"><div class="summary-count">${report.orphanSessionFiles.length}</div><div class="summary-label">Orphan files</div></div>
	<div class="summary-item"><div class="summary-count">${formatBytes(report.totalArchivedBytes)}</div><div class="summary-label">Total size</div></div>
	<div class="summary-item"><div class="summary-count">${formatAgeDays(report.oldestAgeDays)}</div><div class="summary-label">Oldest</div></div>
</div>
<div class="guidance">
	Command Central never deletes, restores, or rewrites session files — recovery is a deliberate manual step. Before recovering:
	<ol>
		<li>Copy the archived <code>.jsonl.deleted.*</code> file(s) to a safe location first (back up before touching anything).</li>
		<li>Verify the backup, then restore manually outside Command Central.</li>
		<li>Follow the <a href="${escapeHtml(SESSION_HISTORY_RECOVERY_RUNBOOK_URL)}">session-history recovery runbook</a> for the full procedure.</li>
	</ol>
</div>
<h2>Archived transcripts (retention window: ${report.retentionDays} days)</h2>
${this.renderArchivedTable(report)}
<h2>Orphan session files</h2>
${this.renderOrphanTable(report)}
</body>
</html>`;
	}

	private renderArchivedTable(report: SessionHistoryRecoveryReport): string {
		if (report.archivedTranscripts.length === 0) {
			return '<p class="empty">None found.</p>';
		}
		const rows = report.archivedTranscripts
			.slice(0, MAX_ROWS)
			.map((entry) => {
				const cellClass = entry.pastRetention ? ' class="past"' : "";
				return `<tr>
	<td class="path">${escapeHtml(entry.filePath)}</td>
	<td${cellClass}>${formatAgeDays(entry.ageDays)}</td>
	<td>${formatBytes(entry.sizeBytes)}</td>
	<td${cellClass}>${entry.pastRetention ? "prune risk" : "retained"}</td>
</tr>`;
			})
			.join("");
		const overflow =
			report.archivedTranscripts.length > MAX_ROWS
				? `<p class="empty">…and ${report.archivedTranscripts.length - MAX_ROWS} more.</p>`
				: "";
		return `<table>
<thead><tr><th>File</th><th>Age</th><th>Size</th><th>Status</th></tr></thead>
<tbody>${rows}</tbody>
</table>${overflow}`;
	}

	private renderOrphanTable(report: SessionHistoryRecoveryReport): string {
		if (report.orphanSessionFiles.length === 0) {
			return '<p class="empty">None found.</p>';
		}
		const rows = report.orphanSessionFiles
			.slice(0, MAX_ROWS)
			.map(
				(entry) =>
					`<tr><td class="path">${escapeHtml(entry.filePath)}</td></tr>`,
			)
			.join("");
		return `<table>
<thead><tr><th>Trajectory without a live transcript</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
	}

	dispose(): void {
		if (this.panel) {
			this.panel.dispose();
			this.panel = undefined;
		}
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
	}
}

/** Command id that opens the read-only session-history recovery-risk panel. */
export const OPEN_SESSION_HISTORY_RECOVERY_COMMAND =
	"commandCentral.openSessionHistoryRecoveryRisk";

export interface SessionHistoryRecoveryCommandDeps {
	panel: Pick<SessionHistoryRecoveryPanel, "show">;
	service: Pick<SessionHistoryRecoveryService, "scan">;
}

/**
 * Register the command that opens the recovery-risk panel. Mirrors the other
 * `register*Commands` activation helpers: returns one disposable per command so
 * the caller owns their lifecycle. Wired from `extension.ts` during activation.
 */
export function registerSessionHistoryRecoveryCommands(
	deps: SessionHistoryRecoveryCommandDeps,
): vscode.Disposable[] {
	const { panel, service } = deps;
	return [
		vscode.commands.registerCommand(
			OPEN_SESSION_HISTORY_RECOVERY_COMMAND,
			() => {
				panel.show(service.scan());
			},
		),
	];
}
