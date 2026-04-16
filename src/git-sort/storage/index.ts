/**
 * Storage Module Exports
 *
 * Uses VS Code's native workspaceState for persistence.
 * Zero external dependencies.
 */

export type { DatabaseStats, StorageAdapter } from "./storage-adapter.js";
export { WorkspaceStateStorageAdapter } from "./workspace-state-storage-adapter.js";
