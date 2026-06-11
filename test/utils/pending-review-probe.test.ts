import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	clearPendingReviewCache,
	readPendingReviewReceipt,
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
});
