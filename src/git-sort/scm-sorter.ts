/**
 * Git Sort Manager - Configuration and state management
 * Simplified version - removed dead SCM hooking code
 */

import * as vscode from "vscode";
import type { LoggerService } from "../services/logger-service.js";

export class GitSorter {
	private enabled = false;

	constructor(private logger: LoggerService) {
		// Check configuration
		this.enabled = vscode.workspace
			.getConfiguration("commandCentral.gitSort")
			.get("enabled", true);
	}

	async activate(): Promise<void> {
		if (!this.enabled) {
			this.logger.info("Git Sort is disabled");
			return;
		}

		this.logger.info("✅ Git Sort configuration manager activated");
		// The actual sorting is handled by SortedGitChangesProvider
	}

	enable(): void {
		this.enabled = true;
		vscode.workspace
			.getConfiguration("commandCentral.gitSort")
			.update("enabled", true);
		this.logger.info("Git Sort enabled");
	}

	disable(): void {
		this.enabled = false;
		vscode.workspace
			.getConfiguration("commandCentral.gitSort")
			.update("enabled", false);
		this.logger.info("Git Sort disabled");
	}

	isEnabled(): boolean {
		return this.enabled;
	}
}
