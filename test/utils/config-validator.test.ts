/**
 * Tests for ConfigValidator
 */

import { beforeEach, expect, test } from "bun:test";
import { ConfigValidator } from "../../src/utils/config-validator.js";
import { createMockWorkspaceConfiguration } from "../helpers/typed-mocks.js";
import {
	createMockCommands,
	createMockWindow,
	createMockWorkspace,
} from "../mocks/index.test.js";

let validator: ConfigValidator;
let mockWorkspace = createMockWorkspace();
let mockWindow = createMockWindow();
let mockCommands = createMockCommands();

beforeEach(() => {
	mockWorkspace = createMockWorkspace();
	mockWindow = createMockWindow();
	mockCommands = createMockCommands();
	validator = new ConfigValidator(mockWorkspace, mockWindow, mockCommands);
});

test("ConfigValidator - validates valid configuration", async () => {
	const result = await validator.validateConfiguration();

	expect(result.isValid).toBe(true);
	expect(result.criticalErrors).toEqual([]);
	expect(result.errors).toEqual([]);
	expect(result.warnings).toEqual([]);
});

test("ConfigValidator - allows absolute paths with .. but blocks relative paths with ..", async () => {
	// Test relative path with .. (should be blocked)
	mockWorkspace.getConfiguration = () =>
		createMockWorkspaceConfiguration({
			path: "../../../etc/passwd",
		});

	let result = await validator.validateConfiguration();

	expect(result.isValid).toBe(true); // Not a critical error
	expect(result.errors).toContainEqual(
		expect.stringContaining('Relative paths with ".." are not allowed'),
	);

	// Test absolute path with .. (should be allowed and no error about ..)
	mockWorkspace.getConfiguration = () =>
		createMockWorkspaceConfiguration({
			path: "/Users/../Users/test/Terminal.app",
		});

	result = await validator.validateConfiguration();

	// Should not have any errors specifically about .. in the path
	// (may have other errors like file not found, but that's different)
	const dotDotErrors = result.errors.filter(
		(e) => e.includes('".."') || e.includes('Relative paths with ".."'),
	);
	expect(dotDotErrors).toEqual([]);
});

test("ConfigValidator - detects dangerous command arguments", async () => {
	mockWorkspace.getConfiguration = () =>
		createMockWorkspaceConfiguration({
			args: ["--command=rm -rf /"],
		});

	const result = await validator.validateConfiguration();

	expect(result.isValid).toBe(true); // Not a critical error, just a security issue
	expect(result.errors).toContainEqual(
		expect.stringContaining("Potentially dangerous argument"),
	);
});

test("ConfigValidator - warns about unbalanced quotes", async () => {
	mockWorkspace.getConfiguration = () =>
		createMockWorkspaceConfiguration({
			args: ['--title="My Terminal'],
		});

	const result = await validator.validateConfiguration();

	expect(result.isValid).toBe(true);
	expect(result.warnings).toContainEqual(
		expect.stringContaining("unbalanced quotes"),
	);
});

test("ConfigValidator - detects dangerous environment variables", async () => {
	mockWorkspace.getConfiguration = () =>
		createMockWorkspaceConfiguration({
			env: { LD_PRELOAD: "/evil/lib.so" },
		});

	const result = await validator.validateConfiguration();

	expect(result.isValid).toBe(true); // Warning, not error
	expect(result.warnings).toContainEqual(
		expect.stringContaining("security implications"),
	);
});

test("ConfigValidator - detects command injection in env vars", async () => {
	mockWorkspace.getConfiguration = () =>
		createMockWorkspaceConfiguration({
			env: { PATH: "$(rm -rf /):/usr/bin" },
		});

	const result = await validator.validateConfiguration();

	expect(result.isValid).toBe(true); // Not a critical error
	expect(result.errors).toContainEqual(
		expect.stringContaining("potentially dangerous characters"),
	);
});

test("ConfigValidator - validates timeout range", async () => {
	mockWorkspace.getConfiguration = () =>
		createMockWorkspaceConfiguration({
			executionTimeout: -1000,
		});

	const result = await validator.validateConfiguration();

	expect(result.isValid).toBe(true); // Not a critical error
	expect(result.errors).toContainEqual(
		expect.stringContaining("cannot be negative"),
	);
});

test("ConfigValidator - warns about excessive timeout", async () => {
	mockWorkspace.getConfiguration = () =>
		createMockWorkspaceConfiguration({
			executionTimeout: 600000, // 10 minutes
		});

	const result = await validator.validateConfiguration();

	expect(result.isValid).toBe(true);
	expect(result.warnings).toContainEqual(
		expect.stringContaining("exceeds recommended maximum"),
	);
});

test("ConfigValidator - validates buffer size", async () => {
	mockWorkspace.getConfiguration = () =>
		createMockWorkspaceConfiguration({
			maxBuffer: 0,
		});

	const result = await validator.validateConfiguration();

	expect(result.isValid).toBe(true); // Not a critical error
	expect(result.errors).toContainEqual(expect.stringContaining("cannot be 0"));
});

test("ConfigValidator - validates log level", async () => {
	mockWorkspace.getConfiguration = () =>
		createMockWorkspaceConfiguration({
			logLevel: "verbose", // Invalid
		});

	const result = await validator.validateConfiguration();

	expect(result.isValid).toBe(true); // Not a critical error
	expect(result.errors).toContainEqual(
		expect.stringContaining("Invalid log level"),
	);
});

test("ConfigValidator - accepts valid log levels", async () => {
	const validLevels = ["debug", "info", "warn", "error", "none"];

	for (const level of validLevels) {
		mockWorkspace.getConfiguration = () =>
			createMockWorkspaceConfiguration({
				logLevel: level,
			});

		const result = await validator.validateConfiguration();
		expect(result.isValid).toBe(true);
		expect(result.errors).toEqual([]);
	}
});

test("ConfigValidator - macOS path validation", async () => {
	const originalPlatform = process.platform;
	try {
		// Mock platform as macOS for cross-platform CI
		Object.defineProperty(process, "platform", {
			value: "darwin",
			configurable: true,
		});

		mockWorkspace.getConfiguration = () =>
			createMockWorkspaceConfiguration({
				path: "/usr/local/bin/ghostty", // Should be .app
			});

		const result = await validator.validateConfiguration();

		expect(result.warnings).toContainEqual(
			expect.stringContaining("should point to the .app bundle"),
		);
	} finally {
		Object.defineProperty(process, "platform", {
			value: originalPlatform,
			configurable: true,
		});
	}
});

test("ConfigValidator - shows validation results with critical errors", () => {
	const result = {
		isValid: false,
		criticalErrors: ["Critical 1", "Critical 2"],
		errors: [],
		warnings: [],
	};

	validator.showValidationResults(result);

	expect(mockWindow.showErrorMessage).toHaveBeenCalledWith(
		expect.stringContaining("Critical 1"),
		"Open Settings",
	);
});

test("ConfigValidator - shows validation results with errors", () => {
	const result = {
		isValid: true,
		criticalErrors: [],
		errors: ["Error 1", "Error 2"],
		warnings: [],
	};

	validator.showValidationResults(result);

	expect(mockWindow.showErrorMessage).toHaveBeenCalledWith(
		expect.stringContaining("Error 1"),
		"Open Settings",
		"Ignore",
	);
});

test("ConfigValidator - shows validation results with warnings", () => {
	const result = {
		isValid: true,
		criticalErrors: [],
		errors: [],
		warnings: ["Warning 1", "Warning 2"],
	};

	validator.showValidationResults(result);

	expect(mockWindow.showWarningMessage).toHaveBeenCalledWith(
		expect.stringContaining("Warning 1"),
		"Open Settings",
		"Ignore",
	);
});
