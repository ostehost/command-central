/**
 * Launcher Configuration Types
 *
 * Type definitions for the terminal launcher strategy system.
 * These types support the hybrid architecture that allows:
 * - User-configured launcher paths
 * - Bundled launcher (macOS only)
 * - System terminal fallback
 *
 * @see src/services/launcher/launcher-strategy.interface.ts for strategy interface
 */

/**
 * Launcher information for audit logging and status display
 */
export interface LauncherInfo {
	/** Which strategy was used */
	type: "bundled" | "user" | "system";
	/** Full path to the launcher binary/script */
	path: string;
	/** Version if available */
	version?: string;
	/** Integrity verification status (for bundled strategy) */
	verificationStatus?: "verified" | "unverified" | "skipped";
}

/**
 * Result of a launcher validation check
 */
export interface LauncherValidationResult {
	/** Whether the launcher is valid and ready */
	isValid: boolean;
	/** Human-readable message explaining the result */
	message?: string;
	/** Error code for programmatic handling */
	errorCode?: "ENOENT" | "EACCES" | "INTEGRITY" | "PLATFORM" | "CONFIG";
}

/**
 * Result of a launch operation
 */
export interface LaunchResult {
	/** Whether the launch succeeded */
	success: boolean;
	/** Process ID if launched successfully */
	pid?: number;
	/** Error message if launch failed */
	error?: string;
	/** Information about which launcher was used */
	launcherInfo: LauncherInfo;
}
