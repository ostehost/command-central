/**
 * Tests for active file tracking in ProjectViewManager
 *
 * Bug: Clicking a file in either the sidebar or bottom panel forces the OTHER
 * panel to open. The root cause is setupActiveFileTracking() calling
 * treeView.reveal() on ALL registered views without checking visibility.
 *
 * These tests verify that:
 * 1. reveal() is only called on VISIBLE views
 * 2. Hidden/collapsed panels are not forced open by cross-view sync
 * 3. The trackActiveFile setting is respected
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type * as vscode from "vscode";
import type { ProjectConfigSource } from "../../src/config/project-config-source.js";
import type { ProjectViewConfig } from "../../src/config/project-views.js";
import type { ProviderFactory } from "../../src/factories/provider-factory.js";
import type { SortedGitChangesProvider } from "../../src/git-sort/sorted-changes-provider.js";
import type { LoggerService } from "../../src/services/logger-service.js";
import { createMockExtensionContext, createMockUri } from "../helpers/typed-mocks.js";

// Capture the onDidChangeActiveTextEditor callback so we can trigger it manually
let activeEditorCallback: ((editor: vscode.TextEditor | undefined) => void) | null = null;

// Track reveal calls per view
const revealCalls = new Map<string, Array<{ item: unknown; options: unknown }>>();

// Track tree view visibility per view
const viewVisibility = new Map<string, boolean>();

function createMockLogger(): LoggerService {
	return {
		debug: mock(() => {}),
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		setLevel: mock(() => {}),
	} as unknown as LoggerService;
}

function setupTestVSCodeMock() {
	const vscodeMock = {
		RelativePattern: class {
			constructor(public base: unknown, public pattern: string) {}
		},
		workspace: {
			createFileSystemWatcher: mock(() => ({
				onDidChange: mock(() => ({ dispose: mock() })),
				onDidCreate: mock(() => ({ dispose: mock() })),
				onDidDelete: mock(() => ({ dispose: mock() })),
				dispose: mock(),
			})),
			getConfiguration: mock(() => ({
				get: mock((_key: string, defaultValue?: unknown) => defaultValue),
			})),
			onDidChangeConfiguration: mock(() => ({ dispose: mock() })),
			asRelativePath: mock((uri: string | { fsPath: string }) =>
				typeof uri === "string" ? uri : uri?.fsPath || "",
			),
		},
		TreeItem: class {
			public description?: string;
			public tooltip?: string;
			public contextValue?: string;
			public resourceUri?: unknown;
			public command?: unknown;
			public iconPath?: unknown;
			constructor(public label: string, public collapsibleState?: number) {}
		},
		TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
		ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
		ThemeIcon: class {
			constructor(public id: string, public color?: unknown) {}
			static File = { id: "file" };
		},
		ThemeColor: class {
			constructor(public id: string) {}
		},
		MarkdownString: class {
			constructor(public value: string) {}
		},
		Uri: {
			file: (path: string) => createMockUri(path),
			parse: (str: string) => createMockUri(str),
			joinPath: (base: { fsPath: string }, ...segments: string[]) =>
				createMockUri(`${base.fsPath}/${segments.join("/")}`),
		},
		extensions: { getExtension: mock(() => undefined) },
		commands: {
			executeCommand: mock(() => Promise.resolve()),
			registerCommand: mock(
				(_id: string, _handler: (...args: unknown[]) => unknown) => ({
					dispose: mock(() => {}),
				}),
			),
		},
		window: {
			showInformationMessage: mock(),
			showWarningMessage: mock(),
			showErrorMessage: mock(),
			setStatusBarMessage: mock(() => ({ dispose: mock() })),
			createOutputChannel: mock(() => ({
				append: mock(),
				appendLine: mock(),
				clear: mock(),
				show: mock(),
				hide: mock(),
				dispose: mock(),
			})),
			createTreeView: mock((viewId: string, _options: unknown) => {
				revealCalls.set(viewId, []);
				viewVisibility.set(viewId, true); // Default to visible

				const treeView = {
					title: "",
					description: "",
					get visible() {
						return viewVisibility.get(viewId) ?? true;
					},
					reveal: mock(async (item: unknown, options?: unknown) => {
						revealCalls.get(viewId)?.push({ item, options });
					}),
					onDidChangeVisibility: mock(() => ({ dispose: mock() })),
					onDidChangeSelection: mock(() => ({ dispose: mock() })),
					dispose: mock(),
				};
				return treeView;
			}),
			onDidChangeActiveTextEditor: mock((callback: (editor: vscode.TextEditor | undefined) => void) => {
				activeEditorCallback = callback;
				return { dispose: mock() };
			}),
			onDidChangeVisibleTextEditors: mock(() => ({ dispose: mock() })),
			showQuickPick: mock(() => Promise.resolve(undefined)),
		},
		EventEmitter: class<T = unknown> {
			private listeners: Array<(e: T) => void> = [];
			fire(data: T): void {
				for (const listener of this.listeners) listener(data);
			}
			get event() {
				return (listener: (e: T) => void) => {
					this.listeners.push(listener);
					return {
						dispose: () => {
							const idx = this.listeners.indexOf(listener);
							if (idx > -1) this.listeners.splice(idx, 1);
						},
					};
				};
			}
			dispose(): void {
				this.listeners = [];
			}
		},
	};

	mock.module("vscode", () => vscodeMock);
	return vscodeMock;
}

// Mock provider that returns an item for a specific URI
function createTrackingProvider(matchUri?: string): SortedGitChangesProvider {
	const mockItem = { uri: matchUri ? createMockUri(matchUri) : undefined, label: "test-file.ts" };
	return {
		initialize: mock(async () => {}),
		dispose: mock(async () => {}),
		refresh: mock(() => {}),
		getChildren: mock(async () => []),
		getTreeItem: mock(() => ({})),
		onDidChangeTreeData: mock(() => ({ dispose: () => {} })),
		setSortOrder: mock(() => {}),
		getSortOrder: mock(() => "newest" as const),
		setFileTypeFilter: mock(() => {}),
		setProjectIcon: mock(() => {}),
		setActivityBarTreeView: mock(() => {}),
		setPanelTreeView: mock(() => {}),
		findItemByUri: mock((uri: { fsPath: string }) => {
			if (matchUri && uri.fsPath === matchUri) return mockItem;
			return undefined;
		}),
	} as unknown as SortedGitChangesProvider;
}

describe("Active File Tracking - Panel Force-Open Bug", () => {
	let mockLogger: LoggerService;
	let mockContext: vscode.ExtensionContext;
	let vscodeMock: ReturnType<typeof setupTestVSCodeMock>;

	beforeEach(() => {
		mock.restore();
		activeEditorCallback = null;
		revealCalls.clear();
		viewVisibility.clear();
		vscodeMock = setupTestVSCodeMock();
		mockLogger = createMockLogger();
		mockContext = createMockExtensionContext();
	});

	/**
	 * Core bug test: clicking a file in bottom panel should NOT reveal in sidebar
	 *
	 * Scenario: User has sidebar collapsed. They click a file in the bottom panel.
	 * The bottom panel's tree view is visible, but the sidebar's tree view is NOT.
	 * reveal() should only be called on the visible (bottom panel) view.
	 */
	test("does NOT reveal in hidden sidebar when file opened from bottom panel", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const filePath = "/workspace/frontend/src/app.ts";
		const provider = createTrackingProvider(filePath);

		const mockConfigSource: ProjectConfigSource = {
			loadProjects: mock(async (): Promise<ProjectViewConfig[]> => [
				{
					id: "slot1",
					displayName: "Frontend",
					iconPath: "resources/icons/icon1.svg",
					gitPath: "/workspace/frontend",
					sortOrder: 1,
				},
			]),
		};

		const mockProviderFactory: ProviderFactory = {
			createProvider: mock(async () => provider),
			dispose: mock(async () => {}),
			getProviderForFile: mock(() => undefined),
		} as unknown as ProviderFactory;

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);
		await manager.registerAllProjects();

		// Sidebar view is HIDDEN, panel view is VISIBLE
		viewVisibility.set("commandCentral.project.slot1", false);
		viewVisibility.set("commandCentral.project.slot1Panel", true);

		// Simulate opening a file (triggers onDidChangeActiveTextEditor)
		expect(activeEditorCallback).not.toBeNull();
		await activeEditorCallback!({
			document: { uri: createMockUri(filePath) },
		} as unknown as vscode.TextEditor);

		// Panel view should have reveal called (it's visible)
		const panelReveals = revealCalls.get("commandCentral.project.slot1Panel") || [];
		expect(panelReveals.length).toBe(1);

		// Sidebar view should NOT have reveal called (it's hidden)
		const sidebarReveals = revealCalls.get("commandCentral.project.slot1") || [];
		expect(sidebarReveals.length).toBe(0);
	});

	/**
	 * Inverse of the core bug: clicking in sidebar should NOT reveal in bottom panel
	 */
	test("does NOT reveal in hidden bottom panel when file opened from sidebar", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const filePath = "/workspace/frontend/src/app.ts";
		const provider = createTrackingProvider(filePath);

		const mockConfigSource: ProjectConfigSource = {
			loadProjects: mock(async (): Promise<ProjectViewConfig[]> => [
				{
					id: "slot1",
					displayName: "Frontend",
					iconPath: "resources/icons/icon1.svg",
					gitPath: "/workspace/frontend",
					sortOrder: 1,
				},
			]),
		};

		const mockProviderFactory: ProviderFactory = {
			createProvider: mock(async () => provider),
			dispose: mock(async () => {}),
			getProviderForFile: mock(() => undefined),
		} as unknown as ProviderFactory;

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);
		await manager.registerAllProjects();

		// Sidebar view is VISIBLE, panel view is HIDDEN
		viewVisibility.set("commandCentral.project.slot1", true);
		viewVisibility.set("commandCentral.project.slot1Panel", false);

		await activeEditorCallback!({
			document: { uri: createMockUri(filePath) },
		} as unknown as vscode.TextEditor);

		// Sidebar should have reveal called (it's visible)
		const sidebarReveals = revealCalls.get("commandCentral.project.slot1") || [];
		expect(sidebarReveals.length).toBe(1);

		// Panel should NOT have reveal called (it's hidden)
		const panelReveals = revealCalls.get("commandCentral.project.slot1Panel") || [];
		expect(panelReveals.length).toBe(0);
	});

	/**
	 * When both views are visible, both should get reveal calls
	 */
	test("reveals in BOTH views when both are visible", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const filePath = "/workspace/frontend/src/app.ts";
		const provider = createTrackingProvider(filePath);

		const mockConfigSource: ProjectConfigSource = {
			loadProjects: mock(async (): Promise<ProjectViewConfig[]> => [
				{
					id: "slot1",
					displayName: "Frontend",
					iconPath: "resources/icons/icon1.svg",
					gitPath: "/workspace/frontend",
					sortOrder: 1,
				},
			]),
		};

		const mockProviderFactory: ProviderFactory = {
			createProvider: mock(async () => provider),
			dispose: mock(async () => {}),
			getProviderForFile: mock(() => undefined),
		} as unknown as ProviderFactory;

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);
		await manager.registerAllProjects();

		// Both views visible
		viewVisibility.set("commandCentral.project.slot1", true);
		viewVisibility.set("commandCentral.project.slot1Panel", true);

		await activeEditorCallback!({
			document: { uri: createMockUri(filePath) },
		} as unknown as vscode.TextEditor);

		const sidebarReveals = revealCalls.get("commandCentral.project.slot1") || [];
		const panelReveals = revealCalls.get("commandCentral.project.slot1Panel") || [];
		expect(sidebarReveals.length).toBe(1);
		expect(panelReveals.length).toBe(1);
	});

	/**
	 * When NEITHER view is visible, no reveal should happen at all
	 */
	test("does NOT reveal in any view when both are hidden", async () => {
		const { ProjectViewManager } = await import(
			"../../src/services/project-view-manager.js"
		);

		const filePath = "/workspace/frontend/src/app.ts";
		const provider = createTrackingProvider(filePath);

		const mockConfigSource: ProjectConfigSource = {
			loadProjects: mock(async (): Promise<ProjectViewConfig[]> => [
				{
					id: "slot1",
					displayName: "Frontend",
					iconPath: "resources/icons/icon1.svg",
					gitPath: "/workspace/frontend",
					sortOrder: 1,
				},
			]),
		};

		const mockProviderFactory: ProviderFactory = {
			createProvider: mock(async () => provider),
			dispose: mock(async () => {}),
			getProviderForFile: mock(() => undefined),
		} as unknown as ProviderFactory;

		const manager = new ProjectViewManager(
			mockContext,
			mockLogger,
			mockConfigSource,
			mockProviderFactory,
		);
		await manager.registerAllProjects();

		// Both views hidden
		viewVisibility.set("commandCentral.project.slot1", false);
		viewVisibility.set("commandCentral.project.slot1Panel", false);

		await activeEditorCallback!({
			document: { uri: createMockUri(filePath) },
		} as unknown as vscode.TextEditor);

		const sidebarReveals = revealCalls.get("commandCentral.project.slot1") || [];
		const panelReveals = revealCalls.get("commandCentral.project.slot1Panel") || [];
		expect(sidebarReveals.length).toBe(0);
		expect(panelReveals.length).toBe(0);
	});
});
