/**
 * AgentStatusTreeProvider — pending-review completion receipt is ground truth
 *
 * Regression test for the "exit gap" UX bug: the launcher's oste-complete.sh
 * writes `/tmp/oste-pending-review/<task_id>.json` the moment the agent
 * actually finishes, but the `status: completed` update to tasks.json can
 * land several minutes later (or never, in the original bug). Before this
 * fix, CC kept rendering the task as "Running / possibly stuck" until
 * tasks.json caught up. The pending-review receipt must override it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearPendingReviewCache } from "../../src/utils/pending-review-probe.js";
import {
	type AgentStatusTreeProvider,
	createMockRegistry,
	createMockTask,
	createProviderHarness,
	disposeHarness,
	type ProviderHarness,
} from "./_helpers/agent-status-tree-provider-test-base.js";

describe("AgentStatusTreeProvider — pending-review receipt overlay", () => {
	let h: ProviderHarness;
	let provider: AgentStatusTreeProvider;
	let tmpDir: string;
	let priorDirEnv: string | undefined;

	beforeEach(() => {
		h = createProviderHarness();
		provider = h.provider;
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pending-review-"));
		priorDirEnv = process.env["CC_PENDING_REVIEW_DIR"];
		process.env["CC_PENDING_REVIEW_DIR"] = tmpDir;
		clearPendingReviewCache();
	});

	afterEach(() => {
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

	function writeReceipt(
		taskId: string,
		payload: Record<string, unknown>,
	): void {
		fs.writeFileSync(
			path.join(tmpDir, `${taskId}.json`),
			JSON.stringify(payload),
			"utf-8",
		);
		clearPendingReviewCache();
	}

	test("running task with successful pending-review receipt displays as completed", () => {
		const task = createMockTask({
			id: "exit-gap-completed",
			status: "running",
			terminal_backend: "tmux",
			started_at: new Date(Date.now() - 25 * 60_000).toISOString(),
		});
		writeReceipt(task.id, {
			task_id: task.id,
			status: "completed",
			exit_code: 0,
			completed_at: "2026-04-20T12:37:30Z",
			last_commit: "5a19f6e4f785d613b84bb634394f8869829e1f4d",
			end_commit: "5a19f6e4f785d613b84bb634394f8869829e1f4d",
		});

		provider.readRegistry = () => createMockRegistry({ [task.id]: task });
		provider.reload();

		const tasks = provider.getTasks();
		expect(tasks[0]?.status).toBe("completed");
		expect(tasks[0]?.exit_code).toBe(0);
		expect(tasks[0]?.end_commit).toBe(
			"5a19f6e4f785d613b84bb634394f8869829e1f4d",
		);
		expect(tasks[0]?.completed_at).toBe("2026-04-20T12:37:30Z");
	});

	test("running task with failed pending-review receipt displays as failed", () => {
		const task = createMockTask({
			id: "exit-gap-failed",
			status: "running",
			terminal_backend: "tmux",
			started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
		});
		writeReceipt(task.id, {
			task_id: task.id,
			status: "failed",
			exit_code: 1,
			completed_at: "2026-04-20T12:40:00Z",
			end_commit: "deadbeef",
		});

		provider.readRegistry = () => createMockRegistry({ [task.id]: task });
		provider.reload();

		const tasks = provider.getTasks();
		expect(tasks[0]?.status).toBe("failed");
		expect(tasks[0]?.exit_code).toBe(1);
		expect(tasks[0]?.end_commit).toBe("deadbeef");
	});

	test("running task without pending-review receipt keeps runtime inference", () => {
		const task = createMockTask({
			id: "no-receipt-live",
			status: "running",
			terminal_backend: "tmux",
			started_at: new Date(Date.now() - 60_000).toISOString(),
		});

		provider.readRegistry = () => createMockRegistry({ [task.id]: task });
		provider.reload();

		expect(provider.getTasks()[0]?.status).toBe("running");
	});

	test("pending-review receipt with canceled status displays as stopped", () => {
		const task = createMockTask({
			id: "exit-gap-canceled",
			status: "running",
			terminal_backend: "tmux",
			started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
		});
		writeReceipt(task.id, {
			task_id: task.id,
			status: "canceled",
			exit_code: 130,
			completed_at: "2026-04-20T12:20:00Z",
		});

		provider.readRegistry = () => createMockRegistry({ [task.id]: task });
		provider.reload();

		expect(provider.getTasks()[0]?.status).toBe("stopped");
	});

	test("already-completed task in tasks.json is not clobbered by receipt probe", () => {
		const task = createMockTask({
			id: "already-done",
			status: "completed",
			terminal_backend: "tmux",
			started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
			completed_at: "2026-04-20T12:37:30Z",
			end_commit: "aaaaaaa",
		});
		writeReceipt(task.id, {
			task_id: task.id,
			status: "completed",
			exit_code: 0,
			end_commit: "bbbbbbb",
		});

		provider.readRegistry = () => createMockRegistry({ [task.id]: task });
		provider.reload();

		const tasks = provider.getTasks();
		expect(tasks[0]?.status).toBe("completed");
		expect(tasks[0]?.end_commit).toBe("aaaaaaa");
	});
});
