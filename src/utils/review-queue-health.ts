/**
 * Checks whether a task's advertised pending-review receipt exists on disk.
 *
 * Fail-open contract: only report "missing" on confirmed ENOENT or a
 * directory at the expected path. Any other filesystem error or invalid input
 * is "unknown" so the read-only UI does not falsely demote live work.
 *
 * Source-of-truth rule: a local file probe is only evidence about THIS
 * machine. Callers must gate the probe on the task having executed on the
 * current host (see isLocalFileProbeAuthoritative in
 * agent-task-classification.ts) and must let the task's own review metadata
 * win first (see {@link isReviewLifecycleResolved}): once the launcher
 * records the review as resolved, the receipt has been consumed by the
 * review flow and its absence is the expected steady state — not a queue gap.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type AdvertisedReviewQueueState =
	| "absent"
	| "present"
	| "missing"
	| "unknown";

export interface ReviewQueueTaskShape {
	project_dir: string;
	pending_review_path?: string | null;
}

export interface ReviewLifecycleShape {
	review_status?: string | null;
	review_state?: string | null;
}

/**
 * Launcher `review_state` values that mean the review cycle is over (or was
 * never expected), so the pending-review receipt has been legitimately
 * consumed/never written. The launcher vocabulary is pending / reviewing /
 * awaiting_fixup / blocked / reviewed / no_review_expected (see
 * ghostty-launcher oste-complete.sh and oste-review-watchdog-runner.sh).
 */
const RESOLVED_REVIEW_STATES = new Set(["reviewed", "no_review_expected"]);

/**
 * Whether the task's own metadata already settles the review lifecycle.
 *
 * When this returns true the absence of the advertised pending-review
 * receipt is expected (the review flow consumes it on approval), so the UI
 * must NOT surface "review receipt missing" — regardless of what a local
 * filesystem probe says. Metadata is the authority; the probe is only a
 * health check for reviews that are still owed a receipt.
 */
export function isReviewLifecycleResolved(task: ReviewLifecycleShape): boolean {
	if (task.review_status === "approved") return true;
	const state = task.review_state?.trim().toLowerCase();
	return state !== undefined && RESOLVED_REVIEW_STATES.has(state);
}

/**
 * CCSYNC-02 — lane-projection rebuild/GC receipt.
 *
 * The launcher's lane-projection GC command (`scripts/oste-lanes-gc.sh`, the
 * producer that rewrites `~/.config/openclaw/lanes.json`) emits a timestamped,
 * machine-readable receipt enumerating what it did to each lane row so Command
 * Central can reconcile stale rows against an authoritative pass rather than
 * re-deriving the verdict from live filesystem state on every render.
 *
 * Per-row verdicts (the GC output taxonomy):
 *  - `kept`            — row is still live/valid; left untouched.
 *  - `downgraded`      — receipt-missing + no live evidence; downgraded to a
 *                        `reconcile-needed` projection-stale state (NOT removed,
 *                        so the operator can audit/clear it).
 *  - `archived`        — terminal + reviewed/settled; moved to the archive.
 *  - `removed`         — orphan with no backing evidence; dropped from the
 *                        projection.
 *
 * The on-disk shape is:
 * `{version, kind: "lane-projection-gc-receipt", generated_at, mode: "dry-run"
 *   | "apply", rows: {<lane_ref.id|task_id>: {verdict, reason?}}, counts?}`.
 */
export const LANE_PROJECTION_GC_RECEIPT_KIND = "lane-projection-gc-receipt";

export type LaneProjectionGcVerdict =
	| "kept"
	| "downgraded"
	| "archived"
	| "removed";

/**
 * The subset of GC verdicts that reconcile a projection row OUT of the live
 * attention/active surface (everything except `kept`). Carried on the task as
 * the `gc_reconcile` marker.
 */
export type ReconciledGcVerdict = Exclude<LaneProjectionGcVerdict, "kept">;

export type LaneProjectionGcMode = "dry-run" | "apply";

export interface LaneProjectionGcRow {
	verdict: LaneProjectionGcVerdict;
	reason: string | null;
}

export interface LaneProjectionGcReceipt {
	version: number;
	kind: typeof LANE_PROJECTION_GC_RECEIPT_KIND;
	generatedAt: string | null;
	mode: LaneProjectionGcMode;
	rows: Record<string, LaneProjectionGcRow>;
}

const GC_VERDICTS = new Set<LaneProjectionGcVerdict>([
	"kept",
	"downgraded",
	"archived",
	"removed",
]);

/**
 * GC verdicts that mean the projection row is no longer live attention work and
 * must be reconciled out of the active/attention surface: a `downgraded` row is
 * receipt-missing limbo (reconcile-needed), `archived`/`removed` rows were taken
 * out of the live read-model entirely. Only `kept` leaves the row authoritative.
 */
const GC_RECONCILED_VERDICTS = new Set<ReconciledGcVerdict>([
	"downgraded",
	"archived",
	"removed",
]);

function isGcVerdict(value: unknown): value is LaneProjectionGcVerdict {
	return (
		typeof value === "string" &&
		GC_VERDICTS.has(value as LaneProjectionGcVerdict)
	);
}

/**
 * Pure parser for a lane-projection GC receipt document. Returns null for any
 * document that is not a well-formed receipt of the expected kind (fail-closed:
 * a malformed receipt must never be mistaken for an authoritative GC pass).
 */
export function parseLaneProjectionGcReceipt(
	value: unknown,
): LaneProjectionGcReceipt | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const doc = value as Record<string, unknown>;
	if (doc["kind"] !== LANE_PROJECTION_GC_RECEIPT_KIND) return null;

	const version = typeof doc["version"] === "number" ? doc["version"] : 1;
	const modeRaw = doc["mode"];
	const mode: LaneProjectionGcMode = modeRaw === "apply" ? "apply" : "dry-run";
	const generatedAt =
		typeof doc["generated_at"] === "string" && doc["generated_at"].length > 0
			? doc["generated_at"]
			: null;

	const rowsRaw = doc["rows"];
	const rows: Record<string, LaneProjectionGcRow> = {};
	if (rowsRaw && typeof rowsRaw === "object" && !Array.isArray(rowsRaw)) {
		for (const [rowKey, rowVal] of Object.entries(rowsRaw)) {
			if (!rowVal || typeof rowVal !== "object" || Array.isArray(rowVal)) {
				continue;
			}
			const row = rowVal as Record<string, unknown>;
			const verdict = row["verdict"];
			if (!isGcVerdict(verdict)) continue;
			const reason = row["reason"];
			rows[rowKey] = {
				verdict,
				reason: typeof reason === "string" && reason.length > 0 ? reason : null,
			};
		}
	}

	return {
		version,
		kind: LANE_PROJECTION_GC_RECEIPT_KIND,
		generatedAt,
		mode,
		rows,
	};
}

/**
 * Look up the GC verdict for a projection row, matching on either the
 * provider-scoped lane id (`launcher:<task_id>`) or the bare task id — the GC
 * producer may key rows by either, and the projection carries both.
 */
export function lookupGcRowVerdict(
	receipt: LaneProjectionGcReceipt,
	keys: { laneId?: string | null; taskId?: string | null },
): LaneProjectionGcRow | null {
	for (const key of [keys.laneId, keys.taskId]) {
		if (typeof key === "string" && key.length > 0) {
			const row = receipt.rows[key];
			if (row) return row;
		}
	}
	return null;
}

/**
 * Whether a GC verdict means the row should be reconciled out of the live
 * attention/active surface (downgraded to reconcile-needed limbo, archived, or
 * removed). `kept` and an absent row leave the row authoritative.
 */
export function isReconciledGcVerdict(
	verdict: LaneProjectionGcVerdict,
): verdict is ReconciledGcVerdict {
	return (GC_RECONCILED_VERDICTS as Set<LaneProjectionGcVerdict>).has(verdict);
}

/**
 * Freshness of a GC receipt relative to a single projection row's own
 * generation. CCSYNC-07: a receipt is an authoritative reconciliation verdict
 * for a row only if it was generated no earlier than that row's current
 * projection generation (its `updated_at`, the lane's spawn/settle emission).
 * A receipt that PREDATES the projection generation describes a since-rebuilt
 * lane — applying its downgrade would re-stamp stale limbo onto a row the
 * projection has already refreshed (e.g. back to `running`), routing genuinely
 * live work out of the attention surface.
 *
 *  - `fresh`   — receipt generated at/after the projection generation → the
 *                receipt observed this row's current state; safe to apply.
 *  - `stale`   — receipt predates the projection generation → the row was
 *                rebuilt after the pass; the verdict is obsolete, ignore it.
 *  - `unknown` — either timestamp is absent/unparseable → freshness cannot be
 *                proven. Callers must NOT downgrade a live (`running`) row on an
 *                unproven receipt (never hide a live lane), but may still
 *                reconcile terminal rows where no live work is at risk.
 */
export type GcReceiptFreshness = "fresh" | "stale" | "unknown";

function parseTimestampMs(value: string | null | undefined): number | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
}

export function classifyGcReceiptFreshness(
	receiptGeneratedAt: string | null | undefined,
	projectionGeneratedAt: string | null | undefined,
): GcReceiptFreshness {
	const receiptMs = parseTimestampMs(receiptGeneratedAt);
	const projectionMs = parseTimestampMs(projectionGeneratedAt);
	if (receiptMs === null || projectionMs === null) return "unknown";
	return receiptMs >= projectionMs ? "fresh" : "stale";
}

/**
 * Human-readable label for a reconciled GC verdict, for the Command Central
 * audit surface (tree-row description/tooltip). CCSYNC-02: when an authoritative
 * lane-projection GC pass reconciles a row out of the live surface, an operator
 * must be able to SEE why it was cleared, not have it silently vanish from the
 * attention badge. `downgraded` is stale-read-model limbo (reconcile-needed);
 * `archived`/`removed` were taken off the live projection by the GC pass.
 */
export function gcReconcileVerdictLabel(verdict: ReconciledGcVerdict): string {
	switch (verdict) {
		case "downgraded":
			return "reconcile-needed";
		case "archived":
			return "archived (GC)";
		case "removed":
			return "removed (GC)";
	}
}

export function checkAdvertisedReviewQueue(
	task: ReviewQueueTaskShape,
): AdvertisedReviewQueueState {
	const declared =
		typeof task.pending_review_path === "string"
			? task.pending_review_path.trim()
			: "";
	if (!declared) return "absent";

	const projectDir =
		typeof task.project_dir === "string" ? task.project_dir : "";

	let resolvedPath: string;
	try {
		if (path.isAbsolute(declared)) {
			resolvedPath = path.resolve(declared);
		} else {
			if (!projectDir) return "unknown";
			const projectRoot = path.resolve(projectDir);
			const candidate = path.resolve(projectRoot, declared);
			const rel = path.relative(projectRoot, candidate);
			if (rel.startsWith("..") || path.isAbsolute(rel)) return "unknown";
			resolvedPath = candidate;
		}
	} catch {
		return "unknown";
	}

	try {
		const stat = fs.statSync(resolvedPath);
		if (stat.isDirectory()) return "missing";
		return "present";
	} catch (err) {
		if (
			err !== null &&
			typeof err === "object" &&
			"code" in err &&
			(err as { code?: unknown }).code === "ENOENT"
		) {
			return "missing";
		}
		return "unknown";
	}
}
