/**
 * AgentStatusTreeProvider — PAR-295 review-ready-limbo gate.
 *
 * Lifecycle visibility gap (PAR-295): a remote-visible Claude lane
 * (`symphony-PAR-295-ecfd2555`) printed `READY_FOR_REVIEW` in its last message
 * but the PROCESS stayed alive at its REPL. Because it never exited, no
 * pending-review receipt was written, Linear stayed `Todo`, and Command Central
 * showed a plain interactive Live/running row instead of a review-needed state.
 *
 * The fix is CONSUMER-ONLY and honors the hub/node trust boundary: CC surfaces
 * such a lane under Needs Review (limbo) SOLELY on a trusted, executor-projected
 * `completion_marker` — it never scrapes a pane, and least of all a remote
 * node's `/tmp`. Populating the marker is the launcher/daemon's job (out of this
 * repo); these tests exercise CC's side: honor the marker when projected,
 * never false-positive on a benign running lane, and let a resolved/received
 * review win over stale running evidence.
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

describe("AgentStatusTreeProvider — PAR-295 review-ready lane surfaces under Needs Review", () => {
	let h: ProviderHarness;
	let provider: AgentStatusTreeProvider;
	let tmpDir: string;
	let priorDirEnv: string | undefined;

	beforeEach(() => {
		h = createProviderHarness();
		provider = h.provider;
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-ready-limbo-"));
		// Empty pending-review dir → no receipt exists yet, matching the PAR-295
		// pre-repair state (the agent had not `/exit`ed, so oste-complete never ran).
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

	/**
	 * A running Symphony implementation lane mirroring `symphony-PAR-295-ecfd2555`:
	 * alive process, no completion fields, no receipt on disk.
	 */
	function makeRunningReadyLane(overrides: Partial<AgentTask> = {}): AgentTask {
		return createMockTask({
			id: "symphony-PAR-295-ecfd2555",
			status: "running",
			role: "developer",
			lane_kind: "implementation",
			orchestration_mode: "symphony",
			terminal_backend: "tmux",
			project_dir: tmpDir,
			session_id: "agent-symphony-daemon",
			tmux_pane_id: "%295",
			completed_at: null,
			exit_code: null,
			end_commit: null,
			start_commit: null,
			pending_review_path: null,
			handoff_file: null,
			review_state: null,
			review_status: null,
			started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
			...overrides,
		});
	}

	/** Run the raw row through the real display pipeline (toDisplayTask). */
	function displayOf(raw: AgentTask): AgentTask {
		provider.readRegistry = () => createMockRegistry({ [raw.id]: raw });
		provider.reload();
		const tasks = (
			provider as unknown as { getDisplayLauncherTasks: () => AgentTask[] }
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

	function tooltipOf(task: AgentTask): string {
		const tip = provider.getTreeItem({ type: "task", task }).tooltip;
		return typeof tip === "string"
			? tip
			: String((tip as { value: string })?.value ?? "");
	}

	// ── Core PAR-295 case: ready marker, no receipt, process alive ───────────
	test("running lane with completion marker + no receipt → limbo, not running", () => {
		const display = displayOf(
			makeRunningReadyLane({ completion_marker: "READY_FOR_REVIEW" }),
		);

		// Display status stays running — CC does NOT claim the task completed.
		expect(display.status).toBe("running");
		// …but it is bucketed as Needs Review (limbo), not plain Live.
		expect(groupOf(display)).toBe("limbo");
		expect(groupOf(display)).not.toBe("running");
		// Honest, concrete copy — never a bare "done".
		expect(descriptionOf(display)).toContain("ready text seen");
		expect(descriptionOf(display)).toContain("no review receipt yet");
		const tip = tooltipOf(display);
		expect(tip).toContain("Needs review finalization");
		expect(tip).toContain("READY_FOR_REVIEW");
	});

	// ── Trust boundary: remote-node evidence honored only when projected ─────
	test("remote-node lane WITH projected marker → limbo (no local probe needed)", () => {
		__setCurrentMachineHostOverrideForTests("Hub Mac");
		const display = displayOf(
			makeRunningReadyLane({
				exec_mode: "node",
				exec_host: "Node Mac",
				completion_marker: "READY_FOR_REVIEW",
			}),
		);

		expect(display.status).toBe("running");
		expect(groupOf(display)).toBe("limbo");
	});

	test("remote-node lane WITHOUT a projected marker stays running (never scraped)", () => {
		__setCurrentMachineHostOverrideForTests("Hub Mac");
		const display = displayOf(
			makeRunningReadyLane({
				exec_mode: "node",
				exec_host: "Node Mac",
				completion_marker: null,
			}),
		);

		expect(display.status).toBe("running");
		expect(groupOf(display)).toBe("running");
	});

	// ── No false positive on a benign running lane ───────────────────────────
	test("benign running lane with no marker stays running", () => {
		const display = displayOf(
			makeRunningReadyLane({ completion_marker: null }),
		);

		expect(display.status).toBe("running");
		expect(groupOf(display)).toBe("running");
		expect(descriptionOf(display)).not.toContain("ready text seen");
	});

	test("blank/whitespace marker does not trip the gate", () => {
		const display = displayOf(
			makeRunningReadyLane({ completion_marker: "   " }),
		);

		expect(groupOf(display)).toBe("running");
	});

	// ── Resolved / received review wins over stale running evidence ──────────
	test("running lane with marker but review already resolved stays running", () => {
		const display = displayOf(
			makeRunningReadyLane({
				completion_marker: "READY_FOR_REVIEW",
				review_state: "reviewed",
			}),
		);

		// A settled review has nothing left to finalize — no limbo demotion.
		expect(groupOf(display)).toBe("running");
		expect(descriptionOf(display)).not.toContain("ready text seen");
	});

	test("present pending-review receipt wins: Tier 1b overlays off running", () => {
		// A real receipt on disk means finalization already happened. Tier 1b
		// overlays the running row to the receipt's status BEFORE bucketing, so
		// the review-ready-limbo gate never applies to it.
		const receiptDir = process.env["CC_PENDING_REVIEW_DIR"] as string;
		const receiptPath = path.join(receiptDir, "symphony-PAR-295-ecfd2555.json");
		fs.writeFileSync(
			receiptPath,
			JSON.stringify({
				task_id: "symphony-PAR-295-ecfd2555",
				status: "completed",
				review_state: "pending",
			}),
		);
		clearPendingReviewCache();

		const display = displayOf(
			makeRunningReadyLane({
				completion_marker: "READY_FOR_REVIEW",
				pending_review_path: receiptPath,
			}),
		);

		// Overlaid off "running" by the receipt — not left as a review-ready-limbo
		// running row.
		expect(display.status).not.toBe("running");
		expect(descriptionOf(display)).not.toContain("ready text seen");
	});

	// ── Reviewer lanes are never owed a review of themselves ─────────────────
	test("reviewer lane with a marker is not treated as review-ready-limbo", () => {
		const display = displayOf(
			makeRunningReadyLane({
				id: "review-symphony-PAR-295-ecfd2555",
				role: "reviewer",
				lane_kind: "review",
				completion_marker: "READY_FOR_REVIEW",
			}),
		);

		expect(descriptionOf(display)).not.toContain("ready text seen");
	});

	// ── Notification consistency: no completed transition is implied ─────────
	test("display status stays running so no completion notification can fire", () => {
		const display = displayOf(
			makeRunningReadyLane({ completion_marker: "READY_FOR_REVIEW" }),
		);

		// checkCompletionNotifications only fires on running→terminal. A
		// review-ready-limbo lane keeps status "running", so it is never mistaken
		// for a completed/failed run — the displayed attention state and the
		// notification logic agree.
		expect(display.status).toBe("running");
		expect(
			display.status === "completed" ||
				display.status === "completed_dirty" ||
				display.status === "failed",
		).toBe(false);
	});
});
