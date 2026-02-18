/**
 * Service Interface Definitions
 *
 * Extracted public interfaces from service classes to enable proper dependency injection
 * and testing without coupling to implementation details.
 *
 * Best Practice: "Program to interfaces, not implementations" (SOLID principles)
 *
 * These interfaces represent the public API contracts that services expose.
 * Using interfaces in function parameters enables:
 * - Proper mock creation without type assertions
 * - Loose coupling between modules
 * - Better testability
 * - Clear API contracts
 */

import type { SortedGitChangesProvider } from "../git-sort/sorted-changes-provider.js";
import type { SecurityService } from "../security/security-service.js";
import type { ExtensionFilterState } from "../services/extension-filter-state.js";
import type { LoggerService } from "../services/logger-service.js";

/**
 * Public interface for ExtensionFilterState service
 * Manages filter state for file extensions across workspaces
 */
export type IExtensionFilterState = Pick<
	ExtensionFilterState,
	| "getEnabledExtensions"
	| "isFiltered"
	| "setExtensionEnabled"
	| "validateAndCleanFilter"
>;

/**
 * Public interface for ExtensionFilterViewManager
 * Manages the Extension Filter TreeView lifecycle
 */
export interface IExtensionFilterViewManager {
	/**
	 * Check if the TreeView is currently visible
	 */
	isVisible(): boolean;
	/**
	 * Check if the TreeView has been populated with data
	 */
	hasDataPopulated(): boolean;
	/**
	 * Toggle TreeView visibility
	 */
	toggle(): Promise<void>;
	/**
	 * Update the TreeView with new extension data
	 */
	updateData(
		extensionData: import("../utils/extension-discovery.js").FileExtensionInfo[],
		stateManager: import("../state/filter-state-manager.js").FilterStateManager,
		workspaceDisplayNames: Map<string, string>,
		onCheckboxChange?: (
			event: import("vscode").TreeCheckboxChangeEvent<
				import("../providers/extension-filter-tree-provider.js").FilterNode
			>,
		) => void,
	): Promise<void>;
	/**
	 * Subscribe to provider refresh events
	 * Accepts interface type for better testability
	 */
	subscribeToProviders(
		providers: Array<{
			provider: ISortedGitChangesProvider;
			slotId: string;
		}>,
		workspaceDisplayNames: Map<string, string>,
	): void;
	/**
	 * Dispose of resources
	 */
	dispose(): void;
}

/**
 * Public interface for LoggerService
 * Provides structured logging with different levels
 */
export type ILoggerService = Pick<
	LoggerService,
	"debug" | "info" | "warn" | "error" | "setLogLevel" | "getLogLevel"
>;

/**
 * Public interface for SecurityService
 * Provides security validation for command execution
 */
export type ISecurityService = Pick<
	SecurityService,
	| "checkWorkspaceTrust"
	| "isCommandAllowed"
	| "validateCommand"
	| "getExecutionLimits"
	| "auditLog"
	| "sanitizePath"
	| "getOutputChannel"
	| "dispose"
>;

/**
 * Public interface for ProjectViewManager
 * Manages multiple workspace project views
 */
export interface IProjectViewManager {
	/**
	 * Get all providers across all workspaces
	 * Returns interface type instead of class type for better testability
	 */
	getAllProviders(): Array<{
		provider: ISortedGitChangesProvider;
		slotId: string;
	}>;
	/**
	 * Get workspace display names for all workspaces
	 */
	getAllWorkspaceDisplayNames(): Map<string, string>;
	/**
	 * Check if project views are currently reloading
	 */
	isReloading(): boolean;
}

/**
 * Public interface for SortedGitChangesProvider
 * Provides sorted Git change data
 */
export type ISortedGitChangesProvider = Pick<
	SortedGitChangesProvider,
	"getCurrentChanges" | "refresh"
>;

/**
 * Public interface for GroupingStateManager
 * Manages global state for Git status grouping feature
 *
 * Used for TDD testing pattern with dynamic imports
 */
export interface IGroupingStateManager {
	/**
	 * Check if Git status grouping is enabled
	 */
	isGroupingEnabled(): boolean;
	/**
	 * Enable or disable Git status grouping
	 */
	setGroupingEnabled(enabled: boolean): Promise<void>;
	/**
	 * Event fired when grouping state changes
	 */
	readonly onDidChangeGrouping: import("vscode").Event<boolean>;
	/**
	 * Dispose of resources
	 */
	dispose(): void;
}

/**
 * Grouping option type for tree provider
 */
export interface IGroupingOption {
	id: "none" | "gitStatus";
	label: string;
	description: string;
}

/**
 * Public interface for GroupingTreeProvider
 * Provides tree data for grouping options
 *
 * Used for TDD testing pattern with dynamic imports
 */
export interface IGroupingTreeProvider {
	/**
	 * Get tree item for display
	 */
	getTreeItem(
		element: IGroupingOption,
	): import("vscode").TreeItem | Thenable<import("vscode").TreeItem>;
	/**
	 * Get children elements
	 */
	getChildren(
		element?: IGroupingOption,
	): import("vscode").ProviderResult<IGroupingOption[]>;
	/**
	 * Get parent element (optional)
	 */
	getParent?(
		element: IGroupingOption,
	): import("vscode").ProviderResult<IGroupingOption>;
	/**
	 * Event fired when tree data changes
	 */
	readonly onDidChangeTreeData?: import("vscode").Event<
		IGroupingOption | undefined | null | undefined
	>;
	/**
	 * Select a grouping option
	 */
	selectOption(optionId: "none" | "gitStatus"): Promise<void>;
	/**
	 * Dispose of resources
	 */
	dispose(): void;
}

/**
 * Public interface for GroupingViewManager
 * Manages the Grouping Options TreeView lifecycle
 *
 * Used for TDD testing pattern with dynamic imports
 */
export interface IGroupingViewManager {
	/**
	 * Toggle view visibility
	 */
	toggle(): Promise<void>;
	/**
	 * Select a grouping option
	 */
	selectOption(optionId: "none" | "gitStatus"): Promise<void>;
	/**
	 * Dispose of resources
	 */
	dispose(): void;
}
