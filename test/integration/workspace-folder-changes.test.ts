/**
 * Workspace Folder Changes Integration Tests
 *
 * Tests that views are correctly updated when workspace folders are added or removed.
 * Verifies the reload mechanism and debouncing behavior.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as vscode from "vscode";
import type { ProjectConfigSource } from "../../src/config/project-config-source.js";
import type { ProjectViewConfig } from "../../src/config/project-views.js";
import type { ProviderFactory } from "../../src/factories/provider-factory.js";
import type { SortedGitChangesProvider } from "../../src/git-sort/sorted-changes-provider.js";
import type { LoggerService } from "../../src/services/logger-service.js";
import { ProjectViewManager } from "../../src/services/project-view-manager.js";

// Mock logger
const mockLogger: LoggerService = {
	debug: mock(() => {}),
	info: mock(() => {}),
	warn: mock(() => {}),
	error: mock(() => {}),
	setLevel: mock(() => {}),
} as unknown as LoggerService;

// Mock extension context
const mockContext: vscode.ExtensionContext = {
	subscriptions: [],
	globalStorageUri: vscode.Uri.file("/tmp/test-storage"),
} as unknown as vscode.ExtensionContext;

// Mock provider
const createMockProvider = (): SortedGitChangesProvider => {
	return {
		initialize: mock(async () => {}),
		dispose: mock(async () => {}),
		refresh: mock(() => {}),
		getChildren: mock(async () => []),
		getTreeItem: mock(() => ({})),
		onDidChangeTreeData: mock(() => ({ dispose: () => {} })),
	} as unknown as SortedGitChangesProvider;
};

describe("Workspace Folder Changes", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("registering projects creates correct number of views", async () => {
		// Mock config source with 2 projects
		const mockConfigSource: ProjectConfigSource = {
			loadProjects: mock(
				async (): Promise<ProjectViewConfig[]> => [
					{
						id: "slot1",
						displayName: "Frontend",
						iconPath: "resources/icons/icon1.svg",
						gitPath: "/workspace/frontend",
						sortOrder: 1,
					},
					{
						id: "slot2",
						displayName: "Backend",
						iconPath: "resources/icons/icon2.svg",
						gitPath: "/workspace/backend",
						sortOrder: 2,
					},
				],
			),
		};

		const mockProviderFactory: ProviderFactory = {
			createProvider: mock(async () => createMockProvider()),
			dispose: mock(async () => {}),
			getProviderForFile: mock((_fileUri: vscode.Uri) => undefined),
		};

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		// Should have created 2 providers (one per project)
		expect(mockProviderFactory.createProvider).toHaveBeenCalledTimes(2);

		// Should have logged successful registration
		const infoCalls = (mockLogger.info as ReturnType<typeof mock>).mock.calls;
		const registrationLog = infoCalls.some((call: unknown[]) =>
			call[0]?.toString().includes("Successfully registered 2 project views"),
		);
		expect(registrationLog).toBe(true);
	});

	test("reload disposes old providers and re-registers", async () => {
		let projectCount = 2;

		const mockConfigSource: ProjectConfigSource = {
			loadProjects: mock(async (): Promise<ProjectViewConfig[]> => {
				const projects: ProjectViewConfig[] = [];
				for (let i = 0; i < projectCount; i++) {
					projects.push({
						id: `slot${i + 1}`,
						displayName: `Project ${i + 1}`,
						iconPath: `resources/icons/icon${i + 1}.svg`,
						gitPath: `/workspace/project${i + 1}`,
						sortOrder: i + 1,
					});
				}
				return projects;
			}),
		};

		const providers: SortedGitChangesProvider[] = [];
		const mockProviderFactory: ProviderFactory = {
			createProvider: mock(async () => {
				const provider = createMockProvider();
				providers.push(provider);
				return provider;
			}),
			dispose: mock(async () => {
				// Dispose all tracked providers
				for (const p of providers) {
					await p.dispose();
				}
				providers.length = 0;
			}),
			getProviderForFile: mock((_fileUri: vscode.Uri) => undefined),
		};

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		// Initial registration
		await manager.registerAllProjects();
		expect(mockProviderFactory.createProvider).toHaveBeenCalledTimes(2);

		// Change project count (simulate workspace folder change)
		projectCount = 3;

		// Reload
		await manager.reload();

		// Should have disposed old providers
		expect(mockProviderFactory.dispose).toHaveBeenCalledTimes(1);

		// Should have created new providers (2 + 3 = 5 total calls)
		expect(mockProviderFactory.createProvider).toHaveBeenCalledTimes(5);

		// Verify reload log message
		const infoCalls = (mockLogger.info as ReturnType<typeof mock>).mock.calls;
		const reloadLog = infoCalls.some((call: unknown[]) =>
			call[0]?.toString().includes("Reloading project views"),
		);
		expect(reloadLog).toBe(true);
	});

	test("reload prevents concurrent executions", async () => {
		const mockConfigSource: ProjectConfigSource = {
			loadProjects: mock(async (): Promise<ProjectViewConfig[]> => {
				// Add delay to test concurrency
				await new Promise((resolve) => setTimeout(resolve, 100));
				return [
					{
						id: "slot1",
						displayName: "Project",
						iconPath: "resources/icons/icon1.svg",
						gitPath: "/workspace/project",
						sortOrder: 1,
					},
				];
			}),
		};

		const mockProviderFactory: ProviderFactory = {
			createProvider: mock(async () => createMockProvider()),
			dispose: mock(async () => {}),
			getProviderForFile: mock((_fileUri: vscode.Uri) => undefined),
		};

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		// Initial registration
		await manager.registerAllProjects();

		// Trigger multiple concurrent reloads
		const reload1 = manager.reload();
		const reload2 = manager.reload();
		const reload3 = manager.reload();

		await Promise.all([reload1, reload2, reload3]);

		// Should have only reloaded once (first call)
		// Second and third calls should be blocked
		const debugCalls = (mockLogger.debug as ReturnType<typeof mock>).mock.calls;
		const blockedCalls = debugCalls.filter((call: unknown[]) =>
			call[0]?.toString().includes("Reload already in progress"),
		);

		expect(blockedCalls.length).toBeGreaterThanOrEqual(1);
	});

	test("dispose cleans up all views", () => {
		const mockConfigSource: ProjectConfigSource = {
			loadProjects: mock(async () => []),
		};

		const mockProviderFactory: ProviderFactory = {
			createProvider: mock(async () => createMockProvider()),
			dispose: mock(async () => {}),
			getProviderForFile: mock((_fileUri: vscode.Uri) => undefined),
		};

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		// Dispose should not throw
		expect(() => manager.dispose()).not.toThrow();

		// Should have logged disposal
		const infoCalls = (mockLogger.info as ReturnType<typeof mock>).mock.calls;
		const disposalLog = infoCalls.some((call: unknown[]) =>
			call[0]?.toString().includes("Disposing project view manager"),
		);
		expect(disposalLog).toBe(true);
	});

	test("views are properly registered in both Activity Bar and Panel", async () => {
		const mockConfigSource: ProjectConfigSource = {
			loadProjects: mock(
				async (): Promise<ProjectViewConfig[]> => [
					{
						id: "slot1",
						displayName: "Test Project",
						iconPath: "resources/icons/icon1.svg",
						gitPath: "/workspace/test",
						sortOrder: 1,
					},
				],
			),
		};

		const mockProviderFactory: ProviderFactory = {
			createProvider: mock(async () => createMockProvider()),
			dispose: mock(async () => {}),
			getProviderForFile: mock((_fileUri: vscode.Uri) => undefined),
		};

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);

		await manager.registerAllProjects();

		// Should have logged registration for both containers
		const debugCalls = (mockLogger.debug as ReturnType<typeof mock>).mock.calls;
		const activityBarLog = debugCalls.some((call: unknown[]) =>
			call[0]?.toString().includes("Activity Bar"),
		);
		const panelLog = debugCalls.some((call: unknown[]) =>
			call[0]?.toString().includes("Panel"),
		);

		expect(activityBarLog).toBe(true);
		expect(panelLog).toBe(true);
	});
});
