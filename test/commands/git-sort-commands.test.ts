/**
 * Tests for enable-sort.ts and disable-sort.ts
 * Git sort toggling commands
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { GitSorter } from "../../src/git-sort/scm-sorter.js";
import { overrideWindowMethod } from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";
import { createMockSCMSorter } from "../types/command-test-mocks.js";

describe("enable-sort command", () => {
	let mockSorter: GitSorter;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();

		// Create properly typed mock
		mockSorter = createMockSCMSorter();
	});

	test("success path - enables sorter, activates, and shows status message", async () => {
		const vscode = await import("vscode");
		const { execute } = await import("../../src/commands/enable-sort.js");

		await execute(mockSorter);

		// Verify sorter methods were called
		expect(mockSorter.enable).toHaveBeenCalledTimes(1);
		expect(mockSorter.activate).toHaveBeenCalledTimes(1);

		// Verify status message was shown
		expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
			"$(check) Git Sort enabled",
			3000,
		);
	});

	test("calls enable before activate", async () => {
		const { execute } = await import("../../src/commands/enable-sort.js");

		const callOrder: string[] = [];

		mockSorter.enable = mock(() => {
			callOrder.push("enable");
		});

		mockSorter.activate = mock(() => {
			callOrder.push("activate");
			return Promise.resolve();
		});

		await execute(mockSorter);

		// Verify enable was called before activate
		expect(callOrder).toEqual(["enable", "activate"]);
	});

	test("exception path - shows error message when enable fails", async () => {
		const vscode = await import("vscode");
		const { execute } = await import("../../src/commands/enable-sort.js");

		// Mock enable to throw
		mockSorter.enable = mock(() => {
			throw new Error("Sorter initialization failed");
		});

		// Command should not throw (error is handled)
		await execute(mockSorter);

		// Verify error message was shown
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			"Failed to enable Git Sort",
		);
	});

	test("exception path - shows error message when activate fails", async () => {
		const vscode = await import("vscode");
		const { execute } = await import("../../src/commands/enable-sort.js");

		// Mock activate to throw
		mockSorter.activate = mock(() => {
			throw new Error("Activation failed");
		});

		// Command should not throw (error is handled)
		await execute(mockSorter);

		// Verify error message was shown
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			"Failed to enable Git Sort",
		);
	});
});

describe("disable-sort command", () => {
	let mockSorter: GitSorter;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();

		// Create properly typed mock
		mockSorter = createMockSCMSorter();
	});

	test("success path - disables sorter and shows information message", async () => {
		const vscode = await import("vscode");
		const { execute } = await import("../../src/commands/disable-sort.js");

		await execute(mockSorter);

		// Verify sorter was disabled
		expect(mockSorter.disable).toHaveBeenCalledTimes(1);

		// Verify information message was shown
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			"Git Sort disabled. Your changes will appear in default order.",
			"Re-enable",
		);
	});

	test("re-enable button - executes enable command when user clicks Re-enable", async () => {
		const vscode = await import("vscode");
		const { execute } = await import("../../src/commands/disable-sort.js");

		// Mock showInformationMessage to simulate user clicking "Re-enable"
		overrideWindowMethod(
			vscode.window,
			"showInformationMessage",
			mock(() => Promise.resolve("Re-enable")),
		);

		await execute(mockSorter);

		// Wait for the .then() callback to execute
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Verify the enable command was executed
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"commandCentral.gitSort.enable",
		);
	});

	test("re-enable button - does not execute command when user dismisses", async () => {
		const vscode = await import("vscode");
		const { execute } = await import("../../src/commands/disable-sort.js");

		// Mock showInformationMessage to simulate user dismissing (undefined)
		overrideWindowMethod(
			vscode.window,
			"showInformationMessage",
			mock(() => Promise.resolve(undefined)),
		);

		await execute(mockSorter);

		// Wait for the .then() callback to execute
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Verify the enable command was NOT executed
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
	});

	test("exception path - shows error message when disable fails", async () => {
		const vscode = await import("vscode");
		const { execute } = await import("../../src/commands/disable-sort.js");

		// Mock disable to throw
		mockSorter.disable = mock(() => {
			throw new Error("Sorter deactivation failed");
		});

		// Command should not throw (error is handled)
		await execute(mockSorter);

		// Verify error message was shown
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			"Failed to disable Git Sort",
		);
	});
});
