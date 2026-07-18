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
import { spawn, spawnSync } from "node:child_process";
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

/**
 * Async HTTP capture helper: source the bundled bridge in a bash subprocess
 * and run work_system_emit_lane_ref_for_task. Returns a Promise that resolves
 * when the subprocess exits (non-blocking so Bun.serve can accept the curl
 * connection concurrently).
 */
function runBridgeEmitHttp(
	tasksFile: string,
	taskId: string,
	status: string,
	endpoint: string,
	extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number | null; stderr: string }> {
	// Build a minimal env: inherit PATH and HOME for bash/jq/curl availability,
	// drop OSTE_WORKROOM_REF and OSTE_WORK_ITEM_REF so the subshell is
	// exactly as env-less as an authenticated Claude Stop hook.
	const baseEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) baseEnv[k] = v;
	}
	delete baseEnv["OSTE_WORKROOM_REF"];
	delete baseEnv["OSTE_WORK_ITEM_REF"];

	const env: Record<string, string> = {
		...baseEnv,
		OSTE_TEST_MODE: "1",
		OSTE_WORK_SYSTEM_BRIDGE: "http",
		OSTE_WORK_SYSTEM_BRIDGE_ENDPOINT: endpoint,
		...extraEnv,
	};

	const script = [
		`source ${shellQuote(bridgePath)}`,
		`work_system_emit_lane_ref_for_task ${shellQuote(tasksFile)} ${shellQuote(taskId)} ${shellQuote(status)}`,
	].join("\n");

	return new Promise((resolve) => {
		let stderr = "";
		const proc = spawn("bash", ["-c", script], {
			cwd: repoRoot,
			env,
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		proc.on("close", (code) => resolve({ exitCode: code, stderr }));
	});
}

/**
 * Capture-wait budget for the POST, in ms.
 *
 * The bundled bridge invokes `curl -m "${OSTE_WORK_SYSTEM_BRIDGE_TIMEOUT:-2}"`,
 * so the POST either lands within ~2 s or curl has already given up and the
 * request is never coming. 3 s leaves headroom over that 2 s without stalling
 * a broken-dispatch run.
 *
 * This MUST stay comfortably below TEST_TIMEOUT_MS. The original PAR-243 guard
 * raced against 5000 ms, which is exactly bun:test's own default per-test
 * timeout — so on a genuine failure bun's generic "timed out after 5000ms"
 * won the race and the guard's diagnostic message was unreachable. Keeping the
 * two budgets far apart is what makes the specific message observable.
 */
const CAPTURE_TIMEOUT_MS = 3_000;

/** Per-test timeout — must stay well above CAPTURE_TIMEOUT_MS (see above). */
const TEST_TIMEOUT_MS = 20_000;

describe("bundled work-system-bridge.sh — authenticated hook HTTP workroom route (PAR-243)", () => {
	test(
		"row-backed refs are POSTed to the HTTP endpoint when env vars are absent",
		async () => {
			// Fail fast if curl is not on PATH — never hang.
			const curlCheck = spawnSync("command", ["-v", "curl"], {
				shell: true,
				encoding: "utf-8",
			});
			if (curlCheck.status !== 0) {
				throw new Error("curl not found on PATH — cannot run HTTP smoke test");
			}

			const tmp = mkdtempSync(join(tmpdir(), "cc-bridge-http-"));
			// captureResolve is set inside the Bun.serve fetch handler; captured here
			// so the outer scope can await it.
			let captureResolve!: (body: unknown) => void;
			const captured = new Promise<unknown>((res) => {
				captureResolve = res;
			});

			// Start a local capture server on a random port (port: 0 → OS assigns).
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: async (req) => {
					try {
						const body = await req.json();
						captureResolve(body);
					} catch {
						captureResolve(null);
					}
					return new Response("ok");
				},
			});

			try {
				const port = server.port;
				const endpoint = `http://127.0.0.1:${port}/plugins/work-system/lane-ref`;

				const taskId = "par243-http-smoke-test";
				const tasksFile = join(tmp, "tasks.json");

				// Minimal tasks.json row — workroom_ref and work_item_ref persisted at
				// spawn time so the env-less Stop hook can row-back both refs.
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
							work_item_ref: "linear:PAR-243",
							started_at: "2026-06-23T00:00:00Z",
							attempts: 1,
							max_attempts: 3,
						},
					},
				};
				writeFileSync(tasksFile, JSON.stringify(tasks));

				// Race the capture against a bounded budget so a broken http dispatch
				// arm fails with THIS message rather than hanging until bun's own
				// per-test timeout. timerId is cleared in the finally below so a
				// passing run leaves no timer holding the loop open.
				let timerId: ReturnType<typeof setTimeout> | undefined;
				const timeout = new Promise<never>((_, reject) => {
					timerId = setTimeout(
						() =>
							reject(
								new Error(
									`no POST received within ${CAPTURE_TIMEOUT_MS}ms — ` +
										"the http transport arm did not deliver the lane-ref",
								),
							),
						CAPTURE_TIMEOUT_MS,
					);
				});

				// Kick off the subprocess asynchronously — Bun.serve must be able to
				// accept the curl connection while we await the outcome.
				const procPromise = runBridgeEmitHttp(
					tasksFile,
					taskId,
					"completed",
					endpoint,
				);

				type CapturedBody = {
					kind: string;
					workroom_ref: string | null;
					work_item_ref: string | null;
					lane_ref: { status: string; task: string };
				};
				let body: CapturedBody;
				try {
					body = (await Promise.race([captured, timeout])) as CapturedBody;
				} finally {
					if (timerId !== undefined) clearTimeout(timerId);
				}
				const { exitCode } = await procPromise;

				// NOTE: exitCode is necessary but NOT sufficient — post_http ends in
				// `|| true` and always returns 0, so a silently-dropped POST would
				// still exit 0. The captured body below is the real assertion.
				expect(exitCode).toBe(0);
				expect(body.kind).toBe("lane_ref_update");
				expect(body.workroom_ref).toBe("discord:room-xyz");
				expect(body.work_item_ref).toBe("linear:PAR-243");
				expect(body.lane_ref.status).toBe("completed");
				expect(body.lane_ref.task).toBe(taskId);
			} finally {
				server.stop(true);
				rmSync(tmp, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS,
	);
});
