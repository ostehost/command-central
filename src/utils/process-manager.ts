/**
 * ProcessManager - Robust process lifecycle management
 * Handles tracking, monitoring, and cleanup of spawned processes
 */

import { getLogger } from "../services/logger-service.js";

interface ProcessInfo {
	pid: number;
	startTime: number;
	lastChecked: number;
}

export class ProcessManager {
	private processes = new Map<number, ProcessInfo>();
	private readonly gracefulShutdownMs: number;
	private readonly checkIntervalMs: number;

	constructor(
		options: { gracefulShutdownMs?: number; checkIntervalMs?: number } = {},
	) {
		this.gracefulShutdownMs = options.gracefulShutdownMs ?? 5000;
		this.checkIntervalMs = options.checkIntervalMs ?? 100;
	}

	/**
	 * Track a new process
	 * Returns true if successfully tracked, false otherwise
	 */
	track(pid: number): boolean {
		// Validate PID
		if (!this.isValidPid(pid)) {
			getLogger().warn(`Invalid PID: ${pid}`, "ProcessManager");
			return false;
		}

		// Check if process is alive before tracking
		if (!this.isAlive(pid)) {
			getLogger().debug(
				`Process ${pid} is not alive, not tracking`,
				"ProcessManager",
			);
			return false;
		}

		// Add to tracking
		this.processes.set(pid, {
			pid,
			startTime: Date.now(),
			lastChecked: Date.now(),
		});

		getLogger().process("Tracking started", pid);
		return true;
	}

	/**
	 * Stop tracking a process
	 */
	untrack(pid: number): void {
		this.processes.delete(pid);
		getLogger().process("Tracking stopped", pid);
	}

	/**
	 * Check if a process is being tracked
	 */
	isTracked(pid: number): boolean {
		return this.processes.has(pid);
	}

	/**
	 * Get count of active processes
	 */
	getActiveCount(): number {
		return this.processes.size;
	}

	/**
	 * Get information about a tracked process
	 */
	getProcessInfo(pid: number): ProcessInfo | undefined {
		return this.processes.get(pid);
	}

	/**
	 * Check if a process is alive
	 */
	isAlive(pid: number): boolean {
		try {
			// Signal 0 doesn't kill, just checks if process exists
			process.kill(pid, 0);
			return true;
		} catch (_error) {
			// ESRCH means process doesn't exist
			// EPERM means no permission (but process might exist)
			// For our purposes, we can't manage processes we don't have permission for
			return false;
		}
	}

	/**
	 * Validate if a PID is valid
	 */
	private isValidPid(pid: number): boolean {
		return Number.isInteger(pid) && pid > 0 && pid < Number.MAX_SAFE_INTEGER;
	}

	/**
	 * Perform health check on all tracked processes
	 * Removes dead processes from tracking
	 */
	healthCheck(): void {
		const deadPids: number[] = [];

		for (const [pid, info] of this.processes) {
			if (!this.isAlive(pid)) {
				deadPids.push(pid);
			} else {
				// Update last checked time
				info.lastChecked = Date.now();
			}
		}

		// Remove dead processes
		for (const pid of deadPids) {
			this.untrack(pid);
			getLogger().process("Removed dead process during health check", pid);
		}
	}

	/**
	 * Clean up all tracked processes
	 */
	async cleanup(): Promise<void> {
		const cleanupPromises = Array.from(this.processes.keys()).map((pid) =>
			this.cleanupProcess(pid),
		);

		// Wait for all cleanups to complete (success or failure)
		await Promise.allSettled(cleanupPromises);

		// Clear all tracking
		this.processes.clear();
		getLogger().info("All processes cleaned up", "ProcessManager");
	}

	/**
	 * Clean up with timeout
	 */
	async cleanupWithTimeout(timeoutMs = 5000): Promise<void> {
		const cleanupPromises = Array.from(this.processes.keys()).map((pid) =>
			this.cleanupProcessWithTimeout(pid, timeoutMs),
		);

		await Promise.allSettled(cleanupPromises);
		this.processes.clear();
	}

	/**
	 * Clean up a single process
	 */
	private async cleanupProcess(pid: number): Promise<void> {
		try {
			// Check if process exists first
			if (!this.isAlive(pid)) {
				getLogger().debug(`Process ${pid} already dead`, "ProcessManager");
				return;
			}

			// First try graceful shutdown
			getLogger().process("Sending SIGTERM", pid);
			process.kill(pid, "SIGTERM");

			// Wait for process to exit gracefully
			await this.waitForProcessDeath(pid, this.gracefulShutdownMs);

			getLogger().process("Terminated gracefully", pid);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				// Process already dead
				getLogger().debug(`Process ${pid} already dead`, "ProcessManager");
			} else if ((error as Error).message?.includes("did not die")) {
				// Try force kill after timeout
				try {
					getLogger().process("Force killing with SIGKILL", pid);
					process.kill(pid, "SIGKILL");
				} catch (killError) {
					if ((killError as NodeJS.ErrnoException).code !== "ESRCH") {
						getLogger().error(
							`Failed to kill process ${pid}`,
							killError as Error,
							"ProcessManager",
						);
					}
				}
			} else {
				getLogger().error(
					`Error cleaning up process ${pid}`,
					error as Error,
					"ProcessManager",
				);
			}
		}
	}

	/**
	 * Clean up a process with specific timeout
	 */
	private async cleanupProcessWithTimeout(
		pid: number,
		timeoutMs: number,
	): Promise<void> {
		try {
			// Send SIGTERM
			process.kill(pid, "SIGTERM");

			// Wait for process to die
			const startTime = Date.now();
			while (Date.now() - startTime < timeoutMs) {
				if (!this.isAlive(pid)) {
					getLogger().process("Terminated within timeout", pid);
					return;
				}
				// Check every 50ms
				await new Promise((resolve) => setTimeout(resolve, 50));
			}

			// Timeout reached, force kill
			getLogger().warn(
				`Process ${pid} didn't exit within ${timeoutMs}ms, force killing`,
				"ProcessManager",
			);
			process.kill(pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
				getLogger().error(
					`Error cleaning up process ${pid}`,
					error as Error,
					"ProcessManager",
				);
			}
		}
	}

	/**
	 * Wait for a process to die
	 */
	private async waitForProcessDeath(
		pid: number,
		maxWaitMs: number,
	): Promise<void> {
		const startTime = Date.now();

		while (Date.now() - startTime < maxWaitMs) {
			if (!this.isAlive(pid)) {
				return;
			}
			// Check periodically
			await new Promise((resolve) => setTimeout(resolve, this.checkIntervalMs));
		}

		throw new Error(`Process ${pid} did not die within ${maxWaitMs}ms`);
	}
}
