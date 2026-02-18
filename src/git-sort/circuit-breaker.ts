/**
 * Circuit Breaker - Prevents infinite loops and excessive operations
 */

import * as vscode from "vscode";

export class CircuitBreaker {
	private attempts = 0;
	private lastReset = Date.now();
	private readonly maxAttempts = 10;
	private readonly resetIntervalMs = 60000; // 1 minute
	private isOpen = false;

	canProceed(): boolean {
		// If circuit is open, don't proceed
		if (this.isOpen) {
			return false;
		}

		// Reset counter every minute
		if (Date.now() - this.lastReset > this.resetIntervalMs) {
			this.attempts = 0;
			this.lastReset = Date.now();
		}

		this.attempts++;

		// Trip the circuit breaker after too many attempts
		if (this.attempts > this.maxAttempts) {
			// Circuit breaker triggered - notification sent via showWarningMessage
			this.isOpen = true;

			vscode.window.showWarningMessage(
				"Git Sort disabled due to excessive operations. Restart VS Code to re-enable.",
			);

			return false;
		}

		return true;
	}

	reset(): void {
		this.attempts = 0;
		this.lastReset = Date.now();
		this.isOpen = false;
	}

	getStatus(): { attempts: number; isOpen: boolean } {
		return {
			attempts: this.attempts,
			isOpen: this.isOpen,
		};
	}
}
