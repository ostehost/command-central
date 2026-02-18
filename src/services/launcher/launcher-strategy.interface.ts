/**
 * Launcher Strategy Interface
 *
 * Defines the contract for launcher strategy implementations.
 * Uses the Strategy Pattern to allow runtime selection of launcher behavior.
 *
 * Available Strategies:
 * - UserLauncherStrategy: Uses user-configured launcher path
 * - BundledLauncherStrategy: Uses bundled binary (macOS only)
 * - SystemLauncherStrategy: Uses system terminal (open -a)
 *
 * @see src/types/launcher-config.ts for type definitions
 * @see src/services/launcher/launcher-strategy-factory.ts for factory
 */

import type {
	LauncherInfo,
	LauncherValidationResult,
	LaunchResult,
} from "../../types/launcher-config.js";

/**
 * Spawn result type - minimal interface compatible with both real spawn and mocks
 */
export interface SpawnResult {
	pid?: number;
	unref: () => void;
}

/**
 * Spawn options type - minimal interface for strategy usage
 */
export interface SpawnOptions {
	detached?: boolean;
	stdio?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * Spawn function type for dependency injection
 * Allows tests to inject mock spawn while production uses real spawn
 */
export type SpawnFunction = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => SpawnResult;

/**
 * Strategy identifier type
 */
export type StrategyId = "bundled" | "user" | "system" | "disabled";

/**
 * Strategy interface for launcher implementations
 *
 * Follows Strategy Pattern for runtime launcher selection.
 * Each implementation handles a specific launcher type.
 *
 * @example
 * ```typescript
 * const strategy = factory.createStrategy(config);
 * if (await strategy.isAvailable()) {
 *   const result = await strategy.launch('/path/to/project');
 * }
 * ```
 */
export interface ILauncherStrategy {
	/**
	 * Unique identifier for this strategy
	 */
	readonly strategyId: StrategyId;

	/**
	 * Check if this strategy is available on current platform/config
	 *
	 * Used for auto-detection and fallback logic.
	 * Should be fast and not perform expensive operations.
	 *
	 * @returns true if strategy can be used
	 */
	isAvailable(): Promise<boolean>;

	/**
	 * Get information about this launcher for audit/logging
	 *
	 * @returns Launcher info including type, path, and version
	 */
	getInfo(): LauncherInfo;

	/**
	 * Execute the launcher with specified working directory
	 *
	 * @param workingDir - Directory to open terminal in
	 * @param env - Optional additional environment variables
	 * @returns Result including success status and process ID
	 */
	launch(workingDir: string, env?: NodeJS.ProcessEnv): Promise<LaunchResult>;

	/**
	 * Validate launcher is properly configured and accessible
	 *
	 * Performs thorough validation and returns detailed result
	 * for error messaging to users.
	 *
	 * @returns Validation result with isValid flag and message
	 */
	validate(): Promise<LauncherValidationResult>;
}

/**
 * Context provided to strategy implementations
 *
 * Contains dependencies and configuration needed by strategies.
 */
export interface LauncherStrategyContext {
	/** Extension path for resolving bundled resources */
	extensionPath: string;
	/** Process manager for tracking spawned processes */
	processManager: {
		track(pid: number): void;
	};
	/** Logger for debugging */
	logger: {
		debug(message: string, ...args: unknown[]): void;
		info(message: string, ...args: unknown[]): void;
		warn(message: string, ...args: unknown[]): void;
		error(message: string, error?: Error): void;
	};
	/** Security service for audit logging */
	securityService: {
		auditLog(
			command: string,
			args: string[],
			result: { success: boolean; error?: string },
		): void;
	};
	/** Optional spawn function override for testing */
	spawn?: SpawnFunction;
}
