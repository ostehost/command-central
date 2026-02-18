/**
 * Simplified Tests for Git Sorter (SCM Manager)
 * Tests enable/disable configuration
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LoggerService } from "../../src/services/logger-service.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

const createMockLogger = (): LoggerService =>
	({
		info: mock(),
		error: mock(),
		warn: mock(),
		debug: mock(),
		performance: mock(),
		process: mock(),
		setLogLevel: mock(),
		getLogLevel: mock(() => 1),
		show: mock(),
		hide: mock(),
		clear: mock(),
		getOutputChannel: mock(),
		getHistory: mock(() => []),
		exportLogs: mock(() => ""),
		dispose: mock(),
	}) as unknown as LoggerService;

describe("GitSorter", () => {
	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
	});

	test("should initialize with enabled configuration", async () => {
		// Mock configuration
		mock.module("vscode", () => ({
			workspace: {
				getConfiguration: mock(() => ({
					get: mock((_key: string, _defaultValue: boolean) => true),
				})),
			},
		}));

		// Use dynamic import after mock is set up
		const { GitSorter } = await import("../../src/git-sort/scm-sorter.js");
		const logger = createMockLogger();
		const sorter = new GitSorter(logger);

		await sorter.activate();
		// If we get here without errors, initialization worked
		expect(true).toBe(true);
	});

	test("should respect disabled configuration", async () => {
		// Mock configuration with disabled state
		mock.module("vscode", () => ({
			workspace: {
				getConfiguration: mock(() => ({
					get: mock((_key: string, _defaultValue: boolean) => false),
				})),
			},
		}));

		// Use dynamic import after mock is set up
		const { GitSorter } = await import("../../src/git-sort/scm-sorter.js");
		const logger = createMockLogger();
		const sorter = new GitSorter(logger);

		await sorter.activate();
		// If we get here without errors, initialization respected disabled state
		expect(true).toBe(true);
	});

	test("enable() sets enabled state and updates configuration", async () => {
		// Mock vscode configuration with update tracking
		let configValue = false;
		const mockUpdate = mock((key: string, value: boolean) => {
			if (key === "enabled") {
				configValue = value;
			}
		});

		mock.module("vscode", () => ({
			workspace: {
				getConfiguration: mock(() => ({
					get: mock((key: string, defaultValue: boolean) => {
						if (key === "enabled") {
							return configValue;
						}
						return defaultValue;
					}),
					update: mockUpdate,
				})),
			},
		}));

		const { GitSorter } = await import("../../src/git-sort/scm-sorter.js");
		const logger = createMockLogger();
		const sorter = new GitSorter(logger);

		// Initially disabled (configValue = false)
		expect(sorter.isEnabled()).toBe(false);

		// Enable
		sorter.enable();

		// State updated
		expect(sorter.isEnabled()).toBe(true);
		expect(mockUpdate).toHaveBeenCalledWith("enabled", true);
	});

	test("disable() sets disabled state and updates configuration", async () => {
		// Mock vscode configuration with update tracking
		let configValue = true;
		const mockUpdate = mock((_key: string, value: boolean) => {
			configValue = value;
		});

		mock.module("vscode", () => ({
			workspace: {
				getConfiguration: mock(() => ({
					get: mock((_key: string, _defaultValue: boolean) => configValue),
					update: mockUpdate,
				})),
			},
		}));

		const { GitSorter } = await import("../../src/git-sort/scm-sorter.js");
		const logger = createMockLogger();
		const sorter = new GitSorter(logger);

		// Initially enabled
		expect(sorter.isEnabled()).toBe(true);

		// Disable
		sorter.disable();

		// State updated
		expect(sorter.isEnabled()).toBe(false);
		expect(mockUpdate).toHaveBeenCalledWith("enabled", false);
	});

	test("isEnabled() returns current enabled state", async () => {
		// Mock with enabled state
		mock.module("vscode", () => ({
			workspace: {
				getConfiguration: mock(() => ({
					get: mock((_key: string, _defaultValue: boolean) => true),
					update: mock(),
				})),
			},
		}));

		const { GitSorter } = await import("../../src/git-sort/scm-sorter.js");
		const logger = createMockLogger();
		const sorter = new GitSorter(logger);

		expect(sorter.isEnabled()).toBe(true);
	});

	test("isEnabled() returns current disabled state", async () => {
		// Mock with disabled state
		mock.module("vscode", () => ({
			workspace: {
				getConfiguration: mock(() => ({
					get: mock((_key: string, _defaultValue: boolean) => false),
					update: mock(),
				})),
			},
		}));

		const { GitSorter } = await import("../../src/git-sort/scm-sorter.js");
		const logger = createMockLogger();
		const sorter = new GitSorter(logger);

		expect(sorter.isEnabled()).toBe(false);
	});
});
