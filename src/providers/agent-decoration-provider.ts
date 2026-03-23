/**
 * AgentDecorationProvider — highlights recently-changed agent tasks in the tree
 *
 * Registers as a FileDecorationProvider using the `agent-task:` URI scheme.
 * Tasks that have recently changed status get a yellow dot badge for 30 seconds.
 */

import * as vscode from "vscode";

const CHANGE_TTL_MS = 30_000;
const COMPLETION_TTL_MS = 10_000;

export class AgentDecorationProvider
	implements vscode.FileDecorationProvider, vscode.Disposable
{
	private _onDidChangeFileDecorations = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[]
	>();
	readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

	private recentChanges = new Map<string, number>();
	private recentCompletions = new Map<
		string,
		{ timestamp: number; status: "completed" | "failed" }
	>();

	markChanged(taskId: string): void {
		this.recentChanges.set(taskId, Date.now());
		const uri = vscode.Uri.parse(`agent-task:${taskId}`);
		this._onDidChangeFileDecorations.fire(uri);

		// Schedule auto-clear after TTL
		setTimeout(() => {
			if (this.recentChanges.has(taskId)) {
				this.recentChanges.delete(taskId);
				this._onDidChangeFileDecorations.fire(
					vscode.Uri.parse(`agent-task:${taskId}`),
				);
			}
		}, CHANGE_TTL_MS);
	}

	/** Mark an agent as just completed/failed — shows a glow badge for 10 seconds */
	markCompleted(taskId: string, status: "completed" | "failed"): void {
		this.recentCompletions.set(taskId, { timestamp: Date.now(), status });
		const uri = vscode.Uri.parse(`agent-task:${taskId}`);
		this._onDidChangeFileDecorations.fire(uri);

		setTimeout(() => {
			if (this.recentCompletions.has(taskId)) {
				this.recentCompletions.delete(taskId);
				this._onDidChangeFileDecorations.fire(
					vscode.Uri.parse(`agent-task:${taskId}`),
				);
			}
		}, COMPLETION_TTL_MS);
	}

	hasCompletion(taskId: string): boolean {
		return this.recentCompletions.has(taskId);
	}

	clearChange(taskId: string): void {
		this.recentChanges.delete(taskId);
		const uri = vscode.Uri.parse(`agent-task:${taskId}`);
		this._onDidChangeFileDecorations.fire(uri);
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== "agent-task") return undefined;
		const taskId = uri.path;

		// Completion glow takes priority over generic change decoration
		const completion = this.recentCompletions.get(taskId);
		if (completion) {
			if (Date.now() - completion.timestamp > COMPLETION_TTL_MS) {
				this.recentCompletions.delete(taskId);
			} else {
				const badge = completion.status === "completed" ? "✅" : "❌";
				const tooltip =
					completion.status === "completed"
						? "Just completed"
						: "Just failed";
				const color =
					completion.status === "completed"
						? new vscode.ThemeColor("charts.green")
						: new vscode.ThemeColor("charts.red");
				return new vscode.FileDecoration(badge, tooltip, color);
			}
		}

		const changedAt = this.recentChanges.get(taskId);
		if (!changedAt) return undefined;

		if (Date.now() - changedAt > CHANGE_TTL_MS) {
			this.recentChanges.delete(taskId);
			return undefined;
		}

		return new vscode.FileDecoration(
			"●",
			"Recently changed",
			new vscode.ThemeColor("charts.yellow"),
		);
	}

	hasChange(taskId: string): boolean {
		return this.recentChanges.has(taskId);
	}

	dispose(): void {
		this._onDidChangeFileDecorations.dispose();
	}
}
