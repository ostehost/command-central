/**
 * Pending-review probe — reads the launcher's system-completion receipt.
 *
 * The launcher's `oste-complete.sh` hook writes one JSON file per task to
 * `/tmp/oste-pending-review/<task_id>.json` the moment the agent actually
 * completes (or fails / is canceled). That file contains the authoritative
 * `status`, `exit_code`, and end-commit — and it is written BEFORE the
 * `status: completed` update reaches `tasks.json`.
 *
 * Command Central uses this probe as a ground-truth overlay when tasks.json
 * still says `running` so the tree doesn't misreport completed tasks as
 * "Running / possibly stuck".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type LaneProjectionGcReceipt,
	parseLaneProjectionGcReceipt,
} from "./review-queue-health.js";

export const DEFAULT_PENDING_REVIEW_DIR = "/tmp/oste-pending-review";

/**
 * Default location of the lane-projection GC receipt the launcher's GC command
 * (`scripts/oste-lanes-gc.sh`) writes alongside the projection it rebuilds. The
 * `CC_LANE_GC_RECEIPT` env override mirrors `CC_PENDING_REVIEW_DIR`.
 */
export const DEFAULT_LANE_GC_RECEIPT_PATH =
	"/tmp/oste-pending-review/lane-projection-gc.json";

const DEFAULT_CACHE_TTL_MS = 5_000;

/**
 * Subdirectory under the pending-review dir where the launcher snapshots a
 * receipt once it is marked reviewed. `pending_review_mark_reviewed` (see
 * ghostty-launcher scripts/lib/pending-review.sh) updates the active file in
 * place AND copies it to `<dir>/reviewed/<task_id>.json`, so a reviewed task
 * leaves a durable artifact even after the active queue entry is consumed.
 */
export const REVIEWED_ARCHIVE_SUBDIR = "reviewed";

function resolveDefaultDir(): string {
	const override = process.env["CC_PENDING_REVIEW_DIR"];
	return override && override.length > 0
		? override
		: DEFAULT_PENDING_REVIEW_DIR;
}

export interface PendingReviewReceipt {
	taskId: string;
	/** Raw receipt status string (`completed`, `failed`, `canceled`, ...). */
	status: string;
	exitCode: number | null;
	completedAt: string | null;
	lastCommit: string | null;
	endCommit: string | null;
	agentCommit: string | null;
	managerCommit: string | null;
	agentSummary: string | null;
	filesChanged: string[];
	/**
	 * Launcher review-lifecycle string on the receipt itself: pending /
	 * reviewing / reviewed / awaiting_fixup / blocked / no_review_expected.
	 * This is the receipt's own truth — it can lead the tasks.json task-row
	 * projection when auto-review dispatch failed and a manual review later
	 * updated the receipt.
	 */
	reviewState: string | null;
	/** `reviewed: true` flag the launcher sets alongside review_state. */
	reviewed: boolean;
}

interface CacheEntry {
	checkedAt: number;
	receipt: PendingReviewReceipt | null;
}

const cache = new Map<string, CacheEntry>();

export interface PendingReviewProbeOptions {
	baseDir?: string;
	ttlMs?: number;
	now?: number;
}

export function readPendingReviewReceipt(
	taskId: string,
	opts: PendingReviewProbeOptions = {},
): PendingReviewReceipt | null {
	const baseDir = opts.baseDir ?? resolveDefaultDir();
	const ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
	const now = opts.now ?? Date.now();
	const cacheKey = `${baseDir}::${taskId}`;

	const cached = cache.get(cacheKey);
	if (cached && now - cached.checkedAt < ttlMs) {
		return cached.receipt;
	}

	const filePath = resolveReceiptFilePath(baseDir, taskId);
	if (!filePath) {
		cache.set(cacheKey, { checkedAt: now, receipt: null });
		return null;
	}

	const receipt = parseReceiptFile(taskId, filePath);
	cache.set(cacheKey, { checkedAt: now, receipt });
	return receipt;
}

/**
 * Read the review-resolution receipt for a task, preferring the active
 * pending-review file but falling back to the `reviewed/` archive snapshot
 * when the active entry has been consumed/relocated. Used to recover the
 * launcher's reviewed truth for a task whose tasks.json row went stale (the
 * Symphony dogfood gap: auto-review dispatch failed, a manual review later
 * marked the SOURCE receipt reviewed, but the task-row projection never
 * refreshed).
 */
export function readReviewedReceipt(
	taskId: string,
	opts: PendingReviewProbeOptions = {},
): PendingReviewReceipt | null {
	const active = readPendingReviewReceipt(taskId, opts);
	if (active) return active;

	const baseDir = opts.baseDir ?? resolveDefaultDir();
	return readPendingReviewReceipt(taskId, {
		...opts,
		baseDir: path.join(baseDir, REVIEWED_ARCHIVE_SUBDIR),
	});
}

/**
 * Whether the receipt records the task's review as reviewed — i.e. a manual
 * or automated review passed. Narrow on purpose: `reviewing`, `awaiting_fixup`
 * and `blocked` are NOT reviewed, so true pending/fixup/blocker states are
 * preserved.
 */
export function isReceiptReviewed(receipt: PendingReviewReceipt): boolean {
	if (receipt.reviewed) return true;
	return receipt.reviewState?.trim().toLowerCase() === "reviewed";
}

export function clearPendingReviewCache(): void {
	cache.clear();
}

function parseReceiptFile(
	taskId: string,
	filePath: string,
): PendingReviewReceipt | null {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	let parsed: Record<string, unknown>;
	try {
		const value = JSON.parse(raw) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value))
			return null;
		parsed = value as Record<string, unknown>;
	} catch {
		return null;
	}

	const status = asString(parsed["status"]);
	if (!status) return null;

	return {
		taskId,
		status,
		exitCode: asNumber(parsed["exit_code"]),
		completedAt: asString(parsed["completed_at"]),
		lastCommit: asString(parsed["last_commit"]),
		endCommit: asString(parsed["end_commit"]),
		agentCommit: asString(parsed["agent_commit"]),
		managerCommit: asString(parsed["manager_commit"]),
		agentSummary: asString(parsed["agent_summary"]),
		filesChanged: asStringArray(parsed["files_changed"]),
		reviewState: asString(parsed["review_state"]),
		reviewed: parsed["reviewed"] === true,
	};
}

function resolveReceiptFilePath(
	baseDir: string,
	taskId: string,
): string | null {
	if (
		taskId.length === 0 ||
		taskId === "." ||
		taskId === ".." ||
		taskId.includes("/") ||
		taskId.includes("\\") ||
		taskId.includes("\0")
	) {
		return null;
	}

	return path.join(baseDir, `${taskId}.json`);
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

/** The most-specific commit hash to prefer when overlaying UI state. */
export function resolveReceiptCommit(
	receipt: PendingReviewReceipt,
): string | null {
	return (
		receipt.endCommit ??
		receipt.lastCommit ??
		receipt.managerCommit ??
		receipt.agentCommit ??
		null
	);
}

export type ReceiptOverlayStatus = "completed" | "failed" | "stopped";

export interface ReceiptOverlay {
	status: ReceiptOverlayStatus;
	completedAt?: string;
	exitCode?: number | null;
	endCommit?: string | null;
	reason?: string;
}

/**
 * Translate a receipt into the minimal overlay needed to correct the UI
 * status for a task that tasks.json still reports as `running`. Returns
 * `null` when the receipt is ambiguous enough that we'd rather leave the
 * existing runtime inference in place.
 */
export function receiptToOverlay(
	receipt: PendingReviewReceipt,
): ReceiptOverlay | null {
	const endCommit = resolveReceiptCommit(receipt);

	if (receipt.status === "canceled" || receipt.status === "stopped") {
		return {
			status: "stopped",
			completedAt: receipt.completedAt ?? undefined,
			exitCode: receipt.exitCode,
			endCommit,
			reason: "Launcher reported task canceled.",
		};
	}

	if (
		receipt.status === "completed" &&
		(receipt.exitCode == null || receipt.exitCode === 0)
	) {
		return {
			status: "completed",
			completedAt: receipt.completedAt ?? undefined,
			exitCode: receipt.exitCode ?? 0,
			endCommit,
		};
	}

	if (
		receipt.status === "failed" ||
		(receipt.exitCode != null && receipt.exitCode !== 0)
	) {
		return {
			status: "failed",
			completedAt: receipt.completedAt ?? undefined,
			exitCode: receipt.exitCode,
			endCommit,
			reason: "Launcher reported task failed.",
		};
	}

	return null;
}

/**
 * Read + parse the lane-projection GC receipt the launcher's GC command emits.
 * Returns null when the file is absent or malformed (fail-closed — Command
 * Central treats "no receipt" as "no authoritative GC pass to reconcile
 * against", never as a verdict). Side-effecting FS read kept here alongside the
 * other launcher-receipt readers; the schema parse is the pure
 * {@link parseLaneProjectionGcReceipt}.
 *
 * Opt-in by design: with no explicit `receiptPath` argument, the reader only
 * touches disk when `CC_LANE_GC_RECEIPT` is set. This keeps the default
 * projection ingest path from coupling to an ambient file on disk (tests/CI
 * never see a phantom GC pass); a real deployment wires the launcher's receipt
 * path via the env var. Pass `receiptPath` to read a specific file (fixtures,
 * explicit config). An env value of "" means "use the launcher default path".
 */
export function readLaneProjectionGcReceipt(
	receiptPath?: string,
): LaneProjectionGcReceipt | null {
	const envRaw = process.env["CC_LANE_GC_RECEIPT"];
	const fromEnv =
		envRaw === undefined
			? null
			: envRaw.trim().length > 0
				? envRaw.trim()
				: DEFAULT_LANE_GC_RECEIPT_PATH;
	const resolved = receiptPath ?? fromEnv;
	if (!resolved || resolved.length === 0) return null;

	let raw: string;
	try {
		raw = fs.readFileSync(resolved, "utf-8");
	} catch {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return null;
	}

	return parseLaneProjectionGcReceipt(parsed);
}
