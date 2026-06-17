/**
 * AgentStatusTreeProvider — a stale `running` REVIEW LANE that already
 * delivered its review must not remain under Live/running.
 *
 * Symphony dogfood gap (2026-06-16): review lane
 * `review-symphony-visible-claude-entrypoint-20260616` finished — it wrote and
 * committed its `research/REVIEW-…md` artifact and the SOURCE task was marked
 * reviewed — but Command Central kept showing the REVIEW LANE ITSELF under
 * Live/running. The launcher's completion hook never finalized the row
 * (status=running, completed_at=null, end_commit=null), the review
 * pending-review JSON was absent (neither active nor in the reviewed/ archive),
 * and the reviewing agent lingered at its prompt — so the cheap liveness probe
 * read the pane as "alive" and every demotion tier was skipped.
 * `scripts/oste-complete.sh review-… 0` later repaired the projection to
 * status=completed / review_state=no_review_expected / pending_review_path=null.
 *
 * A prior fix (51068e7a) handled the SOURCE task's stale review_state
 * projection. This covers the separate stale Live-row case for the REVIEW LANE.
 *
 * The reviewer lane's delivered artifact (its handoff IS the review) — or a
 * recorded review commit — is launcher-authoritative completion evidence, so a
 * delivered reviewer lane is reconciled to completed/no_review_expected in the
 * DISPLAY projection without mutating tasks.json. Genuinely in-flight reviewer
 * lanes (no artifact yet) and remote-node reviewer lanes are preserved.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__setCurrentMachineHostOverrideForTests,
	type AgentStatusGroup,
	type AgentTask,
} from "../../src/providers/agent-status-tree-provider.js";
import { clearPendingReviewCache } from "../../src/utils/pending-review-probe.js";
import {
	type AgentStatusTreeProvider,
	createMockRegistry,
	createMockTask,
	createProviderHarness,
	disposeHarness,
	type ProviderHarness,
} from "./_helpers/agent-status-tree-provider-test-base.js";

describe("AgentStatusTreeProvider — stale delivered review lane leaves Live/running", () => {
	let h: ProviderHarness;
	let provider: AgentStatusTreeProvider;
	let tmpDir: string;
	let priorDirEnv: string | undefined;

	beforeEach(() => {
		h = createProviderHarness();
		provider = h.provider;
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-lane-row-"));
		// Empty pending-review dir → Tier 1b finds no receipt for the review lane,
		// matching the Symphony gap (the review JSON was absent).
		priorDirEnv = process.env["CC_PENDING_REVIEW_DIR"];
		process.env["CC_PENDING_REVIEW_DIR"] = path.join(tmpDir, "pending-review");
		fs.mkdirSync(process.env["CC_PENDING_REVIEW_DIR"], { recursive: true });
		clearPendingReviewCache();
	});

	afterEach(() => {
		__setCurrentMachineHostOverrideForTests(null);
		disposeHarness(h);
		if (priorDirEnv === undefined) {
			delete process.env["CC_PENDING_REVIEW_DIR"];
		} else {
			process.env["CC_PENDING_REVIEW_DIR"] = priorDirEnv;
		}
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		clearPendingReviewCache();
	});

	/** Write a real review artifact at <tmpDir>/<relPath> and return relPath. */
	function writeReviewArtifact(relPath: string): string {
		const abs = path.join(tmpDir, relPath);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, "# REVIEW\n\nLGTM.\n");
		return relPath;
	}

	/**
	 * Build a `running` reviewer-lane row mirroring the Symphony shape: reviewer
	 * role + review lane_kind, a self-referential (absent) pending-review path,
	 * and no recorded completion fields.
	 */
	function makeRunningReviewLane(
		overrides: Partial<AgentTask> = {},
	): AgentTask {
		return createMockTask({
			id: "review-symphony-visible-claude-entrypoint-20260616",
			status: "running",
			role: "reviewer",
			lane_kind: "review",
			terminal_backend: "tmux",
			project_dir: tmpDir,
			session_id: "agent-symphony-daemon",
			tmux_pane_id: "%139",
			completed_at: null,
			exit_code: null,
			end_commit: null,
			start_commit: null,
			pending_review_path: path.join(
				tmpDir,
				"pending-review",
				"review-symphony-visible-claude-entrypoint-20260616.json",
			),
			handoff_file: null,
			started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
			...overrides,
		});
	}

	/** Run the raw row through the real display pipeline (toDisplayTask). */
	function displayOf(raw: AgentTask): AgentTask {
		provider.readRegistry = () => createMockRegistry({ [raw.id]: raw });
		provider.reload();
		const tasks = (
			provider as unknown as {
				getDisplayLauncherTasks: () => AgentTask[];
			}
		).getDisplayLauncherTasks();
		const found = tasks.find((t) => t.id === raw.id);
		if (!found) throw new Error(`display task ${raw.id} not found`);
		return found;
	}

	function groupOf(task: AgentTask): AgentStatusGroup {
		const fn = (
			provider as unknown as {
				getNodeStatusGroup: (node: {
					type: "task";
					task: AgentTask;
				}) => AgentStatusGroup;
			}
		).getNodeStatusGroup.bind(provider);
		return fn({ type: "task", task });
	}

	function descriptionOf(task: AgentTask): string {
		return String(provider.getTreeItem({ type: "task", task }).description);
	}

	// ── Core Symphony case: artifact delivered, row still running ────────────
	test("delivered review artifact → completed/no_review_expected, not running", () => {
		const raw = makeRunningReviewLane({
			handoff_file: writeReviewArtifact(
				"research/REVIEW-symphony-visible-claude-entrypoint-20260616.md",
			),
		});

		const display = displayOf(raw);

		expect(display.status).toBe("completed");
		expect(display.review_state).toBe("no_review_expected");
		expect(groupOf(display)).toBe("done");
		expect(groupOf(display)).not.toBe("running");
		// Reviewer lanes are no_review_expected — never flag a review-queue gap.
		expect(descriptionOf(display)).not.toContain("review receipt missing");
	});

	// ── Recorded review commit is also authoritative completion evidence ─────
	test("recorded review end_commit → completed, not running (no artifact field)", () => {
		const raw = makeRunningReviewLane({
			handoff_file: null,
			end_commit: "43cc008abcabcabcabcabcabcabcabcabcabcabc",
		});

		const display = displayOf(raw);

		expect(display.status).toBe("completed");
		expect(groupOf(display)).toBe("done");
	});

	// ── lane_kind=review alone classifies a reviewer lane (no role field) ────
	test("lane_kind=review reviewer lane with delivered artifact → completed", () => {
		const raw = makeRunningReviewLane({
			role: null,
			lane_kind: "review",
			handoff_file: writeReviewArtifact("research/REVIEW-lane-kind-only.md"),
		});

		const display = displayOf(raw);

		expect(display.status).toBe("completed");
		expect(groupOf(display)).toBe("done");
	});

	// ── Preserve a genuinely in-flight reviewer (no deliverable yet) ─────────
	test("running reviewer with no artifact and no commit stays running", () => {
		const raw = makeRunningReviewLane({
			// Declares a handoff it has not written yet → state "missing".
			handoff_file: "research/REVIEW-not-written-yet.md",
			end_commit: null,
		});

		const display = displayOf(raw);

		expect(display.status).toBe("running");
		expect(groupOf(display)).toBe("running");
	});

	test("running reviewer with no declared artifact and no commit stays running", () => {
		const raw = makeRunningReviewLane({ handoff_file: null, end_commit: null });

		const display = displayOf(raw);

		expect(display.status).toBe("running");
		expect(groupOf(display)).toBe("running");
	});

	// ── Never demote a non-reviewer lane on delivered-artifact evidence ──────
	test("implementation lane with a present handoff is NOT auto-completed", () => {
		const raw = makeRunningReviewLane({
			id: "symphony-visible-claude-entrypoint-20260616",
			role: "developer",
			lane_kind: "implementation",
			handoff_file: writeReviewArtifact("research/SOME-IMPL-HANDOFF.md"),
		});

		const display = displayOf(raw);

		expect(display.status).toBe("running");
		expect(groupOf(display)).toBe("running");
	});

	// ── Host gating: a hub-local artifact never finalizes a remote reviewer ──
	test("node-origin running reviewer lane is preserved (probe not authoritative)", () => {
		__setCurrentMachineHostOverrideForTests("Hub Mac");
		const raw = makeRunningReviewLane({
			id: "review-node-task-20260616",
			exec_mode: "node",
			exec_host: "Node Mac",
			handoff_file: writeReviewArtifact(
				"research/REVIEW-node-task-20260616.md",
			),
		});

		const display = displayOf(raw);

		expect(display.status).toBe("running");
		expect(groupOf(display)).toBe("running");
	});

	// ── isReviewQueueReceiptMissing hardening: already-completed reviewer ────
	test("completed reviewer with absent self pending-review path → done, not limbo", () => {
		// Already terminal in tasks.json, but review_state never resolved and its
		// self-referential pending-review receipt is absent. A reviewer lane is
		// never owed a review of itself, so this is NOT a review-queue gap.
		const raw = makeRunningReviewLane({
			id: "review-symphony-visible-claude-dispatch-20260616",
			status: "completed",
			review_state: null,
			handoff_file: writeReviewArtifact(
				"research/REVIEW-symphony-visible-claude-dispatch-20260616.md",
			),
		});

		const display = displayOf(raw);

		expect(display.status).toBe("completed");
		expect(groupOf(display)).toBe("done");
		expect(groupOf(display)).not.toBe("limbo");
		expect(descriptionOf(display)).not.toContain("review receipt missing");
	});
});
