/**
 * TimingRecorder tests
 *
 * Validates ring-buffer eviction, percentile math, sync/async wrappers
 * (including error paths), and report formatting. The recorder is purely
 * in-memory — no fakes or mocks needed.
 */

import { describe, expect, test } from "bun:test";
import { TimingRecorder } from "../../src/utils/timing-recorder.js";

describe("TimingRecorder", () => {
	test("records and returns stats for a single label", () => {
		const recorder = new TimingRecorder(10);
		recorder.record("a", 5);
		recorder.record("a", 10);
		recorder.record("a", 15);

		const stats = recorder.getStats("a");
		expect(stats).not.toBeNull();
		expect(stats?.count).toBe(3);
		expect(stats?.lastMs).toBe(15);
		expect(stats?.maxMs).toBe(15);
		expect(stats?.p50Ms).toBe(10);
	});

	test("returns null for unknown labels", () => {
		const recorder = new TimingRecorder();
		expect(recorder.getStats("nope")).toBeNull();
	});

	test("ring buffer evicts oldest samples but count keeps total", () => {
		const recorder = new TimingRecorder(3);
		for (let i = 1; i <= 10; i++) recorder.record("x", i);
		const stats = recorder.getStats("x");
		expect(stats?.count).toBe(10);
		// last 3 samples are 8, 9, 10 → max 10, p50 9
		expect(stats?.maxMs).toBe(10);
		expect(stats?.p50Ms).toBe(9);
		expect(stats?.lastMs).toBe(10);
	});

	test("p95 picks the top sample bucket on small N", () => {
		const recorder = new TimingRecorder(20);
		// distribution: nineteen at 1ms, one at 100ms — p95 should land in the
		// upper bucket so a slow outlier is visible.
		for (let i = 0; i < 19; i++) recorder.record("y", 1);
		recorder.record("y", 100);
		const stats = recorder.getStats("y");
		expect(stats?.maxMs).toBe(100);
		expect(stats?.p95Ms).toBe(100);
	});

	test("time wrapper records sync function duration even on throw", () => {
		const recorder = new TimingRecorder();
		expect(() =>
			recorder.time("oops", () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		const stats = recorder.getStats("oops");
		expect(stats).not.toBeNull();
		expect(stats?.count).toBe(1);
	});

	test("timeAsync wrapper records on resolve and reject", async () => {
		const recorder = new TimingRecorder();
		await recorder.timeAsync("ok", async () => "value");
		await expect(
			recorder.timeAsync("bad", async () => {
				throw new Error("nope");
			}),
		).rejects.toThrow("nope");
		expect(recorder.getStats("ok")?.count).toBe(1);
		expect(recorder.getStats("bad")?.count).toBe(1);
	});

	test("getAllStats sorts by descending max and skips empty labels", () => {
		const recorder = new TimingRecorder();
		recorder.record("fast", 1);
		recorder.record("slow", 100);
		recorder.record("medium", 50);
		const all = recorder.getAllStats();
		expect(all.map((s) => s.label)).toEqual(["slow", "medium", "fast"]);
	});

	test("formatReportLines is empty when no samples were recorded", () => {
		const recorder = new TimingRecorder();
		expect(recorder.formatReportLines()).toEqual([]);
	});

	test("formatReportLines emits header + one row per label", () => {
		const recorder = new TimingRecorder();
		recorder.record("scan.total", 12);
		recorder.record("scan.parsePsOutput", 1);
		const lines = recorder.formatReportLines();
		expect(lines[0]).toContain("Timings");
		expect(lines.length).toBe(3);
		expect(lines.some((l) => l.includes("scan.total"))).toBe(true);
		expect(lines.some((l) => l.includes("scan.parsePsOutput"))).toBe(true);
	});

	test("clear wipes all rings", () => {
		const recorder = new TimingRecorder();
		recorder.record("a", 1);
		recorder.clear();
		expect(recorder.getStats("a")).toBeNull();
		expect(recorder.formatReportLines()).toEqual([]);
	});
});
