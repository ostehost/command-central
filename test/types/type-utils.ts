/**
 * Re-export service interfaces for test usage
 *
 * These interfaces are defined in src/types/service-interfaces.ts
 * and re-exported here for convenient test imports.
 *
 * This follows best practices:
 * - Interfaces defined once in production code
 * - Tests import from a single location
 * - No duplication of interface definitions
 */

export type {
	IExtensionFilterState,
	IExtensionFilterViewManager,
	IGroupingOption,
	IGroupingStateManager,
	IGroupingTreeProvider,
	IGroupingViewManager,
	ILoggerService,
	IProjectViewManager,
	ISortedGitChangesProvider,
} from "../../src/types/service-interfaces.js";
