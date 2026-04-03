/**
 * Tests for ReviewTracker — tracks which completed agent tasks have been reviewed
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Restore real node:fs to undo mock bleed from other test files
const realFs = require("node:fs");
mock.module("node:fs", () => realFs);

const { ReviewTracker } = await import("../../src/services/review-tracker.js");

describe("ReviewTracker", () => {
	let tmpDir: string;
	let storePath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-tracker-test-"));
		storePath = path.join(tmpDir, "reviewed-tasks.json");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("isReviewed returns false for unknown task", () => {
		const tracker = new ReviewTracker(storePath);
		expect(tracker.isReviewed("task-abc")).toBe(false);
	});

	test("markReviewed + isReviewed round-trip", () => {
		const tracker = new ReviewTracker(storePath);
		tracker.markReviewed("task-123");
		expect(tracker.isReviewed("task-123")).toBe(true);
	});

	test("markReviewed is idempotent", () => {
		const tracker = new ReviewTracker(storePath);
		tracker.markReviewed("task-123");
		tracker.markReviewed("task-123");
		expect(tracker.getReviewedIds().size).toBe(1);
	});

	test("save + reload preserves data", () => {
		const tracker1 = new ReviewTracker(storePath);
		tracker1.markReviewed("task-aaa");
		tracker1.markReviewed("task-bbb");

		// markReviewed auto-saves, so reload from same path
		const tracker2 = new ReviewTracker(storePath);
		expect(tracker2.isReviewed("task-aaa")).toBe(true);
		expect(tracker2.isReviewed("task-bbb")).toBe(true);
		expect(tracker2.isReviewed("task-ccc")).toBe(false);
	});

	test("getReviewedIds returns copy of reviewed set", () => {
		const tracker = new ReviewTracker(storePath);
		tracker.markReviewed("task-x");
		const ids = tracker.getReviewedIds();
		expect(ids.has("task-x")).toBe(true);
		// Mutation of returned set doesn't affect tracker
		ids.add("task-y");
		expect(tracker.isReviewed("task-y")).toBe(false);
	});

	test("prunes oldest entries when cap exceeded", () => {
		// Use a custom tracker subclass to access internals via type casting
		const tracker = new ReviewTracker(storePath);

		// Fill past the 500-entry cap using private internals
		const trackerAny = tracker as unknown as {
			orderedIds: string[];
			reviewed: Set<string>;
			prune(): void;
			save(): void;
		};

		// Add 502 entries manually to test pruning
		for (let i = 0; i < 502; i++) {
			const id = `task-${i}`;
			trackerAny.orderedIds.push(id);
			trackerAny.reviewed.add(id);
		}
		trackerAny.prune();

		// Should have exactly 500 entries after prune
		expect(trackerAny.orderedIds.length).toBe(500);
		// Oldest 2 should be gone
		expect(tracker.isReviewed("task-0")).toBe(false);
		expect(tracker.isReviewed("task-1")).toBe(false);
		// Recent ones should remain
		expect(tracker.isReviewed("task-501")).toBe(true);
	});

	test("handles corrupt JSON gracefully", () => {
		fs.mkdirSync(path.dirname(storePath), { recursive: true });
		fs.writeFileSync(storePath, "{{{{ not json");

		const tracker = new ReviewTracker(storePath);
		expect(tracker.isReviewed("task-abc")).toBe(false);
	});

	test("handles missing file gracefully", () => {
		const tracker = new ReviewTracker(
			path.join(tmpDir, "nonexistent", "reviewed-tasks.json"),
		);
		expect(tracker.isReviewed("task-abc")).toBe(false);
	});

	test("creates parent directories on save", () => {
		const deepPath = path.join(tmpDir, "a", "b", "c", "reviewed-tasks.json");
		const tracker = new ReviewTracker(deepPath);
		tracker.markReviewed("task-deep");
		expect(fs.existsSync(deepPath)).toBe(true);
	});

	test("persists correct JSON format", () => {
		const tracker = new ReviewTracker(storePath);
		tracker.markReviewed("task-format-1");
		tracker.markReviewed("task-format-2");

		const raw = fs.readFileSync(storePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		expect(parsed).toMatchObject({
			version: 1,
			reviewed: ["task-format-1", "task-format-2"],
		});
	});
});
