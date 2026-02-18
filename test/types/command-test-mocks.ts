/**
 * Type-safe mock factories for command tests
 *
 * This file provides properly typed mocks for command tests, eliminating
 * the need for `any` types in test/commands/ files.
 *
 * Usage:
 *   import { createMockTerminalLauncherService } from "../types/command-test-mocks.js";
 *   const mockService = createMockTerminalLauncherService();
 */

import { mock } from "bun:test";
import type { GitSorter } from "../../src/git-sort/scm-sorter.js";
import type { TerminalLauncherService } from "../../src/services/terminal-launcher-service.js";
import type {
	IExtensionFilterState,
	IExtensionFilterViewManager,
	ILoggerService,
	IProjectViewManager,
	ISortedGitChangesProvider,
} from "./type-utils.js";

// ============================================================================
// Mock Types
// ============================================================================

export interface MockOutputChannel {
	appendLine: ReturnType<typeof mock>;
	clear: ReturnType<typeof mock>;
	dispose: ReturnType<typeof mock>;
	name?: string;
	append?: ReturnType<typeof mock>;
	show?: ReturnType<typeof mock>;
	hide?: ReturnType<typeof mock>;
	replace?: ReturnType<typeof mock>;
}

export interface MockSecurityService {
	getOutputChannel: ReturnType<typeof mock>;
	validatePath?: ReturnType<typeof mock>;
	validateCommand?: ReturnType<typeof mock>;
}

export interface MockTerminalLauncherService {
	launch: ReturnType<typeof mock>;
	getSecurityService: ReturnType<typeof mock>;
	getLaunchedProcesses?: ReturnType<typeof mock>;
	killProcess?: ReturnType<typeof mock>;
	killAllProcesses?: ReturnType<typeof mock>;
	configureProject?: ReturnType<typeof mock>;
	launchHere?: ReturnType<typeof mock>;
	launchWorkspace?: ReturnType<typeof mock>;
	listLaunchers?: ReturnType<typeof mock>;
	removeLauncher?: ReturnType<typeof mock>;
	removeAllLaunchers?: ReturnType<typeof mock>;
}

export interface MockProjectViewManager {
	isReloading: ReturnType<typeof mock>;
	getAllProviders: ReturnType<typeof mock>;
	getAllWorkspaceDisplayNames: ReturnType<typeof mock>;
	getProviderForTreeView?: ReturnType<typeof mock>;
	getProviderForWorkspace?: ReturnType<typeof mock>;
	getAllTreeViews?: ReturnType<typeof mock>;
}

export interface MockExtensionFilterState {
	getEnabledExtensions: ReturnType<typeof mock>;
	setEnabledExtensions?: ReturnType<typeof mock>;
	toggleExtension?: ReturnType<typeof mock>;
	clearExtensions?: ReturnType<typeof mock>;
}

export interface MockViewManager {
	isVisible: ReturnType<typeof mock>;
	hasDataPopulated: ReturnType<typeof mock>;
	toggle: ReturnType<typeof mock>;
	updateData: ReturnType<typeof mock>;
	subscribeToProviders: ReturnType<typeof mock>;
	show?: ReturnType<typeof mock>;
	hide?: ReturnType<typeof mock>;
}

export interface MockLogger {
	info: ReturnType<typeof mock>;
	debug: ReturnType<typeof mock>;
	warn: ReturnType<typeof mock>;
	error: ReturnType<typeof mock>;
}

export interface MockSCMSorter {
	enable: ReturnType<typeof mock>;
	disable: ReturnType<typeof mock>;
	activate: ReturnType<typeof mock>;
	isEnabled?: ReturnType<typeof mock>;
	getState?: ReturnType<typeof mock>;
}

// ============================================================================
// Mock Factory Functions
// ============================================================================

/**
 * Create a mock OutputChannel
 */
export function createMockOutputChannel(): MockOutputChannel {
	return {
		appendLine: mock(),
		clear: mock(),
		dispose: mock(),
		name: "Test Output",
		append: mock(),
		show: mock(),
		hide: mock(),
		replace: mock(),
	};
}

/**
 * Create a mock SecurityService
 */
export function createMockSecurityService(
	outputChannel?: MockOutputChannel,
): MockSecurityService {
	const channel = outputChannel || createMockOutputChannel();
	return {
		getOutputChannel: mock(() => channel),
		validatePath: mock(() => true),
		validateCommand: mock(() => true),
	};
}

/**
 * Create a mock TerminalLauncherService
 */
export function createMockTerminalLauncherService(
	securityService?: MockSecurityService,
): TerminalLauncherService {
	const security = securityService || createMockSecurityService();
	return {
		launch: mock(() =>
			Promise.resolve({ success: true, pid: 12345, error: null }),
		),
		getSecurityService: mock(() => security),
		getLaunchedProcesses: mock(() => []),
		killProcess: mock(() => Promise.resolve(true)),
		killAllProcesses: mock(() => Promise.resolve()),
		configureProject: mock(() => Promise.resolve()),
		launchHere: mock(() =>
			Promise.resolve({ success: true, pid: 12345, error: undefined }),
		),
		launchWorkspace: mock(() =>
			Promise.resolve({ success: true, pid: 12345, error: undefined }),
		),
		listLaunchers: mock(() =>
			Promise.resolve(["project1", "project2", "project3"]),
		),
		removeLauncher: mock(() => Promise.resolve(true)),
		removeAllLaunchers: mock(() => Promise.resolve(true)),
		validateLauncherInstallation: mock(() => Promise.resolve({ valid: true })),
		dispose: mock(),
	} as unknown as TerminalLauncherService;
}

/**
 * Create a mock ProjectViewManager
 * Returns interface type extracted from class - no type assertions needed
 */
export function createMockProjectViewManager(): IProjectViewManager {
	return {
		getAllProviders: mock<
			() => Array<{
				provider: ISortedGitChangesProvider;
				slotId: string;
			}>
		>(() => []),
		isReloading: mock<() => boolean>(() => false),
		getAllWorkspaceDisplayNames: mock<() => Map<string, string>>(
			() => new Map<string, string>(),
		),
	};
}

/**
 * Create a mock ExtensionFilterState
 * Returns interface type extracted from class - no type assertions needed
 */
export function createMockExtensionFilterState(): IExtensionFilterState {
	return {
		getEnabledExtensions: mock<(workspace: string) => Set<string>>(
			() => new Set<string>(),
		),
		isFiltered: mock<(workspace: string) => boolean>(() => false),
		setExtensionEnabled:
			mock<(workspace: string, ext: string, enabled: boolean) => void>(),
		validateAndCleanFilter: mock<
			(workspace: string, actualFiles: string[]) => boolean
		>(() => false),
	};
}

/**
 * Create a mock ViewManager
 * Returns interface type extracted from class - no type assertions needed
 */
export function createMockViewManager(): IExtensionFilterViewManager {
	return {
		isVisible: mock<() => boolean>(() => false),
		hasDataPopulated: mock<() => boolean>(() => false),
		toggle: mock<() => Promise<void>>(() => Promise.resolve()),
		updateData: mock<
			(
				extensionData: import("../../src/utils/extension-discovery.js").FileExtensionInfo[],
				stateManager: import("../../src/state/filter-state-manager.js").FilterStateManager,
				workspaceDisplayNames: Map<string, string>,
				onCheckboxChange?: (
					event: import("vscode").TreeCheckboxChangeEvent<
						import("../../src/providers/extension-filter-tree-provider.js").FilterNode
					>,
				) => void,
			) => Promise<void>
		>(() => Promise.resolve()),
		subscribeToProviders:
			mock<
				(
					providers: Array<{
						provider: ISortedGitChangesProvider;
						slotId: string;
					}>,
					workspaceDisplayNames: Map<string, string>,
				) => void
			>(),
		dispose: mock<() => void>(),
	};
}

/**
 * Create a mock Logger
 * Returns interface type extracted from class - no type assertions needed
 */
export function createMockLogger(): ILoggerService {
	return {
		info: mock<(message: string, context?: string) => void>(),
		debug:
			mock<
				(
					message: string,
					context?: string,
					data?: Record<string, unknown>,
				) => void
			>(),
		warn: mock<
			(
				message: string,
				context?: string,
				data?: Record<string, unknown>,
			) => void
		>(),
		error:
			mock<(message: string, errorObj?: Error, context?: string) => void>(),
		setLogLevel:
			mock<
				(level: import("../../src/services/logger-service.js").LogLevel) => void
			>(),
		getLogLevel: mock<
			() => import("../../src/services/logger-service.js").LogLevel
		>(() => 1), // LogLevel.INFO
	};
}

/**
 * Create a mock SCMSorter
 */
export function createMockSCMSorter(): GitSorter {
	return {
		enable: mock(),
		disable: mock(),
		activate: mock(() => Promise.resolve()),
		isEnabled: mock(() => false),
		getState: mock(() => ({ enabled: false })),
	} as unknown as GitSorter;
}

// ============================================================================
// Helper Types
// ============================================================================

/**
 * Helper type for creating complete mock services
 */
export interface CommandTestMocks {
	outputChannel: MockOutputChannel;
	securityService: MockSecurityService;
	terminalLauncherService: MockTerminalLauncherService;
	projectViewManager: MockProjectViewManager;
	extensionFilterState: MockExtensionFilterState;
	viewManager: MockViewManager;
	logger: MockLogger;
	scmSorter: MockSCMSorter;
}

/**
 * Create a complete set of mocks for command tests
 */
export function createCommandTestMocks(): CommandTestMocks {
	const outputChannel = createMockOutputChannel();
	const securityService = createMockSecurityService(outputChannel);

	return {
		outputChannel,
		securityService,
		terminalLauncherService: {
			launch: mock(() =>
				Promise.resolve({ success: true, pid: 12345, error: undefined }),
			),
			launchHere: mock(() =>
				Promise.resolve({ success: true, pid: 12345, error: undefined }),
			),
			launchWorkspace: mock(() =>
				Promise.resolve({ success: true, pid: 12345, error: undefined }),
			),
			getSecurityService: mock(() => securityService),
			getLaunchedProcesses: mock(() => []),
			killProcess: mock(() => Promise.resolve(true)),
			killAllProcesses: mock(() => Promise.resolve()),
			configureProject: mock(() => Promise.resolve()),
			listLaunchers: mock(() =>
				Promise.resolve(["project1", "project2", "project3"]),
			),
			removeLauncher: mock(() => Promise.resolve(true)),
			removeAllLaunchers: mock(() => Promise.resolve(true)),
		} as MockTerminalLauncherService,
		projectViewManager: {
			getAllProviders: mock(() => []),
			getAllWorkspaceDisplayNames: mock(() => new Map()),
			isReloading: mock(() => false),
		} as MockProjectViewManager,
		extensionFilterState: {
			getEnabledExtensions: mock(() => new Set<string>()),
			isFiltered: mock(() => false),
			setExtensionEnabled: mock(),
			validateAndCleanFilter: mock(() => false),
		} as MockExtensionFilterState,
		viewManager: {
			isVisible: mock(() => false),
			hasDataPopulated: mock(() => false),
			toggle: mock(() => Promise.resolve()),
			updateData: mock(() => Promise.resolve()),
			subscribeToProviders: mock(),
		} as MockViewManager,
		logger: {
			info: mock(),
			debug: mock(),
			warn: mock(),
			error: mock(),
		} as MockLogger,
		scmSorter: {
			enable: mock(),
			disable: mock(),
			activate: mock(() => Promise.resolve()),
			isEnabled: mock(() => false),
			getState: mock(() => ({ enabled: false })),
		} as MockSCMSorter,
	};
}
