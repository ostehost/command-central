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

export const DEFAULT_PENDING_REVIEW_DIR = "/tmp/oste-pending-review";
const DEFAULT_CACHE_TTL_MS = 5_000;

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

	const filePath = path.join(baseDir, `${taskId}.json`);
	const receipt = parseReceiptFile(taskId, filePath);
	cache.set(cacheKey, { checkedAt: now, receipt });
	return receipt;
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
	};
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
