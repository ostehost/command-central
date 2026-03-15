/**
 * Test Count Status Bar Item
 * Displays the current test count in the VS Code status bar.
 */

import * as vscode from "vscode";

export class TestCountStatusBar implements vscode.Disposable {
	private statusBarItem: vscode.StatusBarItem;

	constructor() {
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			100,
		);
		this.statusBarItem.command = "command-central.showTestCount";
		this.statusBarItem.tooltip = "Click to refresh test count";
		this.statusBarItem.text = "CC: ... tests";
		this.statusBarItem.show();
	}

	/**
	 * Update the displayed test count
	 */
	updateCount(count: number): void {
		this.statusBarItem.text = `CC: ${count} tests \u2713`;
	}

	/**
	 * Run `bun test` and parse the test count from output.
	 * Guards against untrusted workspaces and missing workspace folders.
	 */
	async refreshCount(): Promise<number> {
		// BLOCKER: Workspace Trust check — bun test executes arbitrary code
		if (!vscode.workspace.isTrusted) {
			this.statusBarItem.text = "CC: tests (untrusted)";
			vscode.window.showWarningMessage(
				"Command Central: Cannot run tests in an untrusted workspace.",
			);
			return 0;
		}

		// WARNING: Guard against missing workspace folder
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!cwd) {
			this.statusBarItem.text = "CC: no workspace";
			return 0;
		}

		// Show loading indicator while tests run
		this.statusBarItem.text = "$(loading~spin) CC: running tests...";

		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFile);

		try {
			const { stderr } = await execFileAsync("bun", ["test"], {
				cwd,
				timeout: 30000,
			});

			// bun test outputs summary to stderr like: "383 pass"
			const match = stderr.match(/(\d+)\s+pass/);
			const count = match ? Number.parseInt(match[1], 10) : 0;
			this.updateCount(count);
			return count;
		} catch (error) {
			// bun test exits non-zero when tests fail, but still has output
			const output =
				error instanceof Error && "stderr" in error
					? String((error as { stderr: unknown }).stderr)
					: "";
			const match = output.match(/(\d+)\s+pass/);
			if (match) {
				const count = Number.parseInt(match[1], 10);
				this.updateCount(count);
				return count;
			}
			this.statusBarItem.text = "CC: tests \u2717";
			throw error;
		}
	}

	dispose(): void {
		this.statusBarItem.dispose();
	}
}
