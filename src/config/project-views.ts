/**
 * Project View Configuration Types
 *
 * Defines the structure for dynamic project views loaded from workspace folders.
 *
 * Phase 1: Workspace folder auto-discovery
 * Phase 2: Per-project git repositories
 * Future: Extended metadata and customization options
 */

/**
 * Configuration for a single project view
 *
 * Requirements:
 * - REQ-DM-001: Defines configuration structure
 * - REQ-IM-001: Includes icon path for custom SVG icons
 */
export interface ProjectViewConfig {
	/** Unique identifier (alphanumeric, no spaces) */
	id: string;

	/** User-facing display name */
	displayName: string;

	/** Relative path to SVG icon (from extension root) */
	iconPath: string;

	/** Optional tooltip/description text */
	description?: string;

	/** Path to project-specific git repository (Phase 2) */
	gitPath?: string;

	/** Display order (lower numbers appear first) */
	sortOrder?: number;
}
