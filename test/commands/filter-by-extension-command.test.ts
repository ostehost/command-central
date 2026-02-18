/**
 * Tests for filter-by-extension-command.ts
 * Extension-based file filtering
 *
 * Note: This is a complex command with many dependencies. These tests focus on
 * critical behaviors (guards, error handling, key workflows) rather than 100% coverage.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockUri } from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";
import {
	createMockExtensionFilterState,
	createMockLogger,
	createMockProjectViewManager,
	createMockViewManager,
} from "../types/command-test-mocks.js";
import type {
	IExtensionFilterState,
	IExtensionFilterViewManager,
	ILoggerService,
	IProjectViewManager,
} from "../types/type-utils.js";

describe("filter-by-extension-command", () => {
	let mockProjectViewManager: IProjectViewManager;
	let mockExtensionFilterState: IExtensionFilterState;
	let mockLogger: ILoggerService;
	let mockViewManager: IExtensionFilterViewManager;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();

		// Create properly typed mocks
		mockLogger = createMockLogger();
		mockViewManager = createMockViewManager();
		mockExtensionFilterState = createMockExtensionFilterState();
		mockProjectViewManager = createMockProjectViewManager();
	});

	test("toggle behavior - hides view when already visible and populated", async () => {
		const { execute } = await import(
			"../../src/commands/filter-by-extension-command.js"
		);

		// Mock view as visible and populated
		mockViewManager.isVisible = mock(() => true);
		mockViewManager.hasDataPopulated = mock(() => true);

		await execute(
			mockProjectViewManager,
			mockExtensionFilterState,
			mockLogger,
			mockViewManager,
		);

		// Verify toggle was called
		expect(mockViewManager.toggle).toHaveBeenCalledTimes(1);

		// Verify logged toggle action
		expect(mockLogger.info).toHaveBeenCalledWith(
			"Toggling extension filter view (hide)",
		);

		// Verify no other operations were performed
		expect(mockProjectViewManager.getAllProviders).not.toHaveBeenCalled();
	});

	test("guard - shows warning when project view manager is reloading", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/filter-by-extension-command.js"
		);

		// Mock as reloading
		mockProjectViewManager.isReloading = mock(() => true);

		await execute(
			mockProjectViewManager,
			mockExtensionFilterState,
			mockLogger,
			mockViewManager,
		);

		// Verify warning was shown
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			"Command Central is reloading. Please try again in a moment.",
		);

		// Verify no other operations were performed
		expect(mockProjectViewManager.getAllProviders).not.toHaveBeenCalled();
	});

	test("guard - shows warning when no providers found", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/filter-by-extension-command.js"
		);

		// Mock no providers
		mockProjectViewManager.getAllProviders = mock(() => []);

		await execute(
			mockProjectViewManager,
			mockExtensionFilterState,
			mockLogger,
			mockViewManager,
		);

		// Verify warning was shown
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			"No workspace providers found. Ensure workspaces are loaded.",
		);
	});

	test("guard - shows info when no git changes found", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/filter-by-extension-command.js"
		);

		// Mock providers with no changes
		const mockProvider = {
			getCurrentChanges: mock<() => never[]>(() => []),
			refresh: mock(() => {}),
		};
		mockProjectViewManager.getAllProviders = mock(() => [
			{ provider: mockProvider, slotId: "workspace1" },
		]);

		await execute(
			mockProjectViewManager,
			mockExtensionFilterState,
			mockLogger,
			mockViewManager,
		);

		// Verify info message was shown
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			"No Git changes found. Make some changes to filter by extension.",
		);
	});

	test("guard - shows error when extension filter state not initialized", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/filter-by-extension-command.js"
		);

		// Mock providers with changes
		// INTENTIONAL: Partial mock of GitChangeItem for testing
		const mockChange = {
			uri: createMockUri("/test/file.ts"),
			status: "Modified",
			isStaged: false,
		};
		const mockProvider = {
			getCurrentChanges: mock(() => [mockChange]),
			refresh: mock(() => {}),
		};
		mockProjectViewManager.getAllProviders = mock(() => [
			{ provider: mockProvider, slotId: "workspace1" },
		]);

		// Mock extension discovery module
		mock.module("../../src/utils/extension-discovery.js", () => ({
			countExtensionsByWorkspace: mock(() => new Map([["ts", new Map()]])),
			buildExtensionMetadata: mock(() => [
				{
					extension: "ts",
					displayName: "TypeScript",
					totalCount: 1,
					workspaces: new Map(),
				},
			]),
		}));

		// Pass undefined for extensionFilterState
		await execute(
			mockProjectViewManager,
			undefined,
			mockLogger,
			mockViewManager,
		);

		// Verify error message was shown
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			"Extension filter state not initialized",
		);
	});

	test("exception handling - shows error message on failure", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/filter-by-extension-command.js"
		);

		// Mock getAllProviders to throw
		mockProjectViewManager.getAllProviders = mock(() => {
			throw new Error("Provider initialization failed");
		});

		await execute(
			mockProjectViewManager,
			mockExtensionFilterState,
			mockLogger,
			mockViewManager,
		);

		// Verify error was logged
		expect(mockLogger.error).toHaveBeenCalled();

		// Verify error message was shown to user
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			"Failed to show extension filter: Provider initialization failed",
		);
	});

	test("exception handling - handles non-Error objects", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/filter-by-extension-command.js"
		);

		// Mock getAllProviders to throw non-Error
		mockProjectViewManager.getAllProviders = mock(() => {
			throw "Something broke";
		});

		await execute(
			mockProjectViewManager,
			mockExtensionFilterState,
			mockLogger,
			mockViewManager,
		);

		// Verify error message was shown with "Unknown error"
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			"Failed to show extension filter: Unknown error",
		);
	});

	test("logging - logs command invocation", async () => {
		const { execute } = await import(
			"../../src/commands/filter-by-extension-command.js"
		);

		// Mock providers with no changes (quick exit)
		const mockProvider = {
			getCurrentChanges: mock<() => never[]>(() => []),
			refresh: mock(() => {}),
		};
		mockProjectViewManager.getAllProviders = mock(() => [
			{ provider: mockProvider, slotId: "workspace1" },
		]);

		await execute(
			mockProjectViewManager,
			mockExtensionFilterState,
			mockLogger,
			mockViewManager,
		);

		// Verify command invocation was logged
		expect(mockLogger.info).toHaveBeenCalledWith(
			"🔍 Extension filter command invoked",
		);
	});

	test("handles provider errors gracefully when collecting changes", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/filter-by-extension-command.js"
		);

		// Mock provider that throws when getting changes
		const mockProvider = {
			getCurrentChanges: mock<() => never>(() => {
				throw new Error("Git error");
			}),
			refresh: mock(() => {}),
		};
		mockProjectViewManager.getAllProviders = mock(() => [
			{ provider: mockProvider, slotId: "workspace1" },
		]);

		await execute(
			mockProjectViewManager,
			mockExtensionFilterState,
			mockLogger,
			mockViewManager,
		);

		// Verify error was logged
		expect(mockLogger.error).toHaveBeenCalled();

		// Verify info message was shown (no changes collected)
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			"No Git changes found. Make some changes to filter by extension.",
		);
	});
});
