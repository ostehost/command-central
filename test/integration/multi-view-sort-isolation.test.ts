/**
 * Multi-View Sort Isolation Tests
 *
 * Tests that each workspace view maintains independent sort state when
 * clicking the sort button in different views.
 *
 * Current Bug: Clicking sort in ANY view affects only slot1 (first visible view)
 * Expected: Clicking sort in slot2 should ONLY affect slot2
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LoggerService } from "../../src/services/logger-service.js";
import {
	createMockExtensionContext,
	createMockLogger,
	createMockWorkspaceFolder,
	setMockWorkspaceFolders,
} from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("Multi-View Sort Isolation", () => {
	let logger: LoggerService;

	beforeEach(() => {
		logger = createMockLogger();

		// Restore all mocks FIRST to prevent pollution
		mock.restore();

		setupVSCodeMock();

		// NOTE: We don't mock git-timestamps here to avoid polluting other tests
		// The real git-timestamps will run but won't affect this test's assertions
	});

	test("FAILING: each view maintains independent sort state", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);
		const { ProjectProviderFactory } = await import(
			"../../src/factories/provider-factory.js"
		);
		const { WorkspaceProjectSource } = await import(
			"../../src/config/workspace-project-source.js"
		);

		// Setup: 3 workspaces
		const vscode = await import("vscode");

		// Use typed helper to set workspace folders
		const folder1 = createMockWorkspaceFolder("/f1", {
			name: "folder1",
			index: 0,
		});
		const folder2 = createMockWorkspaceFolder("/f2", {
			name: "folder2",
			index: 1,
		});
		const folder3 = createMockWorkspaceFolder("/f3", {
			name: "folder3",
			index: 2,
		});
		setMockWorkspaceFolders(vscode.workspace, [folder1, folder2, folder3]);

		const configSource = new WorkspaceProjectSource(logger);

		// Use complete typed context
		const contextForFactory = createMockExtensionContext({
			globalStoragePath: "/tmp/test",
		});
		const providerFactory = new ProjectProviderFactory(
			logger,
			contextForFactory,
		);

		// Use complete typed context
		const contextForManager = createMockExtensionContext();
		const manager = new ProjectViewManager(
			contextForManager,
			logger,
			configSource,
			providerFactory,
		);

		await manager.registerAllProjects();

		const slot1 = manager.getProviderByViewId("commandCentral.project.slot1");
		const slot2 = manager.getProviderByViewId("commandCentral.project.slot2");
		const slot3 = manager.getProviderByViewId("commandCentral.project.slot3");

		// Toggle slot2 to oldest
		slot2?.setSortOrder("oldest");

		// Verify: Only slot2 changed
		expect(slot1?.getSortOrder()).toBe("newest"); // Unchanged
		expect(slot2?.getSortOrder()).toBe("oldest"); // Changed
		expect(slot3?.getSortOrder()).toBe("newest"); // Unchanged

		// Toggle slot1 to oldest
		slot1?.setSortOrder("oldest");

		// Verify: slot2 still oldest, slot1 now oldest, slot3 still newest
		expect(slot1?.getSortOrder()).toBe("oldest"); // Changed
		expect(slot2?.getSortOrder()).toBe("oldest"); // Still oldest
		expect(slot3?.getSortOrder()).toBe("newest"); // Still newest

		// Toggle slot2 back to newest
		slot2?.setSortOrder("newest");

		// Verify: slot1 unchanged, slot2 back to newest
		expect(slot1?.getSortOrder()).toBe("oldest"); // Still oldest
		expect(slot2?.getSortOrder()).toBe("newest"); // Back to newest
		expect(slot3?.getSortOrder()).toBe("newest"); // Still newest
	});
});
