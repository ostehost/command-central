/**
 * WorkspaceState Storage Adapter
 *
 * Uses VS Code's native workspaceState API for persistence.
 * Zero dependencies — replaces SQLite entirely.
 *
 * Storage layout in workspaceState:
 *   "cc.repos" → Map<path, { id, name }>
 *   "cc.deleted.<repoId>" → DeletedFileRecord[]
 *   "cc.nextRepoId" → number
 */

import type * as vscode from "vscode";
import type { DeletedFileRecord } from "../deleted-file-tracker.js";
import type { DatabaseStats, StorageAdapter } from "./storage-adapter.js";

interface RepoEntry {
	id: number;
	name: string;
}

export class WorkspaceStateStorageAdapter implements StorageAdapter {
	private repos = new Map<string, RepoEntry>();
	private nextId = 1;

	constructor(private state: vscode.Memento) {}

	static async create(
		state: vscode.Memento,
	): Promise<WorkspaceStateStorageAdapter> {
		const adapter = new WorkspaceStateStorageAdapter(state);
		await adapter.initialize();
		return adapter;
	}

	async initialize(): Promise<void> {
		const savedRepos = this.state.get<Record<string, RepoEntry>>("cc.repos");
		if (savedRepos) {
			for (const [path, entry] of Object.entries(savedRepos)) {
				this.repos.set(path, entry);
			}
		}
		this.nextId = this.state.get<number>("cc.nextRepoId") ?? 1;
	}

	async close(): Promise<void> {
		// workspaceState persists automatically, nothing to flush
	}

	async ensureRepository(path: string, name: string): Promise<number> {
		const existing = this.repos.get(path);
		if (existing) return existing.id;

		const id = this.nextId++;
		this.repos.set(path, { id, name });
		await this.state.update(
			"cc.repos",
			Object.fromEntries(this.repos.entries()),
		);
		await this.state.update("cc.nextRepoId", this.nextId);
		return id;
	}

	async save(repoId: number, records: DeletedFileRecord[]): Promise<void> {
		await this.state.update(`cc.deleted.${repoId}`, records);
	}

	async load(repoId: number): Promise<DeletedFileRecord[]> {
		return this.state.get<DeletedFileRecord[]>(`cc.deleted.${repoId}`) ?? [];
	}

	async queryByRepository(repoPath: string): Promise<DeletedFileRecord[]> {
		const repo = this.repos.get(repoPath);
		if (!repo) return [];
		return this.load(repo.id);
	}

	async queryByTimeRange(
		start: number,
		end: number,
	): Promise<DeletedFileRecord[]> {
		const all: DeletedFileRecord[] = [];
		for (const entry of this.repos.values()) {
			const records = await this.load(entry.id);
			for (const r of records) {
				if (r.timestamp >= start && r.timestamp <= end) {
					all.push(r);
				}
			}
		}
		return all.sort((a, b) => b.timestamp - a.timestamp);
	}

	async queryRecent(limit: number): Promise<DeletedFileRecord[]> {
		const all: DeletedFileRecord[] = [];
		for (const entry of this.repos.values()) {
			all.push(...(await this.load(entry.id)));
		}
		return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
	}

	async backup(): Promise<Uint8Array> {
		const data: Record<string, unknown> = {};
		data.repos = Object.fromEntries(this.repos.entries());
		for (const entry of this.repos.values()) {
			data[`deleted.${entry.id}`] = await this.load(entry.id);
		}
		return new TextEncoder().encode(JSON.stringify(data));
	}

	async compact(): Promise<void> {
		// No-op — workspaceState doesn't need compaction
	}

	async getStats(): Promise<DatabaseStats> {
		let totalDeletions = 0;
		let oldest: number | undefined;
		let newest: number | undefined;

		for (const entry of this.repos.values()) {
			const records = await this.load(entry.id);
			totalDeletions += records.length;
			for (const r of records) {
				if (oldest === undefined || r.timestamp < oldest)
					oldest = r.timestamp;
				if (newest === undefined || r.timestamp > newest)
					newest = r.timestamp;
			}
		}

		return {
			totalRepositories: this.repos.size,
			totalDeletions,
			databaseSizeBytes: 0, // Not meaningful for workspaceState
			oldestDeletion: oldest,
			newestDeletion: newest,
		};
	}
}
