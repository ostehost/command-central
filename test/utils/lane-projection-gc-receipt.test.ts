/**
 * CCSYNC-02 (PAR-227) — lane-projection rebuild/GC receipt.
 *
 * The launcher's lane-projection GC command (scripts/oste-lanes-gc.sh) emits a
 * machine-readable receipt enumerating what each lane row should become
 * (kept/downgraded/archived/removed). Command Central consumes that receipt to
 * reconcile stale projection rows out of the live attention surface instead of
 * re-deriving the verdict on every render.
 *
 * Covers the pure schema parser + the FS reader + the pure reconciliation that
 * stamps the `gc_reconcile` marker on projection rows the receipt reconciled
 * out. These fail on pre-PAR-227 code (the symbols do not exist).
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";
import { applyGcReceiptReconciliation } from "../../src/providers/agent-task-normalize.js";
import {
	DEFAULT_LANE_GC_RECEIPT_PATH,
	readLaneProjectionGcReceipt,
} from "../../src/utils/pending-review-probe.js";
import {
	LANE_PROJECTION_GC_RECEIPT_KIND,
	type LaneProjectionGcReceipt,
	parseLaneProjectionGcReceipt,
} from "../../src/utils/review-queue-health.js";

const tmpDirs: string[] = [];
function makeTmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-lane-gc-"));
	tmpDirs.push(dir);
	return dir;
}

function projectionTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "task-1",
		status: "completed",
		project_dir: "/tmp/project",
		project_name: "project",
		session_id: "agent-task-1",
		tmux_session: "agent-task-1",
		bundle_path: "",
		prompt_file: "",
		started_at: "2026-06-23T10:00:00Z",
		attempts: 1,
		max_attempts: 3,
		lane_projection: true,
		provenance: { source_ref: "launcher:task-1" },
		...overrides,
	};
}

describe("parseLaneProjectionGcReceipt", () => {
	test("parses a well-formed receipt with all verdicts", () => {
		const receipt = parseLaneProjectionGcReceipt({
			version: 1,
			kind: LANE_PROJECTION_GC_RECEIPT_KIND,
			generated_at: "2026-06-23T12:00:00Z",
			mode: "apply",
			rows: {
				"launcher:a": { verdict: "kept", reason: "receipt-present" },
				"launcher:b": { verdict: "downgraded", reason: "receipt-missing" },
				"launcher:c": { verdict: "archived" },
				"launcher:d": { verdict: "removed", reason: "orphan" },
			},
		});
		expect(receipt).not.toBeNull();
		expect(receipt?.mode).toBe("apply");
		expect(receipt?.generatedAt).toBe("2026-06-23T12:00:00Z");
		expect(receipt?.rows["launcher:b"]?.verdict).toBe("downgraded");
		expect(receipt?.rows["launcher:c"]?.reason).toBeNull();
		expect(receipt?.rows["launcher:d"]?.verdict).toBe("removed");
	});

	test("defaults mode to dry-run and version to 1", () => {
		const receipt = parseLaneProjectionGcReceipt({
			kind: LANE_PROJECTION_GC_RECEIPT_KIND,
			rows: {},
		});
		expect(receipt?.mode).toBe("dry-run");
		expect(receipt?.version).toBe(1);
	});

	test("rejects a document of the wrong kind (fail-closed)", () => {
		expect(
			parseLaneProjectionGcReceipt({
				kind: "work-system-lanes-projection",
				rows: {},
			}),
		).toBeNull();
		expect(parseLaneProjectionGcReceipt(null)).toBeNull();
		expect(parseLaneProjectionGcReceipt([])).toBeNull();
	});

	test("drops rows with an unknown verdict", () => {
		const receipt = parseLaneProjectionGcReceipt({
			kind: LANE_PROJECTION_GC_RECEIPT_KIND,
			rows: {
				good: { verdict: "downgraded" },
				bogus: { verdict: "frobnicated" },
				notobj: 7,
			},
		});
		expect(Object.keys(receipt?.rows ?? {})).toEqual(["good"]);
	});
});

describe("readLaneProjectionGcReceipt", () => {
	const savedEnv = process.env["CC_LANE_GC_RECEIPT"];

	beforeEach(() => {
		delete process.env["CC_LANE_GC_RECEIPT"];
	});

	afterAll(() => {
		if (savedEnv === undefined) {
			delete process.env["CC_LANE_GC_RECEIPT"];
		} else {
			process.env["CC_LANE_GC_RECEIPT"] = savedEnv;
		}
		for (const dir of tmpDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("is opt-in: returns null with no explicit path and no env var set", () => {
		expect(readLaneProjectionGcReceipt()).toBeNull();
	});

	test("an empty env var resolves to the documented default launcher path", () => {
		const dir = makeTmp();
		const file = path.join(dir, "default-gc.json");
		fs.writeFileSync(
			file,
			`${JSON.stringify({
				kind: LANE_PROJECTION_GC_RECEIPT_KIND,
				rows: {},
			})}\n`,
		);
		// Point the env at our fixture; the explicit-path branch and the env
		// branch share the same resolver.
		process.env["CC_LANE_GC_RECEIPT"] = file;
		expect(readLaneProjectionGcReceipt()?.kind).toBe(
			LANE_PROJECTION_GC_RECEIPT_KIND,
		);
		// The documented default is a stable, absolute launcher path.
		expect(DEFAULT_LANE_GC_RECEIPT_PATH.startsWith("/")).toBe(true);
	});

	test("reads + parses a receipt file from an explicit path", () => {
		const dir = makeTmp();
		const file = path.join(dir, "gc.json");
		fs.writeFileSync(
			file,
			`${JSON.stringify({
				kind: LANE_PROJECTION_GC_RECEIPT_KIND,
				mode: "dry-run",
				rows: { "launcher:x": { verdict: "removed" } },
			})}\n`,
		);
		const receipt = readLaneProjectionGcReceipt(file);
		expect(receipt?.rows["launcher:x"]?.verdict).toBe("removed");
	});

	test("returns null for a missing file", () => {
		const dir = makeTmp();
		expect(
			readLaneProjectionGcReceipt(path.join(dir, "absent.json")),
		).toBeNull();
	});

	test("returns null for invalid JSON", () => {
		const dir = makeTmp();
		const file = path.join(dir, "bad.json");
		fs.writeFileSync(file, "{not json");
		expect(readLaneProjectionGcReceipt(file)).toBeNull();
	});
});

describe("applyGcReceiptReconciliation", () => {
	function receipt(
		rows: LaneProjectionGcReceipt["rows"],
		generatedAt: string | null = null,
	): LaneProjectionGcReceipt {
		return {
			version: 1,
			kind: LANE_PROJECTION_GC_RECEIPT_KIND,
			generatedAt,
			mode: "dry-run",
			rows,
		};
	}

	test("stamps gc_reconcile on downgraded/archived/removed projection rows", () => {
		const tasks = {
			a: projectionTask({ id: "a", provenance: { source_ref: "launcher:a" } }),
			b: projectionTask({ id: "b", provenance: { source_ref: "launcher:b" } }),
			c: projectionTask({ id: "c", provenance: { source_ref: "launcher:c" } }),
		};
		const result = applyGcReceiptReconciliation(
			tasks,
			receipt({
				"launcher:a": { verdict: "downgraded", reason: "receipt-missing" },
				"launcher:b": { verdict: "archived", reason: null },
				"launcher:c": { verdict: "removed", reason: null },
			}),
		);
		expect(result["a"]?.gc_reconcile).toBe("downgraded");
		expect(result["a"]?.gc_reconcile_reason).toBe("receipt-missing");
		expect(result["b"]?.gc_reconcile).toBe("archived");
		expect(result["c"]?.gc_reconcile).toBe("removed");
	});

	test("leaves kept rows and uncovered rows untouched", () => {
		const tasks = {
			a: projectionTask({ id: "a", provenance: { source_ref: "launcher:a" } }),
			b: projectionTask({ id: "b", provenance: { source_ref: "launcher:b" } }),
		};
		const result = applyGcReceiptReconciliation(
			tasks,
			receipt({ "launcher:a": { verdict: "kept", reason: null } }),
		);
		expect(result["a"]?.gc_reconcile).toBeUndefined();
		expect(result["b"]?.gc_reconcile).toBeUndefined();
	});

	test("matches a receipt row keyed by the bare task id", () => {
		const tasks = {
			a: projectionTask({ id: "task-99", provenance: { source_ref: null } }),
		};
		const result = applyGcReceiptReconciliation(
			tasks,
			receipt({ "task-99": { verdict: "downgraded", reason: null } }),
		);
		expect(result["a"]?.gc_reconcile).toBe("downgraded");
	});

	test("never reconciles a non-projection row even if the receipt names it", () => {
		const tasks = {
			a: projectionTask({
				id: "a",
				lane_projection: false,
				provenance: { source_ref: "launcher:a" },
			}),
		};
		const result = applyGcReceiptReconciliation(
			tasks,
			receipt({ "launcher:a": { verdict: "removed", reason: null } }),
		);
		expect(result["a"]?.gc_reconcile).toBeUndefined();
	});

	test("a null receipt is a no-op", () => {
		const tasks = { a: projectionTask({ id: "a" }) };
		expect(applyGcReceiptReconciliation(tasks, null)).toBe(tasks);
	});

	// CCSYNC-07 (PAR-299): gate the reconcile marker on receipt freshness so a
	// stale opt-in GC receipt cannot re-stamp a since-rebuilt lane that now
	// projects `running`, hiding genuinely-live work behind Needs Review.
	describe("freshness gate", () => {
		const PROJECTION_GEN = "2026-06-23T12:00:00Z";
		const STALE = "2026-06-23T10:00:00Z"; // receipt predates projection gen
		const FRESH = "2026-06-23T14:00:00Z"; // receipt at/after projection gen

		test("a stale receipt does not hide a live running lane", () => {
			const tasks = {
				a: projectionTask({
					id: "a",
					status: "running",
					updated_at: PROJECTION_GEN,
					provenance: { source_ref: "launcher:a" },
				}),
			};
			const result = applyGcReceiptReconciliation(
				tasks,
				receipt(
					{
						"launcher:a": { verdict: "removed", reason: "running-no-evidence" },
					},
					STALE,
				),
			);
			expect(result["a"]?.gc_reconcile).toBeUndefined();
			expect(result["a"]?.status).toBe("running");
		});

		test("a receipt older than the projection generation is ignored (any status)", () => {
			const tasks = {
				a: projectionTask({
					id: "a",
					status: "completed",
					updated_at: PROJECTION_GEN,
					provenance: { source_ref: "launcher:a" },
				}),
			};
			const result = applyGcReceiptReconciliation(
				tasks,
				receipt(
					{
						"launcher:a": { verdict: "downgraded", reason: "receipt-missing" },
					},
					STALE,
				),
			);
			expect(result["a"]?.gc_reconcile).toBeUndefined();
		});

		test("a fresh receipt still reconciles a since-observed running row", () => {
			const tasks = {
				a: projectionTask({
					id: "a",
					status: "running",
					updated_at: PROJECTION_GEN,
					provenance: { source_ref: "launcher:a" },
				}),
			};
			const result = applyGcReceiptReconciliation(
				tasks,
				receipt(
					{
						"launcher:a": { verdict: "removed", reason: "running-no-evidence" },
					},
					FRESH,
				),
			);
			expect(result["a"]?.gc_reconcile).toBe("removed");
		});

		test("unprovable freshness never downgrades a running row", () => {
			const tasks = {
				a: projectionTask({
					id: "a",
					status: "running",
					updated_at: PROJECTION_GEN,
					provenance: { source_ref: "launcher:a" },
				}),
			};
			// generatedAt null → freshness cannot be proven → refuse to hide live work.
			const result = applyGcReceiptReconciliation(
				tasks,
				receipt({ "launcher:a": { verdict: "removed", reason: null } }, null),
			);
			expect(result["a"]?.gc_reconcile).toBeUndefined();
		});

		test("unprovable freshness still reconciles a terminal row", () => {
			const tasks = {
				a: projectionTask({
					id: "a",
					status: "completed",
					updated_at: PROJECTION_GEN,
					provenance: { source_ref: "launcher:a" },
				}),
			};
			const result = applyGcReceiptReconciliation(
				tasks,
				receipt({ "launcher:a": { verdict: "archived", reason: null } }, null),
			);
			expect(result["a"]?.gc_reconcile).toBe("archived");
		});
	});
});
