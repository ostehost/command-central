/**
 * Tests for Circuit Breaker
 * Ensures rate limiting and circuit breaking behavior works correctly
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("CircuitBreaker", () => {
	beforeEach(() => {
		// Reset mocks and set up vscode mock for all tests
		mock.restore();
		setupVSCodeMock();
	});

	describe("canProceed", () => {
		test("should allow initial attempts", async () => {
			const { CircuitBreaker } = await import(
				"../../src/git-sort/circuit-breaker.js"
			);
			const circuitBreaker = new CircuitBreaker();

			expect(circuitBreaker.canProceed()).toBe(true);
			expect(circuitBreaker.canProceed()).toBe(true);
			expect(circuitBreaker.canProceed()).toBe(true);
		});

		test("should trip after max attempts exceeded", async () => {
			const { CircuitBreaker } = await import(
				"../../src/git-sort/circuit-breaker.js"
			);
			const circuitBreaker = new CircuitBreaker();

			// Make 10 attempts (the default max)
			for (let i = 0; i < 10; i++) {
				expect(circuitBreaker.canProceed()).toBe(true);
			}

			// 11th attempt should trip the breaker
			expect(circuitBreaker.canProceed()).toBe(false);

			// Subsequent attempts should also fail
			expect(circuitBreaker.canProceed()).toBe(false);
		});

		test("should show warning message when circuit trips", async () => {
			// Mock vscode with tracking
			const showWarningMessage = mock(() => Promise.resolve());
			mock.module("vscode", () => ({
				window: {
					showWarningMessage,
				},
			}));

			// Use dynamic import after mock is set up
			const { CircuitBreaker } = await import(
				"../../src/git-sort/circuit-breaker.js"
			);
			const circuitBreaker = new CircuitBreaker();

			// Trip the circuit
			for (let i = 0; i < 11; i++) {
				circuitBreaker.canProceed();
			}

			expect(showWarningMessage).toHaveBeenCalledWith(
				"Git Sort disabled due to excessive operations. Restart VS Code to re-enable.",
			);
		});

		test("should reset attempts after time interval", async () => {
			const { CircuitBreaker } = await import(
				"../../src/git-sort/circuit-breaker.js"
			);
			const circuitBreaker = new CircuitBreaker();

			// Make 5 attempts
			for (let i = 0; i < 5; i++) {
				circuitBreaker.canProceed();
			}

			// Mock time passing (more than 60 seconds)
			const originalDateNow = Date.now;
			Date.now = () => originalDateNow() + 61000;

			// Should reset and allow more attempts
			expect(circuitBreaker.canProceed()).toBe(true);

			// Restore Date.now
			Date.now = originalDateNow;
		});

		test("should not proceed when circuit is open", async () => {
			const { CircuitBreaker } = await import(
				"../../src/git-sort/circuit-breaker.js"
			);
			const circuitBreaker = new CircuitBreaker();

			// Trip the circuit
			for (let i = 0; i < 11; i++) {
				circuitBreaker.canProceed();
			}

			// Circuit is now open
			const status = circuitBreaker.getStatus();
			expect(status.isOpen).toBe(true);

			// Should not proceed
			expect(circuitBreaker.canProceed()).toBe(false);
		});
	});

	describe("reset", () => {
		test("should reset attempts and open state", async () => {
			const { CircuitBreaker } = await import(
				"../../src/git-sort/circuit-breaker.js"
			);
			const circuitBreaker = new CircuitBreaker();

			// Trip the circuit
			for (let i = 0; i < 11; i++) {
				circuitBreaker.canProceed();
			}

			// Verify it's tripped
			expect(circuitBreaker.getStatus().isOpen).toBe(true);
			expect(circuitBreaker.canProceed()).toBe(false);

			// Reset
			circuitBreaker.reset();

			// Should be able to proceed again
			expect(circuitBreaker.getStatus().isOpen).toBe(false);
			expect(circuitBreaker.getStatus().attempts).toBe(0);
			expect(circuitBreaker.canProceed()).toBe(true);
		});
	});

	describe("getStatus", () => {
		test("should show open status when tripped", async () => {
			const { CircuitBreaker } = await import(
				"../../src/git-sort/circuit-breaker.js"
			);
			const circuitBreaker = new CircuitBreaker();

			// Trip the circuit
			for (let i = 0; i < 11; i++) {
				circuitBreaker.canProceed();
			}

			const status = circuitBreaker.getStatus();
			expect(status.attempts).toBe(11);
			expect(status.isOpen).toBe(true);
		});
	});
});
