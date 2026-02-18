/**
 * Project Configuration Source Abstraction
 *
 * This module defines how project configurations are loaded.
 * The abstraction allows easy migration between data sources:
 * - Phase 1: Workspace folder auto-discovery
 * - Phase 2: Per-project git repositories
 * - Future: SQLite database or remote API
 *
 * Requirements:
 * - REQ-DM-002: Configuration sources
 * - REQ-AR-001: Source-agnostic architecture
 * - REQ-TEST-001: Testable abstractions
 */

import type { ProjectViewConfig } from "./project-views.js";

/**
 * Abstract interface for loading project configurations
 *
 * This abstraction enables:
 * - Easy testing with mock implementations
 * - Source-agnostic project loading
 * - Migration path without refactoring consumers
 */
export interface ProjectConfigSource {
	/**
	 * Load all project configurations for the current context
	 *
	 * @returns Promise resolving to array of project configurations
	 */
	loadProjects(): Promise<ProjectViewConfig[]>;
}
