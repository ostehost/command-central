/**
 * SessionStore — Persists project_dir → Ghostty bundle mappings.
 *
 * Enables click-to-focus for discovered agents (not just launcher tasks)
 * by remembering which Ghostty bundle corresponds to each project directory.
 *
 * Storage: ~/.config/command-central/sessions.json
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface SessionEntry {
	projectDir: string;
	bundlePath: string;
	bundleId: string;
	lastSeen: string; // ISO timestamp
}

export interface SessionStoreData {
	version: 1;
	sessions: Record<string, SessionEntry>; // keyed by projectDir
}

const STORE_DIR = path.join(
	process.env["HOME"] ?? "/tmp",
	".config",
	"command-central",
);
const STORE_PATH = path.join(STORE_DIR, "sessions.json");
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class SessionStore {
	private data: SessionStoreData;
	private storePath: string;

	constructor(storePath?: string) {
		this.storePath = storePath ?? STORE_PATH;
		this.data = this.loadFromDisk();
		this.prune();
	}

	/** Register or update a bundle mapping for a project directory */
	register(projectDir: string, bundlePath: string, bundleId: string): void {
		this.data.sessions[projectDir] = {
			projectDir,
			bundlePath,
			bundleId,
			lastSeen: new Date().toISOString(),
		};
	}

	/** Look up bundle info for a project directory, with convention-based fallback */
	lookup(projectDir: string): { bundlePath: string; bundleId: string } | null {
		// 1. Check persisted mapping
		const entry = this.data.sessions[projectDir];
		if (entry) {
			return { bundlePath: entry.bundlePath, bundleId: entry.bundleId };
		}

		// 2. Derive from naming convention
		const basename = path.basename(projectDir);
		const safeName = basename.replace(/[^a-zA-Z0-9._-]/g, "-");
		const derivedPath = `/Applications/Projects/${safeName}.app`;
		if (fs.existsSync(derivedPath)) {
			const derivedId = `dev.partnerai.ghostty.${safeName}`;
			// Cache for next time
			this.register(projectDir, derivedPath, derivedId);
			return { bundlePath: derivedPath, bundleId: derivedId };
		}

		return null;
	}

	/** Remove entries older than 30 days. Returns count of pruned entries. */
	prune(): number {
		const now = Date.now();
		let pruned = 0;
		for (const [key, entry] of Object.entries(this.data.sessions)) {
			const age = now - new Date(entry.lastSeen).getTime();
			if (age > MAX_AGE_MS) {
				delete this.data.sessions[key];
				pruned++;
			}
		}
		return pruned;
	}

	/** Persist to disk */
	save(): void {
		const dir = path.dirname(this.storePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(this.storePath, JSON.stringify(this.data, null, 2));
	}

	/** Get all entries (for testing/debugging) */
	getAll(): Record<string, SessionEntry> {
		return { ...this.data.sessions };
	}

	private loadFromDisk(): SessionStoreData {
		try {
			if (fs.existsSync(this.storePath)) {
				const content = fs.readFileSync(this.storePath, "utf-8");
				const parsed = JSON.parse(content) as SessionStoreData;
				if (parsed.version === 1 && parsed.sessions) {
					return parsed;
				}
			}
		} catch {
			// Corrupt JSON or read error — start fresh
		}
		return { version: 1, sessions: {} };
	}
}
