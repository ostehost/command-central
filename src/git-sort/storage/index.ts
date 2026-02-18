/**
 * Storage Module Exports
 *
 * PORTABILITY STRATEGY:
 * - All adapters implement the same StorageAdapter interface
 * - Easy to swap implementations in extension.ts
 * - Fallback from SQLite → sql.js → Mock if issues occur
 *
 * @public These exports are intentional for portability pattern
 */

/**
 * In-memory implementation (testing and fallback)
 * @public Exported for testing and fallback scenarios
 */
export { MockStorageAdapter } from "./mock-storage-adapter.js";

/**
 * Production implementation (native @vscode/sqlite3)
 * @public Exported as primary storage adapter
 */
export { SQLiteStorageAdapter } from "./sqlite-storage-adapter.js";
// Interface
export type { DatabaseStats, StorageAdapter } from "./storage-adapter.js";

/**
 * USAGE EXAMPLES:
 *
 * Production (desktop-only):
 * ```typescript
 * import { SQLiteStorageAdapter } from './storage';
 * const adapter = await SQLiteStorageAdapter.create(dbPath);
 * ```
 *
 * Testing:
 * ```typescript
 * import { MockStorageAdapter } from './storage';
 * const adapter = new MockStorageAdapter();
 * await adapter.initialize();
 * ```
 *
 * Fallback pattern (future):
 * ```typescript
 * import { SQLiteStorageAdapter, MockStorageAdapter } from './storage';
 *
 * let adapter;
 * try {
 *   adapter = await SQLiteStorageAdapter.create(dbPath);
 * } catch (error) {
 *   logger.warn('SQLite failed, using in-memory fallback', error);
 *   adapter = new MockStorageAdapter();
 *   await adapter.initialize();
 * }
 * ```
 */
