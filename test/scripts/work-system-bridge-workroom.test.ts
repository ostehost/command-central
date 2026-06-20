/**
 * Bundled work-system-bridge.sh — env-less workroom/work-item row-back.
 *
 * PAR-239: the Claude Code Stop hook and launchd reaper never inherit
 * OSTE_WORKROOM_REF / OSTE_WORK_ITEM_REF from the spawn shell. Both refs
 * are persisted into the tasks.json row at spawn time so the Claude Stop
 * hook / reaper's env-less invocation of work_system_emit_lane_ref_for_task()
 * can row-back the refs into the emitted envelope via
 * work_system_lane_ref_enrich().
 *
 * This test drives the SHIPPED bundled artifact
 * (resources/bin/scripts/lib/work-system-bridge.sh) with a bash subprocess
 * to prove the behavior end-to-end, complementing the unit-level proof in
 * ghostty-launcher test/test-work-system-bridge.sh.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const bridgePath = join(
	repoRoot,
	"resources/bin/scripts/lib/work-system-bridge.sh",
);

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Run work_system_emit_lane_ref_for_task against the bundled bridge. */
function runBridgeEmit(
	tasksFile: string,
	taskId: string,
	status: string,
	outboxPath: string,
	extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
	// Build a minimal env: inherit PATH and HOME for bash/jq availability,
	// drop OSTE_WORKROOM_REF and OSTE_WORK_ITEM_REF so the subshell is
	// exactly as env-less as a Claude Stop hook.
	const baseEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) baseEnv[k] = v;
	}
	delete baseEnv["OSTE_WORKROOM_REF"];
	delete baseEnv["OSTE_WORK_ITEM_REF"];

	const env: Record<string, string> = {
		...baseEnv,
		OSTE_TEST_MODE: "1",
		OSTE_WORK_SYSTEM_BRIDGE: "outbox",
		OSTE_WORK_SYSTEM_OUTBOX: outboxPath,
		...extraEnv,
	};

	const script = [
		`source ${shellQuote(bridgePath)}`,
		`work_system_emit_lane_ref_for_task ${shellQuote(tasksFile)} ${shellQuote(taskId)} ${shellQuote(status)}`,
	].join("\n");

	return spawnSync("bash", ["-c", script], {
		cwd: repoRoot,
		encoding: "utf-8",
		env,
	});
}

describe("bundled work-system-bridge.sh — env-less row-backed workroom/work-item refs (PAR-239)", () => {
	test("row-backed workroom_ref and work_item_ref appear in the emitted envelope when env vars are absent", () => {
		const tmp = mkdtempSync(join(tmpdir(), "cc-bridge-workroom-"));
		try {
			const taskId = "par239-rowback-test";
			const tasksFile = join(tmp, "tasks.json");
			const outboxPath = join(tmp, "lanes.json");

			// Minimal tasks.json row with workroom_ref and work_item_ref persisted
			// at spawn time — the same row the Stop hook / reaper reads.
			const tasks = {
				version: 1,
				tasks: {
					[taskId]: {
						id: taskId,
						task_id: taskId,
						status: "running",
						session_id: `agent-${taskId}`,
						terminal_backend: "tmux",
						source_ref: `launcher:${taskId}`,
						lane_kind: "implementation",
						workroom_ref: "discord:room-xyz",
						work_item_ref: "linear:PAR-239",
						started_at: "2026-06-20T00:00:00Z",
						attempts: 1,
						max_attempts: 3,
					},
				},
			};
			writeFileSync(tasksFile, JSON.stringify(tasks));

			const result = runBridgeEmit(tasksFile, taskId, "completed", outboxPath);

			expect(result.status).toBe(0);

			// Parse the outbox projection written by the bundled bridge.
			const outbox = JSON.parse(readFileSync(outboxPath, "utf-8")) as {
				lanes: Record<
					string,
					{
						workroom_ref: string | null;
						work_item_ref: string | null;
						lane_ref: { status: string };
					}
				>;
			};
			const laneKey = `launcher:${taskId}`;
			const lane = outbox.lanes[laneKey];
			expect(lane).toBeDefined();
			expect(lane?.workroom_ref).toBe("discord:room-xyz");
			expect(lane?.work_item_ref).toBe("linear:PAR-239");
			expect(lane?.lane_ref?.status).toBe("completed");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("env-sourced refs still win when both env and row carry values", () => {
		const tmp = mkdtempSync(join(tmpdir(), "cc-bridge-workroom-envwins-"));
		try {
			const taskId = "par239-envwins-test";
			const tasksFile = join(tmp, "tasks.json");
			const outboxPath = join(tmp, "lanes.json");

			const tasks = {
				version: 1,
				tasks: {
					[taskId]: {
						id: taskId,
						task_id: taskId,
						status: "running",
						session_id: `agent-${taskId}`,
						terminal_backend: "tmux",
						source_ref: `launcher:${taskId}`,
						lane_kind: "implementation",
						workroom_ref: "discord:row-room",
						work_item_ref: "linear:ROW-00",
						started_at: "2026-06-20T00:00:00Z",
						attempts: 1,
						max_attempts: 3,
					},
				},
			};
			writeFileSync(tasksFile, JSON.stringify(tasks));

			// Pass env refs — they must win over the row values.
			const result = runBridgeEmit(tasksFile, taskId, "completed", outboxPath, {
				OSTE_WORKROOM_REF: "discord:env-room",
				OSTE_WORK_ITEM_REF: "linear:ENV-11",
			});

			expect(result.status).toBe(0);

			const outbox = JSON.parse(readFileSync(outboxPath, "utf-8")) as {
				lanes: Record<
					string,
					{ workroom_ref: string | null; work_item_ref: string | null }
				>;
			};
			const lane = outbox.lanes[`launcher:${taskId}`];
			expect(lane).toBeDefined();
			expect(lane?.workroom_ref).toBe("discord:env-room");
			expect(lane?.work_item_ref).toBe("linear:ENV-11");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
