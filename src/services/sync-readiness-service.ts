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
 * current machine) is collected live via {@link collectHubSyncReadiness}; a node
 * that publishes its own facts upgrades to a real `queried` card through the
 * receipt seam ({@link readNodeSyncReadinessReceipt}). A node status is never
 * green unless the node was actually queried.
 *
 * Reuse:
 *  - the ahead/behind parsing mirrors `evaluateRepoParity` in
 *    scripts-v2/prerelease-gate.ts (behind<TAB>ahead from
 *    `git rev-list --left-right --count`).
 *  - the V2 doctrine from src/utils/agent-status-sections.ts: absence is stated,
 *    never implied — a clean repo still renders an explicit empty-blocker card.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
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
	| "live-lane"
	| "dirty-tree"
	| "diverged"
	| "ahead"
	| "behind"
	| "pending-review";

/**
 * Canonical severity ordering — lower index = surfaced first. `live-lane`
 * (an agent is actively working the repo) ranks above the working-tree/parity
 * cluster: syncing while a lane is mid-flight is the strongest "do not touch
 * yet" signal, and any dirtiness/divergence it would report is itself in
 * motion.
 */
const BLOCKER_PRIORITY: readonly SyncReadinessBlockerCode[] = [
	"node-unavailable",
	"not-yet-queried",
	"git-error",
	"detached-head",
	"no-upstream",
	"live-lane",
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
	/**
	 * Count of lanes for this project on its host that are actively live (a
	 * running agent with a live pane/process). A non-zero count blocks sync: an
	 * agent is mid-flight and the tree/parity it would report is in motion.
	 */
	liveLaneCount?: number;
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
	/** Count of actively-live lanes on this host (0 when none / unknown). */
	liveLaneCount: number;
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
		liveLaneCount: input.liveLaneCount ?? 0,
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

	const liveLaneCount = input.liveLaneCount ?? 0;
	if (liveLaneCount > 0) {
		blockers.push({
			code: "live-lane",
			message: `${liveLaneCount} live lane(s) working ${input.host} — sync would race in-flight work.`,
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
	/** Count of actively-live lanes for this project on this host. */
	liveLaneCount?: number;
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
			liveLaneCount: opts.liveLaneCount,
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
		liveLaneCount: opts.liveLaneCount,
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

// ── Remote-node receipt seam (live cross-machine query, deferred) ────────────
//
// The hub cannot reach a node's repo to collect parity live (no safe
// cross-machine transport in this slice). Rather than fabricate green facts,
// the default node card is an explicit `not-yet-queried`. This seam lets a
// node that CAN see its own repo publish a pre-collected receipt the hub reads,
// upgrading that card to a real `queried` state with the node's own git facts.
//
// Contract (mirrors the pending-review receipt pattern, `CC_PENDING_REVIEW_DIR`):
//   • The node runs the SAME read-only git queries locally and writes the raw
//     outputs to `${CC_SYNC_READINESS_DIR:-/tmp/oste-sync-readiness}/
//     <host>__<project>.json` (a {@link NodeSyncReadinessReceiptPayload}).
//   • The hub reads that file (best-effort, freshness-gated) and re-evaluates it
//     under `reachability: "queried"`. A node that knows it is going offline can
//     instead set `reachability: "node-unavailable"` to publish the gap honestly.
//   • A stale, missing, malformed, or mis-attributed receipt yields null — the
//     hub then renders the explicit `not-yet-queried` card. A node status is
//     therefore NEVER green unless the node actually published fresh facts.
//
// FOLLOW-UP (remaining live-query work, out of scope for this slice): wire a
// node-side collector (a launcher/OpenClaw hook running `collectHubSyncReadiness`
// on the node and serializing the receipt) plus a hub-side transport that drops
// the receipt into `CC_SYNC_READINESS_DIR`. Until that exists, the seam is read
// by the provider but only ever finds receipts a test or external tool wrote.

/** Raw node-published payload (all fields validated; unknown shapes rejected). */
export interface NodeSyncReadinessReceiptPayload {
	project?: unknown;
	projectDir?: unknown;
	host?: unknown;
	/** A node may self-declare `node-unavailable` / `not-yet-queried`. */
	reachability?: unknown;
	branch?: unknown;
	upstream?: unknown;
	head?: unknown;
	tree?: unknown;
	porcelain?: unknown;
	aheadBehind?: unknown;
	pendingReviewCount?: unknown;
	liveLaneCount?: unknown;
	gitError?: unknown;
}

function asTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/** Local host-name normalizer (kept here to avoid a provider import cycle). */
function normalizeSyncHost(host: string): string {
	return host
		.trim()
		.toLowerCase()
		.replace(/\.local$/, "");
}

/**
 * Validate a node-published payload and fold it into a `queried` receipt with
 * the node's own facts. Returns null when the payload is not an object, omits a
 * host, or is attributed to a DIFFERENT host than the card we are filling (so a
 * stray/stale file can never mis-label another node). A payload that declares
 * itself unreachable produces the explicit gap card instead of a fake green.
 */
export function ingestNodeSyncReadinessReceipt(
	raw: unknown,
	expected: { host: string; project: string; projectDir?: string },
): SyncReadinessReceipt | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const p = raw as NodeSyncReadinessReceiptPayload;
	const host = asTrimmedString(p.host);
	if (!host) return null;
	if (normalizeSyncHost(host) !== normalizeSyncHost(expected.host)) return null;
	const project = asTrimmedString(p.project) ?? expected.project;
	const projectDir = asTrimmedString(p.projectDir) ?? expected.projectDir ?? "";

	const declared = asTrimmedString(p.reachability);
	if (declared === "node-unavailable" || declared === "not-yet-queried") {
		return evaluateSyncReadiness({
			project,
			projectDir,
			host,
			reachability: declared,
		});
	}

	return evaluateSyncReadiness({
		project,
		projectDir,
		host,
		reachability: "queried",
		branch: asTrimmedString(p.branch),
		upstream: asTrimmedString(p.upstream),
		head: asTrimmedString(p.head),
		tree: asTrimmedString(p.tree),
		porcelain: typeof p.porcelain === "string" ? p.porcelain : undefined,
		aheadBehind: asTrimmedString(p.aheadBehind),
		pendingReviewCount: asFiniteNumber(p.pendingReviewCount),
		liveLaneCount: asFiniteNumber(p.liveLaneCount),
		gitError: asTrimmedString(p.gitError),
	});
}

const DEFAULT_NODE_RECEIPT_DIR = "/tmp/oste-sync-readiness";
const DEFAULT_NODE_RECEIPT_MAX_AGE_MS = 15 * 60_000;

/** The directory node receipts are published to (`CC_SYNC_READINESS_DIR`). */
export function nodeSyncReadinessReceiptDir(): string {
	const override = process.env["CC_SYNC_READINESS_DIR"]?.trim();
	return override && override.length > 0 ? override : DEFAULT_NODE_RECEIPT_DIR;
}

function syncReadinessSlug(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "_"
	);
}

/** Deterministic per-(host, project) receipt file path under `dir`. */
export function nodeSyncReadinessReceiptPath(
	host: string,
	project: string,
	dir: string = nodeSyncReadinessReceiptDir(),
): string {
	return path.join(
		dir,
		`${syncReadinessSlug(host)}__${syncReadinessSlug(project)}.json`,
	);
}

export interface ReadNodeSyncReadinessOptions {
	dir?: string;
	/** Receipts older than this (by file mtime) are ignored as stale. */
	maxAgeMs?: number;
	/** Test seam: current epoch ms (defaults to Date.now()). */
	nowMs?: number;
}

/**
 * Best-effort read of a node-published sync-readiness receipt. Returns the
 * `queried` (or node-declared gap) receipt when a fresh, well-formed,
 * correctly-attributed file exists; null otherwise (missing / stale / malformed
 * → caller renders the explicit not-yet-queried card). Never throws.
 */
export function readNodeSyncReadinessReceipt(
	expected: { host: string; project: string; projectDir?: string },
	opts: ReadNodeSyncReadinessOptions = {},
): SyncReadinessReceipt | null {
	const dir = opts.dir ?? nodeSyncReadinessReceiptDir();
	const file = nodeSyncReadinessReceiptPath(
		expected.host,
		expected.project,
		dir,
	);
	try {
		const stat = fs.statSync(file);
		const maxAge = opts.maxAgeMs ?? DEFAULT_NODE_RECEIPT_MAX_AGE_MS;
		const now = opts.nowMs ?? Date.now();
		if (now - stat.mtimeMs > maxAge) return null;
		const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
		return ingestNodeSyncReadinessReceipt(raw, expected);
	} catch {
		return null;
	}
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
 * Live-work row — only emitted when a lane is actively in-flight on this host
 * (gated on count so the steady-state card is unchanged). A live lane is a
 * blocker: the working tree/parity is in motion.
 */
function liveLaneEvidenceRow(
	receipt: SyncReadinessReceipt,
): SyncReadinessEvidenceRow | null {
	if (receipt.liveLaneCount <= 0) return null;
	return {
		label: "Live work",
		description: `${receipt.liveLaneCount} lane(s) in flight`,
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
	const liveRow = liveLaneEvidenceRow(receipt);
	if (liveRow) rows.push(liveRow);
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
