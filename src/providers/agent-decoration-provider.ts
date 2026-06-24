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
		const scheduledTs = Date.now();
		this.recentChanges.set(taskId, scheduledTs);
		const uri = vscode.Uri.parse(`agent-task:${taskId}`);
		this._onDidChangeFileDecorations.fire(uri);

		// Schedule auto-clear after TTL. Guard against a re-mark within the TTL:
		// only clear if this is still the latest scheduled change for the task,
		// otherwise a stale timer would prematurely clear the newer decoration.
		setTimeout(() => {
			if (this.recentChanges.get(taskId) === scheduledTs) {
				this.recentChanges.delete(taskId);
				this._onDidChangeFileDecorations.fire(
					vscode.Uri.parse(`agent-task:${taskId}`),
				);
			}
		}, CHANGE_TTL_MS);
	}

	/** Mark an agent as just completed/failed — shows a glow badge for 10 seconds */
	markCompleted(taskId: string, status: "completed" | "failed"): void {
		const scheduledTs = Date.now();
		this.recentCompletions.set(taskId, { timestamp: scheduledTs, status });
		const uri = vscode.Uri.parse(`agent-task:${taskId}`);
		this._onDidChangeFileDecorations.fire(uri);

		// Guard against a re-mark within the TTL: only clear if this is still the
		// latest scheduled completion for the task, otherwise a stale timer would
		// prematurely clear the newer completion decoration.
		setTimeout(() => {
			if (this.recentCompletions.get(taskId)?.timestamp === scheduledTs) {
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
					completion.status === "completed" ? "Just completed" : "Just failed";
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
