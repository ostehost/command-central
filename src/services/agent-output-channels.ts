/**
 * AgentOutputChannels — streams tmux pane content to VS Code OutputChannels
 *
 * Creates one OutputChannel per agent task, polling tmux for new output lines.
 */

import { execFileSync } from "node:child_process";
import * as vscode from "vscode";
import { isValidSessionId } from "../providers/agent-status-tree-provider.js";

export class AgentOutputChannels implements vscode.Disposable {
	private channels = new Map<string, vscode.OutputChannel>();
	private timers = new Map<string, NodeJS.Timeout>();
	private lastLineCount = new Map<string, number>();

	show(taskId: string, sessionId: string): void {
		if (!isValidSessionId(sessionId)) return;

		let channel = this.channels.get(taskId);
		if (!channel) {
			channel = vscode.window.createOutputChannel(`Agent: ${taskId}`);
			this.channels.set(taskId, channel);
		}
		channel.show(true); // preserveFocus
		this.startStreaming(taskId, sessionId);
	}

	private startStreaming(taskId: string, sessionId: string): void {
		if (this.timers.has(taskId)) return;

		const timer = setInterval(() => {
			try {
				const output = execFileSync(
					"tmux",
					["capture-pane", "-t", sessionId, "-p"],
					{ encoding: "utf-8", timeout: 2000 },
				);
				const lines = output.split("\n");
				const lastCount = this.lastLineCount.get(taskId) ?? 0;
				if (lines.length > lastCount) {
					const newLines = lines.slice(lastCount);
					const channel = this.channels.get(taskId);
					if (channel) channel.append(newLines.join("\n"));
					this.lastLineCount.set(taskId, lines.length);
				}
			} catch {
				this.stopStreaming(taskId);
			}
		}, 2000);
		this.timers.set(taskId, timer);
	}

	stopStreaming(taskId: string): void {
		const timer = this.timers.get(taskId);
		if (timer) {
			clearInterval(timer);
			this.timers.delete(taskId);
		}
		this.lastLineCount.delete(taskId);
	}

	getChannel(taskId: string): vscode.OutputChannel | undefined {
		return this.channels.get(taskId);
	}

	isStreaming(taskId: string): boolean {
		return this.timers.has(taskId);
	}

	dispose(): void {
		for (const timer of this.timers.values()) clearInterval(timer);
		for (const channel of this.channels.values()) channel.dispose();
		this.timers.clear();
		this.channels.clear();
		this.lastLineCount.clear();
	}
}
