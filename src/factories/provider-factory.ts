/**
 * Provider Factory Abstraction
 *
 * This module defines how SortedGitChangesProvider instances are created.
 * The abstraction allows different provider strategies:
 * - Phase 1: SharedProviderFactory (all projects show same data)
 * - Phase 2: ProjectProviderFactory (each project shows different git repo)
 *
 * Requirements:
 * - REQ-DM-003: Shared provider pattern (Phase 1)
 * - REQ-AR-002: Provider lifecycle management
 * - REQ-TEST-002: Testable provider creation
 */

import * as vscode from "vscode";
import type { ProjectViewConfig } from "../config/project-views.js";
import type { SortedGitChangesProvider } from "../git-sort/sorted-changes-provider.js";
import { SortedGitChangesProvider as SortedGitChangesProviderImpl } from "../git-sort/sorted-changes-provider.js";
import {
	type StorageAdapter,
	WorkspaceStateStorageAdapter,
} from "../git-sort/storage/index.js";
import type { LoggerService } from "../services/logger-service.js";

/**
 * Abstract interface for creating SortedGitChangesProvider instances
 *
 * This abstraction enables:
 * - Shared vs per-project provider strategies
 * - Proper provider initialization and lifecycle
 * - Easy testing with mock providers
 * - Migration without refactoring consumers
 */
export interface ProviderFactory {
	/**
	 * Create or retrieve a provider for the given project configuration
	 *
	 * @param config - Project configuration
	 * @returns Promise resolving to initialized provider
	 */
	createProvider(config: ProjectViewConfig): Promise<SortedGitChangesProvider>;

	/**
	 * Find provider for a specific file
	 *
	 * Uses workspace path matching to find the provider responsible for a given file.
	 * Implements longest-match strategy for nested workspaces.
	 *
	 * @param fileUri - The file URI to find a provider for
	 * @returns Provider for the workspace containing this file, or undefined if not found
	 */
	getProviderForFile(fileUri: vscode.Uri): SortedGitChangesProvider | undefined;

	/**
	 * Clean up all created providers
	 * Called during extension deactivation
	 */
	dispose(): Promise<void>;
}

/**
 * NOTE: SharedProviderFactory (Phase 1 POC) was moved to legacy/unused-code/
 * on 2025-10-19. It was unused and replaced by ProjectProviderFactory below.
 * See legacy/unused-code/SharedProviderFactory.ts for the original implementation.
 */

/**
 * Phase 2 Implementation: Project Provider Factory
 *
 * Creates separate SortedGitChangesProvider for each workspace folder.
 * Each provider is bound to its own git repository and has isolated storage.
 *
 * Key Features:
 * - Per-workspace folder storage (stable database naming via path hashing)
 * - Each provider bound to specific workspace folder URI
 * - Deleted file orders isolated per workspace folder
 * - Graceful fallback to in-memory if storage creation fails
 */
import type { ExtensionFilterState } from "../services/extension-filter-state.js";
import type { GroupingStateManager } from "../services/grouping-state-manager.js";

export class ProjectProviderFactory implements ProviderFactory {
	private providers = new Map<string, SortedGitChangesProvider>();
	private providersByWorkspace = new Map<string, SortedGitChangesProvider>();
	// In-flight creation promises keyed by config.id (CP-04 / PAR-47).
	// createProvider awaits storage creation and provider.initialize() before
	// writing to `providers`, so without this guard two concurrent calls for the
	// same id both miss the cache, both build a provider, and one overwrites the
	// other in the map — the orphaned provider is then never disposed. Caching
	// the promise makes concurrent callers share a single instance.
	private inFlight = new Map<string, Promise<SortedGitChangesProvider>>();

	constructor(
		private logger: LoggerService,
		private context: vscode.ExtensionContext,
		private extensionFilterState?: ExtensionFilterState,
		private groupingStateManager?: GroupingStateManager,
	) {}

	createProvider(config: ProjectViewConfig): Promise<SortedGitChangesProvider> {
		// Check if provider already exists (fully created and tracked)
		const existing = this.providers.get(config.id);
		if (existing) {
			return Promise.resolve(existing);
		}

		// Coalesce concurrent calls for the same id onto one in-flight creation.
		// This synchronous check + set (before any await) closes the TOCTOU race
		// that otherwise let two callers build duplicate, untracked providers.
		const pending = this.inFlight.get(config.id);
		if (pending) {
			return pending;
		}

		// Always clear the in-flight entry once settled so a failed creation can
		// be retried and a successful one is served from `providers` thereafter.
		// `.finally` preserves the resolved provider, so every concurrent caller
		// receives the same instance.
		const creation = this.doCreateProvider(config).finally(() => {
			this.inFlight.delete(config.id);
		});
		this.inFlight.set(config.id, creation);
		return creation;
	}

	private async doCreateProvider(
		config: ProjectViewConfig,
	): Promise<SortedGitChangesProvider> {
		// Create per-workspace storage using VS Code's native workspaceState
		let storage: StorageAdapter | undefined;
		try {
			storage = await WorkspaceStateStorageAdapter.create(
				this.context.workspaceState,
			);
			this.logger.debug(
				`Created workspaceState storage for ${config.displayName}`,
			);
		} catch (error) {
			this.logger.error(
				`Failed to create storage for ${config.displayName}, using in-memory fallback:`,
				error,
			);
			storage = undefined;
		}

		// Create provider bound to specific workspace folder
		const workspaceUri = config.gitPath
			? vscode.Uri.file(config.gitPath)
			: undefined;

		const provider = new SortedGitChangesProviderImpl(
			this.logger,
			this.context,
			storage,
			workspaceUri, // Bind to workspace folder
			this.extensionFilterState, // Filter state for per-workspace filtering
			config.id, // Workspace ID for filter isolation
			this.groupingStateManager, // Grouping state manager for grouping UI
		);

		// Initialize provider
		await provider.initialize();

		this.providers.set(config.id, provider);

		// CRITICAL: Track provider by workspace path for file lookup
		if (config.gitPath) {
			this.providersByWorkspace.set(config.gitPath, provider);
		}

		this.logger.debug(
			`Created provider for ${config.displayName} (workspace: ${config.gitPath})`,
		);

		return provider;
	}

	getProviderForFile(
		fileUri: vscode.Uri,
	): SortedGitChangesProvider | undefined {
		// Normalize to forward slashes so Windows backslash fsPaths
		// (e.g. C:\repo\src\file.ts) still match their workspace key.
		// Both sides are normalized before the boundary/longest-match
		// comparison so containment is platform-independent (CP-16 / PAR-57).
		const filePath = fileUri.fsPath.replace(/\\/g, "/");

		// Find workspace using longest-match strategy (most specific wins)
		let bestMatch:
			| { path: string; provider: SortedGitChangesProvider }
			| undefined;

		for (const [
			workspacePath,
			provider,
		] of this.providersByWorkspace.entries()) {
			const normalizedWorkspace = workspacePath.replace(/\\/g, "/");

			// Check if file is within this workspace
			// IMPORTANT: Add path separator to prevent substring matches
			// e.g., /workspace1 should NOT match /workspace10
			const workspaceWithSep = normalizedWorkspace.endsWith("/")
				? normalizedWorkspace
				: `${normalizedWorkspace}/`;

			if (
				filePath.startsWith(workspaceWithSep) ||
				filePath === normalizedWorkspace
			) {
				// Choose longest match (most specific workspace)
				if (!bestMatch || normalizedWorkspace.length > bestMatch.path.length) {
					bestMatch = { path: normalizedWorkspace, provider };
				}
			}
		}

		return bestMatch?.provider;
	}

	async dispose(): Promise<void> {
		// Settle any in-flight creations first so a provider that finishes
		// initializing during disposal is tracked in `providers` and cleaned up
		// rather than leaking undisposed (CP-04 / PAR-47).
		if (this.inFlight.size > 0) {
			await Promise.allSettled(this.inFlight.values());
		}

		this.logger.debug(`Disposing ${this.providers.size} providers`);

		for (const [id, provider] of this.providers.entries()) {
			await provider.dispose();
			this.logger.debug(`Disposed provider: ${id}`);
		}

		this.inFlight.clear();
		this.providers.clear();
		this.providersByWorkspace.clear();
	}
}
