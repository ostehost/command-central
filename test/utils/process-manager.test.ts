/**
 * Tests for ProcessManager - Robust process lifecycle management
 * Test-driven development: Write tests first, then implement
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("ProcessManager", () => {
	let originalKill: typeof process.kill;
	let killMock: ReturnType<typeof mock>;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock(); // Mock vscode before dynamic import

		// Mock process.kill
		originalKill = process.kill;
		killMock = mock();
		process.kill = killMock;
	});

	afterEach(() => {
		// Restore original
		process.kill = originalKill;
	});

	describe("process tracking", () => {
		test("tracks valid processes", async () => {
			const { ProcessManager } = await import(
				"../../src/utils/process-manager.js"
			);
			const manager = new ProcessManager({
				gracefulShutdownMs: 100,
				checkIntervalMs: 10,
			});

			const pid = 12345;

			// Mock that process exists
			killMock.mockImplementation(
				(p: number, signal: number | NodeJS.Signals) => {
					if (p === pid && signal === 0) {
						return true; // Process exists
					}
					throw new Error("Process not found");
				},
			);

			const tracked = manager.track(pid);

			expect(tracked).toBe(true);
			expect(manager.isTracked(pid)).toBe(true);
			expect(manager.getActiveCount()).toBe(1);
		});

		test("rejects invalid PIDs", async () => {
			const { ProcessManager } = await import(
				"../../src/utils/process-manager.js"
			);
			const manager = new ProcessManager({
				gracefulShutdownMs: 100,
				checkIntervalMs: 10,
			});

			const invalidPids = [-1, 0, NaN, Infinity];

			for (const pid of invalidPids) {
				const tracked = manager.track(pid);
				expect(tracked).toBe(false);
				expect(manager.isTracked(pid)).toBe(false);
			}

			expect(manager.getActiveCount()).toBe(0);
		});

		test("verifies process exists before tracking", async () => {
			const { ProcessManager } = await import(
				"../../src/utils/process-manager.js"
			);
			const manager = new ProcessManager({
				gracefulShutdownMs: 100,
				checkIntervalMs: 10,
			});

			const deadPid = 99999;

			// Mock that process doesn't exist
			killMock.mockImplementation(
				(_p: number, signal: number | NodeJS.Signals) => {
					if (signal === 0) {
						throw new Error("ESRCH"); // No such process
					}
				},
			);

			const tracked = manager.track(deadPid);

			expect(tracked).toBe(false);
			expect(manager.isTracked(deadPid)).toBe(false);
			expect(manager.getActiveCount()).toBe(0);
		});

		test("untracks processes", async () => {
			const { ProcessManager } = await import(
				"../../src/utils/process-manager.js"
			);
			const manager = new ProcessManager({
				gracefulShutdownMs: 100,
				checkIntervalMs: 10,
			});

			const pid = 12345;

			// Mock that process exists
			killMock.mockReturnValue(true);

			manager.track(pid);
			expect(manager.isTracked(pid)).toBe(true);

			manager.untrack(pid);
			expect(manager.isTracked(pid)).toBe(false);
			expect(manager.getActiveCount()).toBe(0);
		});

		test("tracks multiple processes", async () => {
			const { ProcessManager } = await import(
				"../../src/utils/process-manager.js"
			);
			const manager = new ProcessManager({
				gracefulShutdownMs: 100,
				checkIntervalMs: 10,
			});

			const pids = [12345, 12346, 12347];

			// Mock all processes exist
			killMock.mockReturnValue(true);

			for (const pid of pids) {
				manager.track(pid);
			}

			expect(manager.getActiveCount()).toBe(3);

			for (const pid of pids) {
				expect(manager.isTracked(pid)).toBe(true);
			}
		});
	});

	describe("process cleanup", () => {
		test("sends SIGTERM for graceful shutdown", async () => {
			const { ProcessManager } = await import(
				"../../src/utils/process-manager.js"
			);
			const manager = new ProcessManager({
				gracefulShutdownMs: 100,
				checkIntervalMs: 10,
			});

			const pid = 12345;

			// Mock successful kill
			killMock.mockImplementation(
				(p: number, signal: number | NodeJS.Signals) => {
					if (p === pid) {
						if (signal === 0) return true; // Check if alive
						if (signal === "SIGTERM") return true; // Send signal
					}
					return false;
				},
			);

			manager.track(pid);
			await manager.cleanup();

			// Should have sent SIGTERM
			expect(killMock).toHaveBeenCalledWith(pid, "SIGTERM");
		});

		test("force kills after timeout if process doesnt exit", async () => {
			const { ProcessManager } = await import(
				"../../src/utils/process-manager.js"
			);
			const manager = new ProcessManager({
				gracefulShutdownMs: 100,
				checkIntervalMs: 10,
			});

			const pid = 12345;
			let processAlive = true;

			killMock.mockImplementation(
				(p: number, signal: number | NodeJS.Signals) => {
					if (p === pid) {
						if (signal === 0) {
							if (processAlive) return true;
							throw new Error("ESRCH");
						}
						if (signal === "SIGTERM") {
							// Process ignores SIGTERM
							return true;
						}
						if (signal === "SIGKILL") {
							processAlive = false;
							return true;
						}
					}
					return false;
				},
			);

			manager.track(pid);
			await manager.cleanupWithTimeout(100); // 100ms timeout

			// Should have tried SIGTERM then SIGKILL
			const calls = killMock.mock.calls;
			const sigTermCall = calls.find((c: unknown[]) => c[1] === "SIGTERM");
			const sigKillCall = calls.find((c: unknown[]) => c[1] === "SIGKILL");

			expect(sigTermCall).toBeDefined();
			expect(sigKillCall).toBeDefined();
		});

		test("handles already dead processes gracefully", async () => {
			const { ProcessManager } = await import(
				"../../src/utils/process-manager.js"
			);
			const manager = new ProcessManager({
				gracefulShutdownMs: 100,
				checkIntervalMs: 10,
			});

			const pid = 12345;

			killMock.mockImplementation(
				(_p: number, _signal: number | NodeJS.Signals) => {
					// Process already dead
					throw new Error("ESRCH");
				},
			);

			// Force track it anyway
			manager["processes"].set(pid, {
				pid,
				startTime: Date.now(),
				lastChecked: Date.now(),
			});

			// Should not throw
			await expect(manager.cleanup()).resolves.toBeUndefined();
		});

		test("cleans up multiple processes in parallel", async () => {
			const { ProcessManager } = await import(
				"../../src/utils/process-manager.js"
			);
			const manager = new ProcessManager({
				gracefulShutdownMs: 100,
				checkIntervalMs: 10,
			});

			const pids = [12345, 12346, 12347];
			const killedPids: number[] = [];

			killMock.mockImplementation(
				(p: number, signal: number | NodeJS.Signals) => {
					if (pids.includes(p)) {
						if (signal === 0) return true;
						if (signal === "SIGTERM") {
							killedPids.push(p);
							return true;
						}
					}
					return false;
				},
			);

			// Track all
			for (const pid of pids) {
				manager.track(pid);
			}

			const startTime = Date.now();
			await manager.cleanup();
			const duration = Date.now() - startTime;

			// All should be killed
			expect(killedPids).toHaveLength(3);

			// Should be done quickly (parallel, not sequential)
			// Allow some overhead for async operations
			expect(duration).toBeLessThan(200);

			// Manager should be empty
			expect(manager.getActiveCount()).toBe(0);
		});

		test("continues cleanup even if some processes fail", async () => {
			const { ProcessManager } = await import(
				"../../src/utils/process-manager.js"
			);
			const manager = new ProcessManager({
				gracefulShutdownMs: 100,
				checkIntervalMs: 10,
			});

			const pids = [12345, 12346, 12347];
			const killedPids: number[] = [];

			killMock.mockImplementation(
				(p: number, signal: number | NodeJS.Signals) => {
					if (p === 12346) {
						// Middle process fails
						throw new Error("Permission denied");
					}
					if (pids.includes(p)) {
						if (signal === 0) return true;
						if (signal === "SIGTERM") {
							killedPids.push(p);
							return true;
						}
					}
					return false;
				},
			);

			// Track all
			for (const pid of pids) {
				manager.track(pid);
			}

			// Should not throw despite one failure
			await expect(manager.cleanup()).resolves.toBeUndefined();

			// Two should be killed (not the failed one)
			expect(killedPids).toEqual([12345, 12347]);
		});
	});

	describe("process health monitoring", () => {
		test("checks if process is alive", async () => {
			const { ProcessManager } = await import(
				"../../src/utils/process-manager.js"
			);
			const manager = new ProcessManager({
				gracefulShutdownMs: 100,
				checkIntervalMs: 10,
			});

			const alivePid = 12345;
			const deadPid = 99999;

			killMock.mockImplementation(
				(p: number, signal: number | NodeJS.Signals) => {
					if (p === alivePid && signal === 0) return true;
					throw new Error("ESRCH");
				},
			);

			expect(manager.isAlive(alivePid)).toBe(true);
			expect(manager.isAlive(deadPid)).toBe(false);
		});

		test("removes dead processes during health check", async () => {
			const { ProcessManager } = await import(
				"../../src/utils/process-manager.js"
			);
			const manager = new ProcessManager({
				gracefulShutdownMs: 100,
				checkIntervalMs: 10,
			});

			const pids = [12345, 12346, 12347];

			// Initially all alive
			killMock.mockReturnValue(true);

			for (const pid of pids) {
				manager.track(pid);
			}

			expect(manager.getActiveCount()).toBe(3);

			// Now middle one dies
			killMock.mockImplementation(
				(p: number, signal: number | NodeJS.Signals) => {
					if (p === 12346 && signal === 0) {
						throw new Error("ESRCH");
					}
					return true;
				},
			);

			// Health check should remove dead process
			manager.healthCheck();

			expect(manager.getActiveCount()).toBe(2);
			expect(manager.isTracked(12346)).toBe(false);
		});

		test("provides process info", async () => {
			const { ProcessManager } = await import(
				"../../src/utils/process-manager.js"
			);
			const manager = new ProcessManager({
				gracefulShutdownMs: 100,
				checkIntervalMs: 10,
			});

			const pid = 12345;

			killMock.mockReturnValue(true);

			const beforeTrack = Date.now();
			manager.track(pid);
			const afterTrack = Date.now();

			const info = manager.getProcessInfo(pid);

			expect(info).toBeDefined();
			expect(info?.pid).toBe(pid);
			expect(info?.startTime).toBeGreaterThanOrEqual(beforeTrack);
			expect(info?.startTime).toBeLessThanOrEqual(afterTrack);
		});
	});

	describe("edge cases", () => {
		test("handles permission denied errors", async () => {
			const { ProcessManager } = await import(
				"../../src/utils/process-manager.js"
			);
			const manager = new ProcessManager({
				gracefulShutdownMs: 100,
				checkIntervalMs: 10,
			});

			const pid = 1; // Usually init process, no permission

			killMock.mockImplementation(() => {
				const error = new Error("EPERM") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			});

			const tracked = manager.track(pid);

			expect(tracked).toBe(false);
			expect(manager.isTracked(pid)).toBe(false);
		});

		test("handles race condition where process dies during tracking", async () => {
			const { ProcessManager } = await import(
				"../../src/utils/process-manager.js"
			);
			const manager = new ProcessManager({
				gracefulShutdownMs: 100,
				checkIntervalMs: 10,
			});

			const pid = 12345;
			let callCount = 0;

			killMock.mockImplementation(
				(_p: number, signal: number | NodeJS.Signals) => {
					callCount++;
					if (callCount === 1 && signal === 0) {
						// First check: alive
						return true;
					}
					// Subsequent checks: dead
					throw new Error("ESRCH");
				},
			);

			// This could happen if process dies between check and track
			const tracked = manager.track(pid);

			// Implementation should handle this gracefully
			expect(tracked).toBeDefined(); // Should return true or false, not throw
		});
	});
});
