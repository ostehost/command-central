/**
 * ReviewTracker — Tracks which completed agent tasks have been reviewed.
 *
 * Stores reviewed task IDs in a local JSON file so the sidebar can show
 * a "reviewed" badge on tasks that have already been looked at.
 *
 * Storage: ~/.config/command-central/reviewed-tasks.json
 * Cap: 500 entries (oldest pruned when exceeded)
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ReviewTrackerData {
	version: 1;
	reviewed: string[]; // ordered oldest-first
}

const STORE_DIR = path.join(
	process.env["HOME"] ?? "/tmp",
	".config",
	"command-central",
);
const STORE_PATH = path.join(STORE_DIR, "reviewed-tasks.json");
const MAX_ENTRIES = 500;

export class ReviewTracker {
	private reviewed: Set<string>;
	private orderedIds: string[];
	readonly storePath: string;

	constructor(storePath?: string) {
		this.storePath = storePath ?? STORE_PATH;
		const data = this.loadFromDisk();
		this.orderedIds = data.reviewed;
		this.reviewed = new Set(this.orderedIds);
	}

	markReviewed(taskId: string): void {
		if (this.reviewed.has(taskId)) return;
		this.reviewed.add(taskId);
		this.orderedIds.push(taskId);
		this.prune();
		this.save();
	}

	isReviewed(taskId: string): boolean {
		return this.reviewed.has(taskId);
	}

	getReviewedIds(): Set<string> {
		return new Set(this.reviewed);
	}

	save(): void {
		const data: ReviewTrackerData = {
			version: 1,
			reviewed: this.orderedIds,
		};
		try {
			fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
			fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), "utf-8");
		} catch {
			// Silently ignore write failures — reviewed state is best-effort
		}
	}

	private prune(): void {
		if (this.orderedIds.length <= MAX_ENTRIES) return;
		const excess = this.orderedIds.length - MAX_ENTRIES;
		const removed = this.orderedIds.splice(0, excess);
		for (const id of removed) {
			this.reviewed.delete(id);
		}
	}

	private loadFromDisk(): ReviewTrackerData {
		try {
			const raw = fs.readFileSync(this.storePath, "utf-8");
			const parsed = JSON.parse(raw) as unknown;
			if (
				parsed &&
				typeof parsed === "object" &&
				(parsed as ReviewTrackerData).version === 1 &&
				Array.isArray((parsed as ReviewTrackerData).reviewed)
			) {
				const ids = (parsed as ReviewTrackerData).reviewed.filter(
					(id): id is string => typeof id === "string",
				);
				return { version: 1, reviewed: ids };
			}
		} catch {
			// File doesn't exist yet or is malformed — start fresh
		}
		return { version: 1, reviewed: [] };
	}
}
