/**
 * Tests for the sync-readiness service (CCSYNC-04 / PAR-229).
 *
 * Covers the pure evaluator (`evaluateSyncReadiness`), the one-line summary,
 * and the live hub collector (`collectHubSyncReadiness`) with an injected git
 * runner so no real subprocess runs.
 *
 * The load-bearing regression guard is the cross-machine fallback: a node we
 * cannot reach must yield an EXPLICIT `node-unavailable` / `not-yet-queried`
 * blocker and NO fabricated git facts — never a falsely-clean "ready" card.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildSyncReadinessEvidenceRows,
	buildUnreachableNodeCard,
	collectHubSyncReadiness,
	evaluateSyncReadiness,
	formatSyncReadinessSummary,
	formatSyncReadinessTooltip,
	type GitQueryRunner,
	ingestNodeSyncReadinessReceipt,
	isReachable,
	nodeSyncReadinessReceiptPath,
	readNodeSyncReadinessReceipt,
	syncReadinessIconId,
} from "../../src/services/sync-readiness-service.js";

const CLEAN: Parameters<typeof evaluateSyncReadiness>[0] = {
	project: "command-central",
	projectDir: "/Users/me/projects/command-central",
	host: "rocinante",
	reachability: "local-hub",
	branch: "main",
	upstream: "origin/main",
	head: "abc1234",
	tree: "def5678",
	porcelain: "",
	aheadBehind: "0\t0",
	pendingReviewCount: 0,
};

describe("evaluateSyncReadiness — reachable hub", () => {
	test("clean repo at upstream is ready with no blockers", () => {
		const r = evaluateSyncReadiness(CLEAN);
		expect(r.ready).toBe(true);
		expect(r.blockers).toEqual([]);
		expect(r.branch).toBe("main");
		expect(r.upstream).toBe("origin/main");
		expect(r.head).toBe("abc1234");
		expect(r.tree).toBe("def5678");
		expect(r.ahead).toBe(0);
		expect(r.behind).toBe(0);
		expect(r.dirtyCount).toBe(0);
		expect(r.detachedHead).toBe(false);
	});

	test("dirty tree counts non-empty porcelain lines", () => {
		const r = evaluateSyncReadiness({
			...CLEAN,
			porcelain: " M src/a.ts\n?? out.txt\n\n M src/b.ts\n",
		});
		expect(r.dirtyCount).toBe(3);
		expect(r.ready).toBe(false);
		expect(r.blockers.map((b) => b.code)).toContain("dirty-tree");
	});

	test("ahead/behind parse as behind<TAB>ahead and diverge", () => {
		const r = evaluateSyncReadiness({ ...CLEAN, aheadBehind: "2\t3" });
		expect(r.behind).toBe(2);
		expect(r.ahead).toBe(3);
		expect(r.blockers.map((b) => b.code)).toContain("diverged");
	});

	test("ahead-only and behind-only are distinct blockers", () => {
		expect(
			evaluateSyncReadiness({ ...CLEAN, aheadBehind: "0\t4" }).blockers.map(
				(b) => b.code,
			),
		).toEqual(["ahead"]);
		expect(
			evaluateSyncReadiness({ ...CLEAN, aheadBehind: "5\t0" }).blockers.map(
				(b) => b.code,
			),
		).toEqual(["behind"]);
	});

	test("detached HEAD blocks and never reports a branch", () => {
		const r = evaluateSyncReadiness({
			...CLEAN,
			branch: "HEAD",
			upstream: undefined,
			aheadBehind: undefined,
		});
		expect(r.detachedHead).toBe(true);
		expect(r.branch).toBeNull();
		expect(r.blockers.map((b) => b.code)).toContain("detached-head");
	});

	test("missing upstream is a blocker", () => {
		const r = evaluateSyncReadiness({
			...CLEAN,
			upstream: undefined,
			aheadBehind: undefined,
		});
		expect(r.upstream).toBeNull();
		expect(r.blockers.map((b) => b.code)).toContain("no-upstream");
	});

	test("pending reviews surface as a blocker", () => {
		const r = evaluateSyncReadiness({ ...CLEAN, pendingReviewCount: 4 });
		expect(r.pendingReviewCount).toBe(4);
		expect(r.blockers.map((b) => b.code)).toContain("pending-review");
	});

	test("a live in-flight lane is a blocker", () => {
		const r = evaluateSyncReadiness({ ...CLEAN, liveLaneCount: 2 });
		expect(r.liveLaneCount).toBe(2);
		expect(r.ready).toBe(false);
		const live = r.blockers.find((b) => b.code === "live-lane");
		expect(live).toBeDefined();
		expect(live?.message).toContain("2 live lane");
	});

	test("blockers are prioritized action-first (dirty before behind before review)", () => {
		const r = evaluateSyncReadiness({
			...CLEAN,
			porcelain: " M a\n",
			aheadBehind: "3\t0",
			pendingReviewCount: 1,
		});
		expect(r.blockers.map((b) => b.code)).toEqual([
			"dirty-tree",
			"behind",
			"pending-review",
		]);
	});

	test("live-lane outranks dirty/divergent/pending-review in priority order", () => {
		const r = evaluateSyncReadiness({
			...CLEAN,
			liveLaneCount: 1,
			porcelain: " M a\n",
			aheadBehind: "2\t3",
			pendingReviewCount: 4,
		});
		expect(r.blockers.map((b) => b.code)).toEqual([
			"live-lane",
			"dirty-tree",
			"diverged",
			"pending-review",
		]);
	});

	test("git-error short-circuits to a single git-error blocker", () => {
		const r = evaluateSyncReadiness({
			project: "x",
			projectDir: "/x",
			host: "rocinante",
			reachability: "local-hub",
			gitError: "fatal: not a git repository",
		});
		expect(r.ready).toBe(false);
		expect(r.blockers.map((b) => b.code)).toEqual(["git-error"]);
	});
});

describe("evaluateSyncReadiness — unreachable node (CCSYNC-04 core)", () => {
	test("not-yet-queried node fabricates NO git facts", () => {
		const r = evaluateSyncReadiness({
			project: "infra",
			projectDir: "/srv/infra",
			host: "node-7",
			reachability: "not-yet-queried",
			// Even if a caller leaks stale facts, an unreachable card must drop them.
			branch: "main",
			head: "stale99",
			porcelain: " M leaked.ts",
			aheadBehind: "9\t9",
		});
		expect(isReachable(r.reachability)).toBe(false);
		expect(r.ready).toBe(false);
		expect(r.branch).toBeNull();
		expect(r.head).toBeNull();
		expect(r.tree).toBeNull();
		expect(r.ahead).toBeNull();
		expect(r.behind).toBeNull();
		expect(r.dirtyCount).toBeNull();
		expect(r.blockers.map((b) => b.code)).toEqual(["not-yet-queried"]);
	});

	test("node-unavailable yields exactly one explicit blocker", () => {
		const r = buildUnreachableNodeCard({
			project: "infra",
			projectDir: "/srv/infra",
			host: "node-7",
			reachability: "node-unavailable",
		});
		expect(r.blockers).toHaveLength(1);
		expect(r.blockers[0]?.code).toBe("node-unavailable");
		expect(r.blockers[0]?.message).toContain("node-7");
	});
});

describe("formatSyncReadinessSummary", () => {
	test("ready card states host, branch, upstream", () => {
		expect(formatSyncReadinessSummary(evaluateSyncReadiness(CLEAN))).toBe(
			"rocinante · main → origin/main · ready",
		);
	});

	test("blocked card leads with highest-priority blocker", () => {
		const summary = formatSyncReadinessSummary(
			evaluateSyncReadiness({
				...CLEAN,
				porcelain: " M a\n",
				aheadBehind: "1\t0",
			}),
		);
		expect(summary).toContain("2 blockers");
		expect(summary).toContain("uncommitted change");
	});

	test("unreachable card states the gap, not a branch", () => {
		const summary = formatSyncReadinessSummary(
			buildUnreachableNodeCard({
				project: "infra",
				projectDir: "/srv/infra",
				host: "node-7",
				reachability: "node-unavailable",
			}),
		);
		expect(summary).toContain("node-7");
		expect(summary).toContain("unavailable");
	});
});

describe("collectHubSyncReadiness — read-only live collector", () => {
	function fakeRunner(
		responses: Record<string, string>,
		seen: string[],
	): GitQueryRunner {
		return (args: string[]): string => {
			const key = args.join(" ");
			seen.push(key);
			const match = Object.entries(responses).find(([k]) => key.startsWith(k));
			if (!match) throw new Error(`no fake response for: ${key}`);
			return match[1];
		};
	}

	test("collects a clean repo into a ready receipt using only query verbs", () => {
		const seen: string[] = [];
		const r = collectHubSyncReadiness("/repo", {
			project: "demo",
			host: "rocinante",
			pendingReviewCount: 0,
			runGit: fakeRunner(
				{
					"rev-parse --abbrev-ref HEAD": "main",
					"rev-parse --short HEAD^{tree}": "tree99",
					"rev-parse --short HEAD": "head99",
					"rev-parse --abbrev-ref --symbolic-full-name @{upstream}":
						"origin/main",
					"status --porcelain": "",
					"rev-list --left-right --count": "0\t0",
				},
				seen,
			),
		});
		expect(r.ready).toBe(true);
		expect(r.branch).toBe("main");
		expect(r.head).toBe("head99");
		expect(r.tree).toBe("tree99");
		expect(r.upstream).toBe("origin/main");
		// READ-ONLY contract: every git verb invoked is a query, never a mutation.
		const mutating =
			/^(commit|push|pull|merge|rebase|reset|checkout|switch|fetch|clean|add|rm|stash|cherry-pick|tag|apply)\b/;
		for (const cmd of seen) {
			expect(mutating.test(cmd)).toBe(false);
		}
		expect(seen.some((c) => c.startsWith("rev-parse --abbrev-ref HEAD"))).toBe(
			true,
		);
	});

	test("no upstream skips rev-list and surfaces no-upstream", () => {
		const seen: string[] = [];
		const r = collectHubSyncReadiness("/repo", {
			project: "demo",
			host: "rocinante",
			runGit: (args: string[]): string => {
				const key = args.join(" ");
				seen.push(key);
				if (key === "rev-parse --abbrev-ref HEAD") return "feature";
				if (key === "status --porcelain") return "";
				if (key === "rev-parse --short HEAD") return "h1";
				if (key === "rev-parse --short HEAD^{tree}") return "t1";
				// upstream lookup + any rev-list fails
				throw new Error("fatal: no upstream configured");
			},
		});
		expect(r.upstream).toBeNull();
		expect(r.blockers.map((b) => b.code)).toContain("no-upstream");
		// rev-list must NOT be attempted when there is no upstream.
		expect(seen.some((c) => c.startsWith("rev-list"))).toBe(false);
	});

	test("HEAD probe failure produces a git-error card", () => {
		const r = collectHubSyncReadiness("/not-a-repo", {
			project: "demo",
			host: "rocinante",
			runGit: () => {
				throw new Error("fatal: not a git repository");
			},
		});
		expect(r.blockers.map((b) => b.code)).toEqual(["git-error"]);
		expect(r.reachability).toBe("local-hub");
	});
});

describe("syncReadinessIconId", () => {
	test("ready hub → pass-filled", () => {
		expect(syncReadinessIconId(evaluateSyncReadiness(CLEAN))).toBe(
			"pass-filled",
		);
	});

	test("blocked hub → warning", () => {
		expect(
			syncReadinessIconId(
				evaluateSyncReadiness({ ...CLEAN, porcelain: " M a\n" }),
			),
		).toBe("warning");
	});

	test("unreachable node → question", () => {
		expect(
			syncReadinessIconId(
				buildUnreachableNodeCard({
					project: "x",
					projectDir: "/x",
					host: "node-7",
					reachability: "not-yet-queried",
				}),
			),
		).toBe("question");
	});

	test("git-error → error (wins over reachability)", () => {
		expect(
			syncReadinessIconId(
				evaluateSyncReadiness({
					project: "x",
					projectDir: "/x",
					host: "rocinante",
					reachability: "local-hub",
					gitError: "fatal: not a git repository",
				}),
			),
		).toBe("error");
	});
});

describe("buildSyncReadinessEvidenceRows", () => {
	test("clean repo renders branch/parity/dirty/queue/HEAD, all green", () => {
		const rows = buildSyncReadinessEvidenceRows(evaluateSyncReadiness(CLEAN));
		const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
		expect(byLabel["Branch"]?.description).toBe("main → origin/main");
		expect(byLabel["Repo parity"]?.description).toBe(
			"in sync (0 ahead · 0 behind)",
		);
		expect(byLabel["Working tree"]?.description).toBe("clean");
		expect(byLabel["Review queue"]?.description).toBe("clear");
		expect(byLabel["HEAD"]?.description).toBe("abc1234 · tree def5678");
		// Clean dimensions never wear a warning icon.
		for (const label of ["Repo parity", "Working tree", "Review queue"]) {
			expect(byLabel[label]?.icon).not.toBe("warning");
		}
	});

	test("dirty + diverged + pending-review flag each dimension as a warning", () => {
		const rows = buildSyncReadinessEvidenceRows(
			evaluateSyncReadiness({
				...CLEAN,
				porcelain: " M a\n?? b\n",
				aheadBehind: "2\t3",
				pendingReviewCount: 4,
			}),
		);
		const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
		expect(byLabel["Working tree"]).toEqual({
			label: "Working tree",
			description: "2 uncommitted change(s)",
			icon: "warning",
		});
		expect(byLabel["Repo parity"]?.description).toBe(
			"diverged — 3 ahead · 2 behind",
		);
		expect(byLabel["Repo parity"]?.icon).toBe("warning");
		expect(byLabel["Review queue"]?.description).toBe(
			"4 lane(s) pending review",
		);
		expect(byLabel["Review queue"]?.icon).toBe("warning");
	});

	test("a Live work row appears only when a lane is in flight", () => {
		const clean = buildSyncReadinessEvidenceRows(evaluateSyncReadiness(CLEAN));
		expect(clean.some((r) => r.label === "Live work")).toBe(false);

		const live = buildSyncReadinessEvidenceRows(
			evaluateSyncReadiness({ ...CLEAN, liveLaneCount: 2 }),
		).find((r) => r.label === "Live work");
		expect(live).toEqual({
			label: "Live work",
			description: "2 lane(s) in flight",
			icon: "warning",
		});
	});

	test("detached HEAD and missing upstream surface on the branch row", () => {
		const detached = buildSyncReadinessEvidenceRows(
			evaluateSyncReadiness({
				...CLEAN,
				branch: "HEAD",
				upstream: undefined,
				aheadBehind: undefined,
			}),
		).find((r) => r.label === "Branch");
		expect(detached?.description).toContain("detached HEAD");
		expect(detached?.icon).toBe("warning");

		const noUpstream = buildSyncReadinessEvidenceRows(
			evaluateSyncReadiness({
				...CLEAN,
				upstream: undefined,
				aheadBehind: undefined,
			}),
		).find((r) => r.label === "Branch");
		expect(noUpstream?.description).toBe("main · no upstream");
		expect(noUpstream?.icon).toBe("warning");
	});

	test("unreachable node yields ONLY its gap blocker — no fabricated facts", () => {
		const rows = buildSyncReadinessEvidenceRows(
			buildUnreachableNodeCard({
				project: "infra",
				projectDir: "/srv/infra",
				host: "node-7",
				reachability: "node-unavailable",
			}),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.icon).toBe("question");
		expect(rows[0]?.description).toContain("node-7");
		// No branch/parity/dirty rows are invented for an unreachable node.
		expect(rows.some((r) => r.label === "Repo parity")).toBe(false);
	});

	test("git-error yields a single error row", () => {
		const rows = buildSyncReadinessEvidenceRows(
			evaluateSyncReadiness({
				project: "x",
				projectDir: "/x",
				host: "rocinante",
				reachability: "local-hub",
				gitError: "fatal: not a git repository",
			}),
		);
		expect(rows).toEqual([
			{
				label: "Error",
				description:
					"git query failed on rocinante: fatal: not a git repository",
				icon: "error",
			},
		]);
	});
});

describe("formatSyncReadinessTooltip", () => {
	test("ready card states host, evidence, and Ready to sync", () => {
		const tip = formatSyncReadinessTooltip(evaluateSyncReadiness(CLEAN));
		expect(tip).toContain("Host: rocinante (local-hub)");
		expect(tip).toContain("Repo parity: in sync (0 ahead · 0 behind)");
		expect(tip).toContain("Ready to sync.");
	});

	test("blocked card lists prioritized blockers, not 'Ready'", () => {
		const tip = formatSyncReadinessTooltip(
			evaluateSyncReadiness({ ...CLEAN, porcelain: " M a\n" }),
		);
		expect(tip).toContain("Blockers:");
		expect(tip).toContain("uncommitted change");
		expect(tip).not.toContain("Ready to sync.");
	});

	test("unreachable card states the gap, fabricates no parity line", () => {
		const tip = formatSyncReadinessTooltip(
			buildUnreachableNodeCard({
				project: "infra",
				projectDir: "/srv/infra",
				host: "node-7",
				reachability: "not-yet-queried",
			}),
		);
		expect(tip).toContain("node-7");
		expect(tip).not.toContain("Repo parity:");
	});
});

describe("ingestNodeSyncReadinessReceipt — node-queried seam", () => {
	const EXPECTED = {
		host: "node-7",
		project: "infra",
		projectDir: "/srv/infra",
	};

	test("a node's published facts fold into a real 'queried' receipt", () => {
		const r = ingestNodeSyncReadinessReceipt(
			{
				host: "node-7",
				project: "infra",
				projectDir: "/srv/infra",
				branch: "main",
				upstream: "origin/main",
				head: "n0de12",
				tree: "tr33ee",
				porcelain: "",
				aheadBehind: "0\t0",
				pendingReviewCount: 0,
			},
			EXPECTED,
		);
		expect(r).not.toBeNull();
		if (!r) return;
		expect(r.reachability).toBe("queried");
		expect(isReachable(r.reachability)).toBe(true);
		expect(r.ready).toBe(true);
		expect(r.branch).toBe("main");
		expect(r.upstream).toBe("origin/main");
		expect(r.head).toBe("n0de12");
		expect(r.tree).toBe("tr33ee");
		expect(r.dirtyCount).toBe(0);
	});

	test("a queried node still surfaces its own blockers (never auto-green)", () => {
		const r = ingestNodeSyncReadinessReceipt(
			{
				host: "node-7",
				project: "infra",
				branch: "main",
				upstream: "origin/main",
				porcelain: " M a\n?? b\n",
				aheadBehind: "0\t1",
			},
			EXPECTED,
		);
		expect(r?.reachability).toBe("queried");
		expect(r?.ready).toBe(false);
		expect(r?.dirtyCount).toBe(2);
		expect(r?.blockers.map((b) => b.code)).toEqual(["dirty-tree", "ahead"]);
	});

	test("a node may self-declare node-unavailable — no fabricated facts", () => {
		const r = ingestNodeSyncReadinessReceipt(
			{ host: "node-7", project: "infra", reachability: "node-unavailable" },
			EXPECTED,
		);
		expect(r?.reachability).toBe("node-unavailable");
		expect(r?.ready).toBe(false);
		expect(r?.branch).toBeNull();
		expect(r?.blockers.map((b) => b.code)).toEqual(["node-unavailable"]);
	});

	test("a receipt attributed to a DIFFERENT host is rejected (no mis-label)", () => {
		expect(
			ingestNodeSyncReadinessReceipt(
				{ host: "node-9", project: "infra", branch: "main" },
				EXPECTED,
			),
		).toBeNull();
	});

	test("malformed payloads are rejected", () => {
		expect(ingestNodeSyncReadinessReceipt(null, EXPECTED)).toBeNull();
		expect(ingestNodeSyncReadinessReceipt("nope", EXPECTED)).toBeNull();
		expect(ingestNodeSyncReadinessReceipt([], EXPECTED)).toBeNull();
		// Missing host → cannot attribute → rejected.
		expect(
			ingestNodeSyncReadinessReceipt({ project: "infra" }, EXPECTED),
		).toBeNull();
	});
});

describe("readNodeSyncReadinessReceipt — file-backed seam", () => {
	const dirs: string[] = [];

	function scratchDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sync-readiness-"));
		dirs.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a fresh published file reads back as a 'queried' card", () => {
		const dir = scratchDir();
		const file = nodeSyncReadinessReceiptPath("node-7", "infra", dir);
		fs.writeFileSync(
			file,
			JSON.stringify({
				host: "node-7",
				project: "infra",
				projectDir: "/srv/infra",
				branch: "main",
				upstream: "origin/main",
				head: "n0de12",
				tree: "tr33ee",
				porcelain: "",
				aheadBehind: "0\t0",
			}),
		);
		const r = readNodeSyncReadinessReceipt(
			{ host: "node-7", project: "infra", projectDir: "/srv/infra" },
			{ dir },
		);
		expect(r?.reachability).toBe("queried");
		expect(r?.ready).toBe(true);
		expect(r?.branch).toBe("main");
	});

	test("a missing file yields null (caller renders not-yet-queried)", () => {
		const dir = scratchDir();
		expect(
			readNodeSyncReadinessReceipt(
				{ host: "ghost", project: "infra" },
				{ dir },
			),
		).toBeNull();
	});

	test("a stale file (older than maxAge) is ignored", () => {
		const dir = scratchDir();
		const file = nodeSyncReadinessReceiptPath("node-7", "infra", dir);
		fs.writeFileSync(
			file,
			JSON.stringify({ host: "node-7", project: "infra", branch: "main" }),
		);
		const stat = fs.statSync(file);
		const r = readNodeSyncReadinessReceipt(
			{ host: "node-7", project: "infra" },
			{ dir, maxAgeMs: 1000, nowMs: stat.mtimeMs + 60_000 },
		);
		expect(r).toBeNull();
	});
});
