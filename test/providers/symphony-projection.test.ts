import { describe, expect, test } from "bun:test";
import {
	formatSymphonyRootDescription,
	getSymphonyReleasedRuns,
	getSymphonyRetryQueuedRuns,
	getSymphonyRunGroupEmptyLabel,
	getSymphonyRunGroupLabel,
	getSymphonyRunningSessionRuns,
	isSymphonyReleasedRun,
	isSymphonyRetryQueuedRun,
	normalizeSymphonySourceStatus,
} from "../../src/providers/symphony-projection.js";
import type { CodexRunView } from "../../src/types/codex-run-types.js";
import type { TaskFlow } from "../../src/types/taskflow-types.js";

function makeRun(overrides: Partial<CodexRunView> = {}): CodexRunView {
	return {
		runId: "run-1",
		title: "Run 1",
		source: { kind: "openclaw-task", id: "task-1" },
		mergedFrom: [],
		status: "running",
		fieldSources: {},
		...overrides,
	};
}

describe("symphony-projection", () => {
	test("normalizeSymphonySourceStatus strips spacing/case so source enums compare", () => {
		expect(normalizeSymphonySourceStatus("Retry_Queued")).toBe("retryqueued");
		expect(normalizeSymphonySourceStatus("  RELEASED ")).toBe("released");
		expect(normalizeSymphonySourceStatus(undefined)).toBe("");
	});

	test("isSymphonyRetryQueuedRun triggers on source status or any retry field", () => {
		expect(
			isSymphonyRetryQueuedRun(makeRun({ sourceStatus: "retry-queued" })),
		).toBe(true);
		expect(isSymphonyRetryQueuedRun(makeRun({ retryAttempt: 2 }))).toBe(true);
		expect(isSymphonyRetryQueuedRun(makeRun({ retryDueAt: "soon" }))).toBe(
			true,
		);
		expect(isSymphonyRetryQueuedRun(makeRun({ retryError: "boom" }))).toBe(
			true,
		);
		expect(isSymphonyRetryQueuedRun(makeRun())).toBe(false);
	});

	test("isSymphonyReleasedRun only matches a released source status", () => {
		expect(isSymphonyReleasedRun(makeRun({ sourceStatus: "released" }))).toBe(
			true,
		);
		expect(isSymphonyReleasedRun(makeRun())).toBe(false);
	});

	test("run partitioning is mutually exclusive: running excludes retry-queued and released", () => {
		const plainRunning = makeRun({ runId: "a", status: "running" });
		const retrying = makeRun({
			runId: "b",
			status: "running",
			retryAttempt: 1,
		});
		const released = makeRun({
			runId: "c",
			status: "running",
			sourceStatus: "released",
		});
		const runs = [plainRunning, retrying, released];

		expect(getSymphonyRunningSessionRuns(runs).map((r) => r.runId)).toEqual([
			"a",
		]);
		expect(getSymphonyRetryQueuedRuns(runs).map((r) => r.runId)).toEqual(["b"]);
		expect(getSymphonyReleasedRuns(runs).map((r) => r.runId)).toEqual(["c"]);
	});

	test("formatSymphonyRootDescription summarizes runs, workstreams, and live counts", () => {
		const flows = [{ flowId: "f1" }] as unknown as TaskFlow[];
		expect(formatSymphonyRootDescription([], [])).toBe("no projected runs");
		expect(formatSymphonyRootDescription([makeRun()], [])).toBe(
			"1 standalone run attempt · 1 running",
		);
		expect(formatSymphonyRootDescription([makeRun()], flows)).toBe(
			"1 run attempt · 1 workstream · 1 running",
		);
	});

	test("run-group label helpers cover every kind", () => {
		expect(getSymphonyRunGroupLabel("running")).toBe("Running Sessions");
		expect(getSymphonyRunGroupLabel("retryQueued")).toBe("Retry Queue");
		expect(getSymphonyRunGroupLabel("released")).toBe("Released");
		expect(getSymphonyRunGroupEmptyLabel("retryQueued")).toBe(
			"Retry queue empty",
		);
	});
});
