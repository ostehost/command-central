/**
 * Sync-readiness service (CCSYNC-04).
 *
 * Builds a per-project, host-labeled "sync readiness card" plus a
 * machine-readable receipt describing whether a repo on a given host is ready
 * to participate in a hub/node sync: its branch, upstream, ahead/behind against
 * the upstream, HEAD/tree hashes, working-tree dirty count, and a prioritized
 * list of blockers (dirty tree, divergence, detached HEAD, missing upstream,
 * pending reviews).
 *
 * This module is intentionally READ-ONLY: it only ever runs git query commands
 * (`rev-parse`, `status --porcelain`, `rev-list`) and never mutates a repo.
 *
 * Cross-machine reality: querying a REMOTE node's repo for parity needs live
 * cross-machine access, which this hub-side module cannot perform safely. So
 * node availability is a first-class input — a card for a node we could not (or
 * have not yet) reached carries an explicit `node-unavailable` /
 * `not-yet-queried` blocker and NO fabricated git facts. The hub side (the
 * current machine) is collected live via {@link collectHubSyncReadiness}.
 *
 * Reuse:
 *  - the ahead/behind parsing mirrors `evaluateRepoParity` in
 *    scripts-v2/prerelease-gate.ts (behind<TAB>ahead from
 *    `git rev-list --left-right --count`).
 *  - the V2 doctrine from src/utils/agent-status-sections.ts: absence is stated,
 *    never implied — a clean repo still renders an explicit empty-blocker card.
 */

import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

/** How a card's git facts were (or were not) obtained. */
export type SyncReadinessReachability =
	/** Facts collected live from the current machine (the hub). */
	| "local-hub"
	/** Facts supplied by a successful query of a remote node. */
	| "queried"
	/** The node could not be reached; facts are unknown. */
	| "node-unavailable"
	/** The node has not been queried yet; facts are unknown. */
	| "not-yet-queried";

/** A reachability value carries authoritative git facts. */
export function isReachable(
	reachability: SyncReadinessReachability,
): reachability is "local-hub" | "queried" {
	return reachability === "local-hub" || reachability === "queried";
}

/**
 * Blocker codes, ordered most-actionable first (operator action precedes a
 * passive "out of date"). Mirrors the action-before-review doctrine in
 * agent-status-sections.ts.
 */
export type SyncReadinessBlockerCode =
	| "node-unavailable"
	| "not-yet-queried"
	| "git-error"
	| "detached-head"
	| "no-upstream"
	| "dirty-tree"
	| "diverged"
	| "ahead"
	| "behind"
	| "pending-review";

/** Canonical severity ordering — lower index = surfaced first. */
const BLOCKER_PRIORITY: readonly SyncReadinessBlockerCode[] = [
	"node-unavailable",
	"not-yet-queried",
	"git-error",
	"detached-head",
	"no-upstream",
	"dirty-tree",
	"diverged",
	"ahead",
	"behind",
	"pending-review",
];

export interface SyncReadinessBlocker {
	code: SyncReadinessBlockerCode;
	/** Human-facing one-line reason. */
	message: string;
}

/**
 * Raw, already-collected inputs for the pure evaluator. The caller runs the
 * read-only git commands (or marks the node unreachable) so this stays a pure,
 * unit-testable function with no subprocess or filesystem access.
 */
export interface SyncReadinessProbeInput {
	/** Friendly project name (display). */
	project: string;
	/** Absolute repo path on its owning host. */
	projectDir: string;
	/** Host the repo lives on (hub or node). */
	host: string;
	reachability: SyncReadinessReachability;
	/**
	 * `git rev-parse --abbrev-ref HEAD` output. `"HEAD"` (the literal) means a
	 * detached HEAD. Omitted/empty when unreachable.
	 */
	branch?: string;
	/** Upstream ref name, e.g. `origin/main`. Omitted when no upstream. */
	upstream?: string;
	/** Short HEAD commit hash. Omitted when unreachable. */
	head?: string;
	/** Working-tree tree hash (`git rev-parse HEAD^{tree}`). Omitted when n/a. */
	tree?: string;
	/**
	 * `git status --porcelain` output. Each non-empty line is one dirty path.
	 * Omitted when unreachable.
	 */
	porcelain?: string;
	/**
	 * `git rev-list --left-right --count <upstream>...HEAD` output:
	 * "behind<TAB>ahead". Omitted when there is no upstream / unreachable.
	 */
	aheadBehind?: string;
	/** Count of pending (un-reviewed) lanes for this project on its host. */
	pendingReviewCount?: number;
	/** A git command failed; message captured here marks the card errored. */
	gitError?: string;
}

/** The machine-readable receipt — stable, JSON-serializable. */
export interface SyncReadinessReceipt {
	version: 1;
	project: string;
	projectDir: string;
	host: string;
	reachability: SyncReadinessReachability;
	/** Branch, or `null` when unknown / detached. */
	branch: string | null;
	/** `true` when HEAD is detached (branch === "HEAD"). */
	detachedHead: boolean;
	upstream: string | null;
	head: string | null;
	tree: string | null;
	ahead: number | null;
	behind: number | null;
	dirtyCount: number | null;
	pendingReviewCount: number;
	/** Prioritized blockers; empty array means ready. */
	blockers: SyncReadinessBlocker[];
	/** Convenience: blockers.length === 0 AND reachable. */
	ready: boolean;
}

function countDirtyLines(porcelain: string): number {
	return porcelain
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0).length;
}

/**
 * Parse "behind<TAB>ahead" (the `git rev-list --left-right --count` shape used
 * by evaluateRepoParity). Returns null/null when the value is unparseable.
 */
function parseAheadBehind(raw: string): {
	ahead: number | null;
	behind: number | null;
} {
	const [behindRaw = "", aheadRaw = ""] = raw.trim().split(/\s+/);
	const behind = Number.parseInt(behindRaw, 10);
	const ahead = Number.parseInt(aheadRaw, 10);
	if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
		return { ahead: null, behind: null };
	}
	return { ahead, behind };
}

function sortBlockers(
	blockers: SyncReadinessBlocker[],
): SyncReadinessBlocker[] {
	return [...blockers].sort(
		(a, b) =>
			BLOCKER_PRIORITY.indexOf(a.code) - BLOCKER_PRIORITY.indexOf(b.code),
	);
}

/**
 * Pure evaluator: fold raw probe inputs into a prioritized receipt. No I/O.
 *
 * Unreachable hosts (node-unavailable / not-yet-queried) short-circuit with a
 * single explicit blocker and NO fabricated git facts — the central CCSYNC-04
 * requirement that a node we cannot prove anything about is stated as such
 * rather than rendered as a falsely-clean repo.
 */
export function evaluateSyncReadiness(
	input: SyncReadinessProbeInput,
): SyncReadinessReceipt {
	const base: Omit<SyncReadinessReceipt, "blockers" | "ready"> = {
		version: 1,
		project: input.project,
		projectDir: input.projectDir,
		host: input.host,
		reachability: input.reachability,
		branch: null,
		detachedHead: false,
		upstream: null,
		head: null,
		tree: null,
		ahead: null,
		behind: null,
		dirtyCount: null,
		pendingReviewCount: input.pendingReviewCount ?? 0,
	};

	if (!isReachable(input.reachability)) {
		const code: SyncReadinessBlockerCode =
			input.reachability === "node-unavailable"
				? "node-unavailable"
				: "not-yet-queried";
		const message =
			code === "node-unavailable"
				? `Node ${input.host} is unavailable — repo parity not verified.`
				: `Node ${input.host} has not been queried yet — repo parity unknown.`;
		return { ...base, blockers: [{ code, message }], ready: false };
	}

	const blockers: SyncReadinessBlocker[] = [];

	if (input.gitError) {
		blockers.push({
			code: "git-error",
			message: `git query failed on ${input.host}: ${input.gitError}`,
		});
		return { ...base, blockers, ready: false };
	}

	const rawBranch = input.branch?.trim() ?? "";
	const detachedHead = rawBranch === "HEAD";
	const branch = rawBranch.length > 0 && !detachedHead ? rawBranch : null;
	const upstream = input.upstream?.trim() || null;
	const head = input.head?.trim() || null;
	const tree = input.tree?.trim() || null;
	const dirtyCount =
		input.porcelain !== undefined ? countDirtyLines(input.porcelain) : null;
	const { ahead, behind } =
		input.aheadBehind !== undefined
			? parseAheadBehind(input.aheadBehind)
			: { ahead: null, behind: null };

	if (detachedHead) {
		blockers.push({
			code: "detached-head",
			message: `HEAD is detached on ${input.host} — no branch to sync.`,
		});
	} else if (!upstream) {
		blockers.push({
			code: "no-upstream",
			message: `${branch ?? "current branch"} has no upstream on ${input.host}.`,
		});
	}

	if (dirtyCount !== null && dirtyCount > 0) {
		blockers.push({
			code: "dirty-tree",
			message: `${dirtyCount} uncommitted change(s) on ${input.host}.`,
		});
	}

	if (ahead !== null && behind !== null) {
		if (ahead > 0 && behind > 0) {
			blockers.push({
				code: "diverged",
				message: `Diverged from ${upstream ?? "upstream"}: ${ahead} ahead, ${behind} behind.`,
			});
		} else if (ahead > 0) {
			blockers.push({
				code: "ahead",
				message: `${ahead} commit(s) ahead of ${upstream ?? "upstream"}.`,
			});
		} else if (behind > 0) {
			blockers.push({
				code: "behind",
				message: `${behind} commit(s) behind ${upstream ?? "upstream"}.`,
			});
		}
	}

	const pendingReviewCount = input.pendingReviewCount ?? 0;
	if (pendingReviewCount > 0) {
		blockers.push({
			code: "pending-review",
			message: `${pendingReviewCount} lane(s) pending review on ${input.host}.`,
		});
	}

	const sorted = sortBlockers(blockers);
	return {
		...base,
		branch,
		detachedHead,
		upstream,
		head,
		tree,
		ahead,
		behind,
		dirtyCount,
		pendingReviewCount,
		blockers: sorted,
		ready: sorted.length === 0,
	};
}

/**
 * One-line card summary suited to a tree row description. Always states the
 * host and either "ready" or the highest-priority blocker count.
 *
 *   "rocinante · main → origin/main · ready"
 *   "rocinante · main → origin/main · 2 blockers (3 uncommitted change(s)…)"
 *   "node-7 · unavailable — repo parity not verified"
 */
export function formatSyncReadinessSummary(
	receipt: SyncReadinessReceipt,
): string {
	if (!isReachable(receipt.reachability)) {
		const first = receipt.blockers[0];
		return `${receipt.host} · ${first ? first.message : "unknown"}`;
	}

	const branchPart = receipt.detachedHead
		? "(detached HEAD)"
		: (receipt.branch ?? "(no branch)");
	const upstreamPart = receipt.upstream ? ` → ${receipt.upstream}` : "";
	const head = `${receipt.host} · ${branchPart}${upstreamPart}`;

	if (receipt.ready) return `${head} · ready`;

	const n = receipt.blockers.length;
	const lead = receipt.blockers[0]?.message ?? "";
	return `${head} · ${n} blocker${n === 1 ? "" : "s"} (${lead})`;
}

/** Injectable read-only git runner — overridable in tests. */
export type GitQueryRunner = (args: string[]) => string;

const DEFAULT_GIT_TIMEOUT_MS = 1_500;

function defaultGitRunner(projectDir: string): GitQueryRunner {
	return (args: string[]): string =>
		execFileSync("git", ["-C", projectDir, ...args], {
			encoding: "utf-8",
			timeout: DEFAULT_GIT_TIMEOUT_MS,
		}).trim();
}

export interface CollectHubSyncReadinessOptions {
	project?: string;
	/** Defaults to this machine's hostname. */
	host?: string;
	/** Pending un-reviewed lane count for this project on this host. */
	pendingReviewCount?: number;
	/** Test seam: inject a fake git runner. */
	runGit?: GitQueryRunner;
}

/**
 * Collect a live, READ-ONLY sync-readiness receipt for a repo on the CURRENT
 * machine (the hub). Runs only git query commands; never mutates the repo.
 *
 * Each git command is guarded independently: a failure that still lets us learn
 * something (e.g. no upstream → rev-list fails) degrades that field to unknown
 * rather than failing the whole card. A hard failure on the very first probe
 * (HEAD unreadable) yields a `git-error` card.
 */
export function collectHubSyncReadiness(
	projectDir: string,
	opts: CollectHubSyncReadinessOptions = {},
): SyncReadinessReceipt {
	const host = opts.host || os.hostname() || "unknown";
	const project = opts.project || path.basename(projectDir);
	const runGit = opts.runGit ?? defaultGitRunner(projectDir);

	let branch: string;
	try {
		branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
	} catch (error) {
		return evaluateSyncReadiness({
			project,
			projectDir,
			host,
			reachability: "local-hub",
			pendingReviewCount: opts.pendingReviewCount,
			gitError: (error as Error).message,
		});
	}

	const head = tryGit(runGit, ["rev-parse", "--short", "HEAD"]);
	const tree = tryGit(runGit, ["rev-parse", "--short", "HEAD^{tree}"]);
	const upstream = tryGit(runGit, [
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{upstream}",
	]);
	const porcelain = tryGit(runGit, ["status", "--porcelain"]) ?? "";
	const aheadBehind = upstream
		? tryGit(runGit, [
				"rev-list",
				"--left-right",
				"--count",
				`${upstream}...HEAD`,
			])
		: undefined;

	return evaluateSyncReadiness({
		project,
		projectDir,
		host,
		reachability: "local-hub",
		branch,
		upstream,
		head,
		tree,
		porcelain,
		aheadBehind,
		pendingReviewCount: opts.pendingReviewCount,
	});
}

/** Run a git query, returning trimmed output or undefined on failure. */
function tryGit(runGit: GitQueryRunner, args: string[]): string | undefined {
	try {
		const out = runGit(args).trim();
		return out.length > 0 ? out : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Build a not-yet-queried (or unavailable) card for a remote node whose repo we
 * cannot reach from the hub. This is the explicit cross-machine fallback: the
 * card states the gap rather than fabricating parity facts.
 */
export function buildUnreachableNodeCard(args: {
	project: string;
	projectDir: string;
	host: string;
	reachability: "node-unavailable" | "not-yet-queried";
}): SyncReadinessReceipt {
	return evaluateSyncReadiness({
		project: args.project,
		projectDir: args.projectDir,
		host: args.host,
		reachability: args.reachability,
	});
}

// ── Card rendering (pure) ────────────────────────────────────────────────────
//
// The tree provider owns *how* a card becomes a TreeItem; these pure helpers own
// *what* it says. Kept here (not in the provider) so the icon, the evidence
// breakdown, and the tooltip are unit-testable without driving the tree or
// touching git — the same I/O-free doctrine as agent-status-sections.ts.

/**
 * Codicon id for the card row, reflecting the receipt's headline state:
 *  - unreachable node → `question` (parity unknown, never a false green)
 *  - git query failed → `error`
 *  - reachable + ready → `pass-filled`
 *  - reachable + blocked → `warning`
 */
export function syncReadinessIconId(receipt: SyncReadinessReceipt): string {
	if (receipt.blockers.some((b) => b.code === "git-error")) return "error";
	if (!isReachable(receipt.reachability)) return "question";
	return receipt.ready ? "pass-filled" : "warning";
}

/** One expandable evidence row beneath a sync-readiness card. */
export interface SyncReadinessEvidenceRow {
	/** Dimension name, e.g. "Repo parity" / "Working tree". */
	label: string;
	/** The dimension's value, e.g. "main → origin/main" / "clean". */
	description: string;
	/** Codicon id signalling whether this dimension is a blocker. */
	icon: string;
}

function branchEvidenceRow(
	receipt: SyncReadinessReceipt,
): SyncReadinessEvidenceRow {
	if (receipt.detachedHead) {
		return {
			label: "Branch",
			description: "detached HEAD — no branch to sync",
			icon: "warning",
		};
	}
	const branch = receipt.branch ?? "(unknown branch)";
	if (!receipt.upstream) {
		return {
			label: "Branch",
			description: `${branch} · no upstream`,
			icon: "warning",
		};
	}
	return {
		label: "Branch",
		description: `${branch} → ${receipt.upstream}`,
		icon: "git-branch",
	};
}

function parityEvidenceRow(
	receipt: SyncReadinessReceipt,
): SyncReadinessEvidenceRow {
	const { ahead, behind } = receipt;
	if (ahead === null || behind === null) {
		return {
			label: "Repo parity",
			description: "unknown (no upstream)",
			icon: "dash",
		};
	}
	if (ahead === 0 && behind === 0) {
		return {
			label: "Repo parity",
			description: "in sync (0 ahead · 0 behind)",
			icon: "check",
		};
	}
	if (ahead > 0 && behind > 0) {
		return {
			label: "Repo parity",
			description: `diverged — ${ahead} ahead · ${behind} behind`,
			icon: "warning",
		};
	}
	return {
		label: "Repo parity",
		description: ahead > 0 ? `${ahead} ahead` : `${behind} behind`,
		icon: "warning",
	};
}

function dirtyTreeEvidenceRow(
	receipt: SyncReadinessReceipt,
): SyncReadinessEvidenceRow {
	if (receipt.dirtyCount === null) {
		return { label: "Working tree", description: "unknown", icon: "dash" };
	}
	if (receipt.dirtyCount === 0) {
		return { label: "Working tree", description: "clean", icon: "check" };
	}
	return {
		label: "Working tree",
		description: `${receipt.dirtyCount} uncommitted change(s)`,
		icon: "warning",
	};
}

function reviewQueueEvidenceRow(
	receipt: SyncReadinessReceipt,
): SyncReadinessEvidenceRow {
	if (receipt.pendingReviewCount === 0) {
		return { label: "Review queue", description: "clear", icon: "check" };
	}
	return {
		label: "Review queue",
		description: `${receipt.pendingReviewCount} lane(s) pending review`,
		icon: "warning",
	};
}

/**
 * The card's expandable children: one row per evidence dimension named in the
 * card's contract — branch, repo parity, working tree (dirty), and review queue
 * — plus a HEAD/tree provenance row. An unreachable node yields ONLY its
 * explicit gap blocker(s) (no fabricated git facts); a git-error yields a single
 * error row.
 */
export function buildSyncReadinessEvidenceRows(
	receipt: SyncReadinessReceipt,
): SyncReadinessEvidenceRow[] {
	const gitError = receipt.blockers.find((b) => b.code === "git-error");
	if (gitError) {
		return [{ label: "Error", description: gitError.message, icon: "error" }];
	}
	if (!isReachable(receipt.reachability)) {
		return receipt.blockers.map((b) => ({
			label: "Status",
			description: b.message,
			icon: "question",
		}));
	}

	const rows: SyncReadinessEvidenceRow[] = [
		branchEvidenceRow(receipt),
		parityEvidenceRow(receipt),
		dirtyTreeEvidenceRow(receipt),
		reviewQueueEvidenceRow(receipt),
	];
	if (receipt.head) {
		rows.push({
			label: "HEAD",
			description: receipt.tree
				? `${receipt.head} · tree ${receipt.tree}`
				: receipt.head,
			icon: "git-commit",
		});
	}
	return rows;
}

/**
 * Multi-line hover tooltip for the card. States the host and reachability up
 * front, then the evidence breakdown, then either "Ready to sync." or the
 * prioritized blocker list. Honors the unreachable contract: a node we cannot
 * reach lists its gap, never invented parity facts.
 */
export function formatSyncReadinessTooltip(
	receipt: SyncReadinessReceipt,
): string {
	const lines = [
		`Sync readiness — ${receipt.project}`,
		`Host: ${receipt.host} (${receipt.reachability})`,
	];
	if (receipt.blockers.some((b) => b.code === "git-error")) {
		lines.push("", ...receipt.blockers.map((b) => `• ${b.message}`));
		return lines.join("\n");
	}
	if (!isReachable(receipt.reachability)) {
		lines.push("", ...receipt.blockers.map((b) => `• ${b.message}`));
		return lines.join("\n");
	}
	for (const row of buildSyncReadinessEvidenceRows(receipt)) {
		lines.push(`${row.label}: ${row.description}`);
	}
	if (receipt.ready) {
		lines.push("", "Ready to sync.");
	} else {
		lines.push(
			"",
			"Blockers:",
			...receipt.blockers.map((b) => `• ${b.message}`),
		);
	}
	return lines.join("\n");
}
