/**
 * SQLite Storage Adapter - Native Implementation
 *
 * Uses @vscode/sqlite3 for persistent storage of deleted file tracking data.
 *
 * PORTABILITY DESIGN:
 * - Implements StorageAdapter interface identically to MockStorageAdapter
 * - Easy fallback to sql.js if native modules cause issues
 * - All business logic abstracted behind interface
 *
 * FEATURES:
 * - Write-once audit log (INSERT OR IGNORE)
 * - WAL mode for better concurrency
 * - Automatic file persistence
 * - Platform-specific builds (darwin-arm64, etc.)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DeletedFileRecord } from "../deleted-file-tracker.js";
import type { DatabaseStats, StorageAdapter } from "./storage-adapter.js";

// SQLite query result row types
interface RepositoryRow {
	id: number;
	path: string;
	name: string;
	first_seen: number;
}

interface DeletedFileRow {
	file_path: string;
	order_num: number;
	deletion_time: number;
}

interface CountRow {
	count: number;
}

interface MinMaxRow {
	oldest?: number;
	newest?: number;
}

// Dynamically loaded sqlite3 module — may not be available in Marketplace installs
// biome-ignore lint/suspicious/noExplicitAny: dynamic native module
let sqlite3Module: any = null;

// biome-ignore lint/suspicious/noExplicitAny: dynamic native module
function getSqlite3(): any {
	if (!sqlite3Module) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			sqlite3Module = require("@vscode/sqlite3");
		} catch {
			throw new Error(
				"@vscode/sqlite3 is not available. SQLite storage requires the native module to be installed.",
			);
		}
	}
	return sqlite3Module;
}

export class SQLiteStorageAdapter implements StorageAdapter {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic native module instance
	private db: any;
	private dbPath: string;
	private isClosed = false;

	// biome-ignore lint/suspicious/noExplicitAny: dynamic native module instance
	private constructor(db: any, dbPath: string) {
		this.db = db;
		this.dbPath = dbPath;
	}

	/**
	 * Create new SQLite storage adapter
	 *
	 * @param dbPath - Absolute path to database file
	 * @returns Initialized adapter
	 * @throws Error if @vscode/sqlite3 is not available, or database cannot be created
	 */
	static async create(dbPath: string): Promise<SQLiteStorageAdapter> {
		const sqlite3 = getSqlite3();

		// Ensure parent directory exists
		const dir = path.dirname(dbPath);
		await fs.mkdir(dir, { recursive: true });

		return new Promise((resolve, reject) => {
			// Open or create database
			const db = new sqlite3.Database(dbPath, (err: Error | null) => {
				if (err) {
					reject(new Error(`Failed to open database: ${err.message}`));
					return;
				}

				// Enable WAL mode for better concurrency
				// WAL = Write-Ahead Logging (multiple readers, one writer)
				db.run("PRAGMA journal_mode=WAL", (walErr: Error | null) => {
					if (walErr) {
						reject(new Error(`Failed to enable WAL: ${walErr.message}`));
						return;
					}

					// Enable foreign key constraints
					db.run("PRAGMA foreign_keys=ON", (fkErr: Error | null) => {
						if (fkErr) {
							reject(
								new Error(`Failed to enable foreign keys: ${fkErr.message}`),
							);
							return;
						}

						const adapter = new SQLiteStorageAdapter(db, dbPath);
						adapter
							.createSchema()
							.then(() => resolve(adapter))
							.catch(reject);
					});
				});
			});
		});
	}

	/**
	 * Create database schema if not exists
	 */
	private async createSchema(): Promise<void> {
		const schema = `
			-- Repositories table
			CREATE TABLE IF NOT EXISTS repositories (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				path TEXT UNIQUE NOT NULL,
				name TEXT NOT NULL,
				first_seen INTEGER NOT NULL
			);

			-- Deleted files table (write-once audit log)
			CREATE TABLE IF NOT EXISTS deleted_files (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				repo_id INTEGER NOT NULL,
				file_path TEXT NOT NULL,
				order_num INTEGER NOT NULL,
				deletion_time INTEGER NOT NULL,
				FOREIGN KEY (repo_id) REFERENCES repositories(id),
				UNIQUE(repo_id, file_path)  -- Write-once enforcement
			);

			-- Indexes for query performance
			CREATE INDEX IF NOT EXISTS idx_deletion_time
				ON deleted_files(deletion_time DESC);
			CREATE INDEX IF NOT EXISTS idx_repo_order
				ON deleted_files(repo_id, order_num);
		`;

		return new Promise((resolve, reject) => {
			this.db.exec(schema, (err: Error | null) => {
				if (err) {
					reject(new Error(`Failed to create schema: ${err.message}`));
				} else {
					resolve();
				}
			});
		});
	}

	async initialize(): Promise<void> {
		// Initialization happens in create()
		// This method exists for interface compatibility
	}

	async close(): Promise<void> {
		// Idempotent close - safe to call multiple times
		if (this.isClosed) {
			return; // Already closed
		}

		return new Promise((resolve, reject) => {
			this.db.close((err: Error | null) => {
				if (err) {
					reject(new Error(`Failed to close database: ${err.message}`));
				} else {
					this.isClosed = true;
					resolve();
				}
			});
		});
	}

	async ensureRepository(repoPath: string, name: string): Promise<number> {
		return new Promise((resolve, reject) => {
			// Try to get existing repository
			this.db.get(
				"SELECT id FROM repositories WHERE path = ?",
				[repoPath],
				(err: Error | null, row: RepositoryRow | undefined) => {
					if (err) {
						reject(new Error(`Failed to query repository: ${err.message}`));
						return;
					}

					if (row) {
						// Repository exists
						resolve(row.id);
						return;
					}

					// Create new repository
					const now = Date.now();
					this.db.run(
						"INSERT INTO repositories (path, name, first_seen) VALUES (?, ?, ?)",
						[repoPath, name, now],
						function (this: { lastID: number }, insertErr: Error | null) {
							if (insertErr) {
								reject(
									new Error(
										`Failed to create repository: ${insertErr.message}`,
									),
								);
							} else {
								resolve(this.lastID);
							}
						},
					);
				},
			);
		});
	}

	async save(repoId: number, records: DeletedFileRecord[]): Promise<void> {
		if (records.length === 0) {
			return; // Nothing to save
		}

		return new Promise((resolve, reject) => {
			// serialize() ensures operations are queued and run sequentially
			this.db.serialize(() => {
				// INSERT OR IGNORE = Write-once behavior
				// If (repo_id, file_path) exists, insertion is skipped
				const stmt = this.db.prepare(`
					INSERT OR IGNORE INTO deleted_files
					(repo_id, file_path, order_num, deletion_time)
					VALUES (?, ?, ?, ?)
				`);

				let errorOccurred: Error | null = null;
				let completed = 0;
				const total = records.length;

				// Track completion of all run() operations
				const checkComplete = () => {
					completed++;
					if (completed === total) {
						// All runs complete, now finalize
						stmt.finalize((finalizeErr: Error | null) => {
							if (errorOccurred) {
								reject(errorOccurred);
							} else if (finalizeErr) {
								reject(
									new Error(`Failed to save records: ${finalizeErr.message}`),
								);
							} else {
								resolve();
							}
						});
					}
				};

				for (const record of records) {
					stmt.run(
						repoId,
						record.filePath,
						record.order,
						record.timestamp || Date.now(),
						(runErr: Error | null) => {
							if (runErr && !errorOccurred) {
								errorOccurred = new Error(
									`Failed to insert record: ${runErr.message}`,
								);
							}
							checkComplete();
						},
					);
				}
			});
		});
	}

	async load(repoId: number): Promise<DeletedFileRecord[]> {
		return new Promise((resolve, reject) => {
			this.db.all(
				`SELECT file_path, order_num, deletion_time
				 FROM deleted_files
				 WHERE repo_id = ?
				 ORDER BY order_num ASC`,
				[repoId],
				(err: Error | null, rows: DeletedFileRow[]) => {
					if (err) {
						reject(new Error(`Failed to load records: ${err.message}`));
						return;
					}

					const records: DeletedFileRecord[] = rows.map((row) => ({
						filePath: row.file_path,
						order: row.order_num,
						timestamp: row.deletion_time,
						isVisible: true, // Runtime-only field (not persisted)
					}));

					resolve(records);
				},
			);
		});
	}

	async queryByRepository(repoPath: string): Promise<DeletedFileRecord[]> {
		return new Promise((resolve, reject) => {
			this.db.all(
				`SELECT df.file_path, df.order_num, df.deletion_time
				 FROM deleted_files df
				 JOIN repositories r ON df.repo_id = r.id
				 WHERE r.path = ?
				 ORDER BY df.order_num ASC`,
				[repoPath],
				(err: Error | null, rows: DeletedFileRow[]) => {
					if (err) {
						reject(new Error(`Failed to query by repository: ${err.message}`));
						return;
					}

					const records: DeletedFileRecord[] = rows.map((row) => ({
						filePath: row.file_path,
						order: row.order_num,
						timestamp: row.deletion_time,
						isVisible: true,
					}));

					resolve(records);
				},
			);
		});
	}

	async queryByTimeRange(
		start: number,
		end: number,
	): Promise<DeletedFileRecord[]> {
		return new Promise((resolve, reject) => {
			this.db.all(
				`SELECT file_path, order_num, deletion_time
				 FROM deleted_files
				 WHERE deletion_time >= ? AND deletion_time <= ?
				 ORDER BY deletion_time DESC`,
				[start, end],
				(err: Error | null, rows: DeletedFileRow[]) => {
					if (err) {
						reject(new Error(`Failed to query by time range: ${err.message}`));
						return;
					}

					const records: DeletedFileRecord[] = rows.map((row) => ({
						filePath: row.file_path,
						order: row.order_num,
						timestamp: row.deletion_time,
						isVisible: true,
					}));

					resolve(records);
				},
			);
		});
	}

	async queryRecent(limit: number): Promise<DeletedFileRecord[]> {
		return new Promise((resolve, reject) => {
			this.db.all(
				`SELECT file_path, order_num, deletion_time
				 FROM deleted_files
				 ORDER BY deletion_time DESC
				 LIMIT ?`,
				[limit],
				(err: Error | null, rows: DeletedFileRow[]) => {
					if (err) {
						reject(new Error(`Failed to query recent files: ${err.message}`));
						return;
					}

					const records: DeletedFileRecord[] = rows.map((row) => ({
						filePath: row.file_path,
						order: row.order_num,
						timestamp: row.deletion_time,
						isVisible: true,
					}));

					resolve(records);
				},
			);
		});
	}

	async backup(): Promise<Uint8Array> {
		// Read entire database file as binary
		const buffer = await fs.readFile(this.dbPath);
		return new Uint8Array(buffer);
	}

	async compact(): Promise<void> {
		// VACUUM command reclaims unused space
		return new Promise((resolve, reject) => {
			this.db.run("VACUUM", (err: Error | null) => {
				if (err) {
					reject(new Error(`Failed to compact database: ${err.message}`));
				} else {
					resolve();
				}
			});
		});
	}

	async getStats(): Promise<DatabaseStats> {
		return new Promise((resolve, reject) => {
			// Query stats in parallel
			const queries = {
				repos: new Promise<number>((res, rej) => {
					this.db.get(
						"SELECT COUNT(*) as count FROM repositories",
						[],
						(err: Error | null, row: CountRow | undefined) => {
							if (err) rej(err);
							else res(row?.count || 0);
						},
					);
				}),
				deletions: new Promise<number>((res, rej) => {
					this.db.get(
						"SELECT COUNT(*) as count FROM deleted_files",
						[],
						(err: Error | null, row: CountRow | undefined) => {
							if (err) rej(err);
							else res(row?.count || 0);
						},
					);
				}),
				oldest: new Promise<number | undefined>((res, rej) => {
					this.db.get(
						"SELECT MIN(deletion_time) as oldest FROM deleted_files",
						[],
						(err: Error | null, row: MinMaxRow | undefined) => {
							if (err) rej(err);
							else res(row?.oldest || undefined);
						},
					);
				}),
				newest: new Promise<number | undefined>((res, rej) => {
					this.db.get(
						"SELECT MAX(deletion_time) as newest FROM deleted_files",
						[],
						(err: Error | null, row: MinMaxRow | undefined) => {
							if (err) rej(err);
							else res(row?.newest || undefined);
						},
					);
				}),
			};

			Promise.all([
				queries.repos,
				queries.deletions,
				queries.oldest,
				queries.newest,
			])
				.then(
					async ([
						totalRepositories,
						totalDeletions,
						oldestDeletion,
						newestDeletion,
					]) => {
						// Get database file size
						const stats = await fs.stat(this.dbPath);

						resolve({
							totalRepositories,
							totalDeletions,
							databaseSizeBytes: stats.size,
							oldestDeletion,
							newestDeletion,
						});
					},
				)
				.catch((err) => {
					reject(new Error(`Failed to get database stats: ${err.message}`));
				});
		});
	}
}
