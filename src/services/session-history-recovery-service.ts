/**
 * SessionHistoryRecoveryService — read-only audit of OpenClaw session-history
 * archive/recovery risk.
 *
 * OpenClaw archives session transcripts by renaming them in place to
 * `<id>.jsonl.deleted.<timestamp>` and by sweeping whole session sets into
 * `~/.openclaw/archive/sessions-*` directories. These archived transcripts are
 * the only recovery path once a live session file is gone, but they are subject
 * to a retention window and may eventually be pruned. This service surfaces that
 * risk so an operator can back up before recovery is no longer possible.
 *
 * Hard guarantee: this service is STRICTLY READ-ONLY. It only enumerates and
 * `stat`s files (`readdirSync` / `statSync`). It never writes, renames,
 * deletes, or otherwise mutates any session file, archive, or gateway config.
 *
 * Graceful degradation: a missing `~/.openclaw` (or any individual root) yields
 * an empty, zero-risk report rather than throwing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Default retention window after which archived transcripts are at prune risk. */
const DEFAULT_RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Matches OpenClaw's archived-transcript suffix, e.g. `.jsonl.deleted.<ts>`. */
const DELETED_TRANSCRIPT_RE = /\.jsonl[^/]*\.deleted\.(.+)$/;
/** Live trajectory companion files; an orphan has no base `<id>.jsonl`. */
const TRAJECTORY_SUFFIX = ".trajectory.jsonl";

export interface ArchivedTranscript {
	/** Absolute path to the archived (`.deleted.`) transcript file. */
	readonly filePath: string;
	/** Raw deletion-timestamp label parsed from the filename, if present. */
	readonly deletedLabel: string;
	/** File modification time in epoch ms — the authoritative age source. */
	readonly mtimeMs: number;
	/** Whole-day age relative to the scan clock. */
	readonly ageDays: number;
	/** File size in bytes. */
	readonly sizeBytes: number;
	/** True when older than the retention window (eligible for pruning). */
	readonly pastRetention: boolean;
}

export interface OrphanSessionFile {
	/** Absolute path to a trajectory file with no surviving base transcript. */
	readonly filePath: string;
	/** File modification time in epoch ms. */
	readonly mtimeMs: number;
}

export interface SessionHistoryRecoveryReport {
	/** Roots that were scanned (existing directories only). */
	readonly scannedRoots: string[];
	/** All archived (`.deleted.`) transcripts found, newest first. */
	readonly archivedTranscripts: ArchivedTranscript[];
	/** Trajectory files whose base transcript is missing, newest first. */
	readonly orphanSessionFiles: OrphanSessionFile[];
	/** Retention window in days used to compute prune risk. */
	readonly retentionDays: number;
	/** Count of archived transcripts older than the retention window. */
	readonly pastRetentionCount: number;
	/** Age in days of the oldest archived transcript, or null when none. */
	readonly oldestAgeDays: number | null;
	/** Age in days of the newest archived transcript, or null when none. */
	readonly newestAgeDays: number | null;
	/** Total bytes held by archived transcripts. */
	readonly totalArchivedBytes: number;
	/**
	 * True when there is recoverable history that is already past the retention
	 * window — the operator should back up before it is pruned.
	 */
	readonly atRisk: boolean;
}

export interface SessionHistoryRecoveryOptions {
	/** OpenClaw home directory (defaults to `~/.openclaw`). */
	readonly openClawDir?: string;
	/** Retention window in days (defaults to 30). */
	readonly retentionDays?: number;
	/** Clock injection for deterministic age tests (defaults to `Date.now`). */
	readonly now?: () => number;
}

export class SessionHistoryRecoveryService {
	private readonly openClawDir: string;
	private readonly retentionDays: number;
	private readonly now: () => number;

	constructor(options: SessionHistoryRecoveryOptions = {}) {
		this.openClawDir =
			options.openClawDir ?? path.join(os.homedir(), ".openclaw");
		this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
		this.now = options.now ?? Date.now;
	}

	/** Produce a fresh read-only report. Never throws on a missing tree. */
	scan(): SessionHistoryRecoveryReport {
		const roots = this.resolveSessionRoots();
		const archived: ArchivedTranscript[] = [];
		const orphans: OrphanSessionFile[] = [];
		const retentionMs = this.retentionDays * MS_PER_DAY;
		const nowMs = this.now();

		for (const root of roots) {
			this.scanRoot(root, nowMs, retentionMs, archived, orphans);
		}

		archived.sort((left, right) => right.mtimeMs - left.mtimeMs);
		orphans.sort((left, right) => right.mtimeMs - left.mtimeMs);

		return this.buildReport(roots, archived, orphans);
	}

	// ── Internal ────────────────────────────────────────────────────────

	private buildReport(
		scannedRoots: string[],
		archivedTranscripts: ArchivedTranscript[],
		orphanSessionFiles: OrphanSessionFile[],
	): SessionHistoryRecoveryReport {
		const pastRetentionCount = archivedTranscripts.filter(
			(entry) => entry.pastRetention,
		).length;
		const totalArchivedBytes = archivedTranscripts.reduce(
			(sum, entry) => sum + entry.sizeBytes,
			0,
		);
		// Newest-first ordering: index 0 is newest, last is oldest.
		const newest = archivedTranscripts[0];
		const oldest = archivedTranscripts[archivedTranscripts.length - 1];

		return {
			scannedRoots,
			archivedTranscripts,
			orphanSessionFiles,
			retentionDays: this.retentionDays,
			pastRetentionCount,
			oldestAgeDays: oldest ? oldest.ageDays : null,
			newestAgeDays: newest ? newest.ageDays : null,
			totalArchivedBytes,
			atRisk: pastRetentionCount > 0,
		};
	}

	/** Candidate session-history roots: per-agent session dirs + archive sets. */
	private resolveSessionRoots(): string[] {
		const roots: string[] = [];
		const agentsDir = path.join(this.openClawDir, "agents");
		for (const agent of this.listDirNames(agentsDir)) {
			const sessions = path.join(agentsDir, agent, "sessions");
			if (this.isDir(sessions)) roots.push(sessions);
		}

		const archiveDir = path.join(this.openClawDir, "archive");
		for (const entry of this.listDirNames(archiveDir)) {
			if (!entry.startsWith("sessions")) continue;
			const archived = path.join(archiveDir, entry);
			if (this.isDir(archived)) roots.push(archived);
		}

		return roots;
	}

	private scanRoot(
		root: string,
		nowMs: number,
		retentionMs: number,
		archived: ArchivedTranscript[],
		orphans: OrphanSessionFile[],
	): void {
		const fileNames = new Set(this.listFileNames(root));
		for (const name of fileNames) {
			const deletedMatch = name.match(DELETED_TRANSCRIPT_RE);
			if (deletedMatch) {
				const entry = this.describeArchived(
					path.join(root, name),
					deletedMatch[1] ?? "",
					nowMs,
					retentionMs,
				);
				if (entry) archived.push(entry);
				continue;
			}
			this.collectOrphan(root, name, fileNames, orphans);
		}
	}

	private describeArchived(
		filePath: string,
		deletedLabel: string,
		nowMs: number,
		retentionMs: number,
	): ArchivedTranscript | null {
		const stats = this.statFile(filePath);
		if (!stats) return null;
		return {
			filePath,
			deletedLabel,
			mtimeMs: stats.mtimeMs,
			ageDays: this.ageInDays(stats.mtimeMs, nowMs),
			sizeBytes: stats.size,
			pastRetention: nowMs - stats.mtimeMs > retentionMs,
		};
	}

	private collectOrphan(
		root: string,
		name: string,
		fileNames: Set<string>,
		orphans: OrphanSessionFile[],
	): void {
		if (!name.endsWith(TRAJECTORY_SUFFIX)) return;
		const baseName = `${name.slice(0, -TRAJECTORY_SUFFIX.length)}.jsonl`;
		if (fileNames.has(baseName)) return;
		const stats = this.statFile(path.join(root, name));
		if (!stats) return;
		orphans.push({ filePath: path.join(root, name), mtimeMs: stats.mtimeMs });
	}

	private ageInDays(mtimeMs: number, nowMs: number): number {
		return Math.max(0, Math.floor((nowMs - mtimeMs) / MS_PER_DAY));
	}

	private listDirNames(dir: string): string[] {
		try {
			return fs
				.readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			return [];
		}
	}

	private listFileNames(dir: string): string[] {
		try {
			return fs
				.readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => entry.name);
		} catch {
			return [];
		}
	}

	private isDir(target: string): boolean {
		try {
			return fs.statSync(target).isDirectory();
		} catch {
			return false;
		}
	}

	private statFile(target: string): { mtimeMs: number; size: number } | null {
		try {
			const stats = fs.statSync(target);
			return { mtimeMs: stats.mtimeMs, size: stats.size };
		} catch {
			return null;
		}
	}
}
