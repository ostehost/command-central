/**
 * AgentStatusTreeProvider — reviewed pending-review receipt overrides a stale
 * task-row review_state projection.
 *
 * Symphony dogfood gap (2026-06-16): an implementation task finished and a
 * manual review passed/committed, but Command Central kept showing the task as
 * pending/reviewing because:
 *   - auto-review dispatch failed (spawn_failed), leaving the source
 *     pending-review JSON (and the tasks.json row) in review_state="reviewing",
 *   - a separate manual review lane later marked the SOURCE receipt reviewed
 *     (review_state="reviewed", reviewed:true), and the launcher snapshotted it
 *     to the reviewed/ archive,
 *   - but the tasks.json task-row projection never refreshed to reviewed.
 *
 * The receipt (active file, else the reviewed/ archive snapshot) is the
 * authoritative review-lifecycle truth and must win over the stale row.
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
	createMockTask,
	createProviderHarness,
	disposeHarness,
	type ProviderHarness,
} from "./_helpers/agent-status-tree-provider-test-base.js";

describe("AgentStatusTreeProvider — reviewed receipt overrides stale review_state", () => {
	let h: ProviderHarness;
	let provider: AgentStatusTreeProvider;
	let tmpDir: string;
	let priorDirEnv: string | undefined;

	beforeEach(() => {
		h = createProviderHarness();
		provider = h.provider;
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-projection-"));
		priorDirEnv = process.env["CC_PENDING_REVIEW_DIR"];
		process.env["CC_PENDING_REVIEW_DIR"] = tmpDir;
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

	/** Write a pending-review receipt to the active queue dir. */
	function writeActiveReceipt(
		taskId: string,
		payload: Record<string, unknown>,
	): void {
		fs.writeFileSync(
			path.join(tmpDir, `${taskId}.json`),
			`${JSON.stringify(payload)}\n`,
		);
		clearPendingReviewCache();
	}

	/** Write a pending-review receipt to the reviewed/ archive snapshot dir. */
	function writeArchivedReceipt(
		taskId: string,
		payload: Record<string, unknown>,
	): void {
		const archiveDir = path.join(tmpDir, "reviewed");
		fs.mkdirSync(archiveDir, { recursive: true });
		fs.writeFileSync(
			path.join(archiveDir, `${taskId}.json`),
			`${JSON.stringify(payload)}\n`,
		);
		clearPendingReviewCache();
	}

	function makeCompletedTask(overrides: Partial<AgentTask> = {}): AgentTask {
		return createMockTask({
			id: "impl-task",
			status: "completed",
			terminal_backend: "tmux",
			project_dir: tmpDir,
			handoff_file: null,
			started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
			pending_review_path: path.join(tmpDir, "impl-task.json"),
			...overrides,
		});
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

	function contextValueOf(task: AgentTask): string {
		return String(provider.getTreeItem({ type: "task", task }).contextValue);
	}

	// ── Core Symphony case: active receipt updated in place ──────────────────
	test("stale review_state=reviewing + active receipt reviewed → done, ✓, no gap", () => {
		const task = makeCompletedTask({ review_state: "reviewing" });
		writeActiveReceipt(task.id, {
			task_id: task.id,
			status: "completed",
			exit_code: 0,
			review_state: "reviewed",
			reviewed: true,
		});

		expect(groupOf(task)).toBe("done");
		const description = descriptionOf(task);
		expect(description).toContain("✓");
		expect(description).not.toContain("review receipt missing");
		expect(contextValueOf(task)).toContain(".reviewed");
	});

	// ── Reviewed archive fallback: active file consumed/relocated ────────────
	test("stale review_state=reviewing + active file gone + reviewed archive → done, ✓, no gap", () => {
		const task = makeCompletedTask({ review_state: "reviewing" });
		// No active file at pending_review_path — only the reviewed/ snapshot.
		writeArchivedReceipt(task.id, {
			task_id: task.id,
			status: "completed",
			exit_code: 0,
			review_state: "reviewed",
			reviewed: true,
		});

		expect(groupOf(task)).toBe("done");
		const description = descriptionOf(task);
		expect(description).toContain("✓");
		expect(description).not.toContain("review receipt missing");
	});

	// ── Stale review_status=pending PR-enum cleared by the reviewed receipt ──
	test("stale review_status=pending + reviewed receipt → done (attention cleared)", () => {
		const task = makeCompletedTask({ review_status: "pending" });
		writeActiveReceipt(task.id, {
			task_id: task.id,
			status: "completed",
			exit_code: 0,
			review_state: "reviewed",
			reviewed: true,
		});

		expect(groupOf(task)).toBe("done");
		expect(descriptionOf(task)).toContain("✓");
	});

	// ── Preserve TRUE in-flight/blocker states (no false promotion) ──────────
	test("active receipt still reviewing keeps review_status=pending in attention, no ✓", () => {
		const task = makeCompletedTask({ review_status: "pending" });
		writeActiveReceipt(task.id, {
			task_id: task.id,
			status: "completed",
			exit_code: 0,
			review_state: "reviewing",
			reviewed: false,
		});

		expect(groupOf(task)).toBe("attention");
		expect(descriptionOf(task)).not.toContain("✓");
	});

	test("awaiting_fixup and blocked receipts never count as reviewed", () => {
		for (const state of ["awaiting_fixup", "blocked"]) {
			const task = makeCompletedTask({
				id: `impl-${state}`,
				review_status: "pending",
				pending_review_path: path.join(tmpDir, `impl-${state}.json`),
			});
			writeActiveReceipt(task.id, {
				task_id: task.id,
				status: "completed",
				exit_code: 0,
				review_state: state,
				reviewed: false,
			});

			expect(groupOf(task)).toBe("attention");
			expect(descriptionOf(task)).not.toContain("✓");
		}
	});

	// ── Preserve the TRUE review-queue gap (no archive, never reviewed) ──────
	test("review_state=reviewing + active file gone + NO archive → review receipt missing (limbo)", () => {
		const task = makeCompletedTask({ review_state: "reviewing" });
		// Neither the active file nor a reviewed snapshot exists — a genuine gap.

		expect(groupOf(task)).toBe("limbo");
		expect(descriptionOf(task)).toContain("review receipt missing");
	});

	// ── Host gating: a local receipt is not authoritative for a remote task ──
	test("node-origin task does not trust a hub-local reviewed receipt", () => {
		__setCurrentMachineHostOverrideForTests("Hub Mac");
		const task = makeCompletedTask({
			id: "node-impl-task",
			review_state: "reviewing",
			pending_review_path: path.join(tmpDir, "node-impl-task.json"),
			exec_mode: "node",
			exec_host: "Node Mac",
		});
		// A reviewed receipt sitting on the hub must not be read as truth about
		// a task that executed on another machine.
		writeActiveReceipt(task.id, {
			task_id: task.id,
			status: "completed",
			exit_code: 0,
			review_state: "reviewed",
			reviewed: true,
		});

		expect(descriptionOf(task)).not.toContain("✓");
	});
});
