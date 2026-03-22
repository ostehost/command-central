/**
 * AgentDecorationProvider — highlights recently-changed agent tasks in the tree
 *
 * Registers as a FileDecorationProvider using the `agent-task:` URI scheme.
 * Tasks that have recently changed status get a yellow dot badge for 30 seconds.
 */

import * as vscode from "vscode";

const CHANGE_TTL_MS = 30_000;

export class AgentDecorationProvider
	implements vscode.FileDecorationProvider, vscode.Disposable
{
	private _onDidChangeFileDecorations = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[]
	>();
	readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

	private recentChanges = new Map<string, number>();

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

	clearChange(taskId: string): void {
		this.recentChanges.delete(taskId);
		const uri = vscode.Uri.parse(`agent-task:${taskId}`);
		this._onDidChangeFileDecorations.fire(uri);
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== "agent-task") return undefined;
		const taskId = uri.path;
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
