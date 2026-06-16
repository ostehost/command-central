import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	clearPendingReviewCache,
	isReceiptReviewed,
	type PendingReviewReceipt,
	REVIEWED_ARCHIVE_SUBDIR,
	readPendingReviewReceipt,
	readReviewedReceipt,
} from "../../src/utils/pending-review-probe.js";

const tmpDirs: string[] = [];

function makeTmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pending-review-"));
	tmpDirs.push(dir);
	return dir;
}

function writeReceipt(filePath: string, status = "completed"): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		`${JSON.stringify({
			status,
			exit_code: 0,
			completed_at: "2026-06-11T22:00:00.000Z",
			end_commit: "abc1234",
		})}\n`,
	);
}

describe("readPendingReviewReceipt", () => {
	beforeEach(() => {
		clearPendingReviewCache();
	});

	afterAll(() => {
		for (const dir of tmpDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reads a receipt for a plain task id", () => {
		const baseDir = makeTmp();
		writeReceipt(path.join(baseDir, "task-123.json"));

		const receipt = readPendingReviewReceipt("task-123", {
			baseDir,
			ttlMs: 0,
		});

		expect(receipt?.taskId).toBe("task-123");
		expect(receipt?.status).toBe("completed");
		expect(receipt?.endCommit).toBe("abc1234");
	});

	test("rejects path traversal task ids before reading outside the receipt directory", () => {
		const parentDir = makeTmp();
		const baseDir = path.join(parentDir, "receipts");
		fs.mkdirSync(baseDir);
		writeReceipt(path.join(parentDir, "escape.json"));

		expect(
			readPendingReviewReceipt("../escape", { baseDir, ttlMs: 0 }),
		).toBeNull();
	});

	test("rejects empty, dot, separator, and backslash task ids", () => {
		const baseDir = makeTmp();
		writeReceipt(path.join(baseDir, ".json"));
		writeReceipt(path.join(baseDir, "..json"));
		writeReceipt(path.join(baseDir, "a.json"));
		writeReceipt(path.join(baseDir, "a\\b.json"));

		for (const taskId of ["", ".", "..", "a/b", "a\\b"]) {
			expect(
				readPendingReviewReceipt(taskId, { baseDir, ttlMs: 0 }),
			).toBeNull();
		}
	});

	test("parses review_state and reviewed from the receipt", () => {
		const baseDir = makeTmp();
		fs.writeFileSync(
			path.join(baseDir, "reviewed-task.json"),
			`${JSON.stringify({
				status: "completed",
				exit_code: 0,
				review_state: "reviewed",
				reviewed: true,
			})}\n`,
		);

		const receipt = readPendingReviewReceipt("reviewed-task", {
			baseDir,
			ttlMs: 0,
		});

		expect(receipt?.reviewState).toBe("reviewed");
		expect(receipt?.reviewed).toBe(true);
	});

	test("defaults review fields when absent (back-compat with old receipts)", () => {
		const baseDir = makeTmp();
		writeReceipt(path.join(baseDir, "legacy.json"));

		const receipt = readPendingReviewReceipt("legacy", { baseDir, ttlMs: 0 });

		expect(receipt?.reviewState).toBeNull();
		expect(receipt?.reviewed).toBe(false);
	});
});

describe("isReceiptReviewed", () => {
	function receiptWith(
		overrides: Partial<PendingReviewReceipt>,
	): PendingReviewReceipt {
		return {
			taskId: "t",
			status: "completed",
			exitCode: 0,
			completedAt: null,
			lastCommit: null,
			endCommit: null,
			agentCommit: null,
			managerCommit: null,
			agentSummary: null,
			filesChanged: [],
			reviewState: null,
			reviewed: false,
			...overrides,
		};
	}

	test("reviewed:true is reviewed regardless of state string", () => {
		expect(isReceiptReviewed(receiptWith({ reviewed: true }))).toBe(true);
	});

	test("review_state=reviewed is reviewed (case/space insensitive)", () => {
		expect(isReceiptReviewed(receiptWith({ reviewState: "reviewed" }))).toBe(
			true,
		);
		expect(isReceiptReviewed(receiptWith({ reviewState: " Reviewed " }))).toBe(
			true,
		);
	});

	test("in-flight and blocker states are NOT reviewed", () => {
		for (const state of [
			"pending",
			"reviewing",
			"awaiting_fixup",
			"blocked",
			"no_review_expected",
			"",
		]) {
			expect(isReceiptReviewed(receiptWith({ reviewState: state }))).toBe(
				false,
			);
		}
		expect(isReceiptReviewed(receiptWith({ reviewState: null }))).toBe(false);
	});
});

describe("readReviewedReceipt", () => {
	beforeEach(() => {
		clearPendingReviewCache();
	});

	function writeReviewedJson(
		filePath: string,
		payload: Record<string, unknown>,
	): void {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, `${JSON.stringify(payload)}\n`);
	}

	test("prefers the active receipt when present", () => {
		const baseDir = makeTmp();
		writeReviewedJson(path.join(baseDir, "task-9.json"), {
			status: "completed",
			review_state: "reviewing",
			reviewed: false,
		});
		writeReviewedJson(
			path.join(baseDir, REVIEWED_ARCHIVE_SUBDIR, "task-9.json"),
			{ status: "completed", review_state: "reviewed", reviewed: true },
		);

		const receipt = readReviewedReceipt("task-9", { baseDir, ttlMs: 0 });
		expect(receipt?.reviewState).toBe("reviewing");
	});

	test("falls back to the reviewed/ archive when the active file is gone", () => {
		const baseDir = makeTmp();
		writeReviewedJson(
			path.join(baseDir, REVIEWED_ARCHIVE_SUBDIR, "task-10.json"),
			{ status: "completed", review_state: "reviewed", reviewed: true },
		);

		const receipt = readReviewedReceipt("task-10", { baseDir, ttlMs: 0 });
		expect(receipt?.reviewState).toBe("reviewed");
		expect(receipt?.reviewed).toBe(true);
	});

	test("returns null when neither active nor archived receipt exists", () => {
		const baseDir = makeTmp();
		expect(readReviewedReceipt("absent", { baseDir, ttlMs: 0 })).toBeNull();
	});
});
