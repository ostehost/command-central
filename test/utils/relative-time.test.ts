/**
 * Relative Time Formatting Tests
 *
 * Tests formatRelativeTime utility for all time units and edge cases.
 * Focus on coverage of uncovered lines (78, 96, 99-105).
 */

import { describe, expect, test } from "bun:test";
import { formatRelativeTime } from "../../src/utils/relative-time.js";

describe("formatRelativeTime", () => {
	const now = Date.now();

	/**
	 * Edge Cases - Invalid Inputs
	 */
	describe("edge cases", () => {
		test("returns 'unknown' for undefined timestamp", () => {
			const result = formatRelativeTime(undefined, now);
			expect(result).toBe("unknown");
		});

		test("returns 'now' for times less than 60 seconds ago", () => {
			const recent = now - 30000; // 30 seconds ago
			const result = formatRelativeTime(recent, now);
			expect(result).toBe("now");
		});
	});

	/**
	 * Time Units - All Thresholds
	 * Tests lines 99-105 (main loop)
	 */
	describe("time units", () => {
		test("formats 1 minute ago", () => {
			const timestamp = now - 60 * 1000; // 60 seconds
			const result = formatRelativeTime(timestamp, now);
			expect(result).toBe("1 minute ago");
		});

		test("formats 5 minutes ago", () => {
			const timestamp = now - 5 * 60 * 1000;
			const result = formatRelativeTime(timestamp, now);
			expect(result).toBe("5 minutes ago");
		});

		test("formats 1 hour ago", () => {
			const timestamp = now - 60 * 60 * 1000;
			const result = formatRelativeTime(timestamp, now);
			expect(result).toBe("1 hour ago");
		});

		test("formats 3 hours ago", () => {
			const timestamp = now - 3 * 60 * 60 * 1000;
			const result = formatRelativeTime(timestamp, now);
			expect(result).toBe("3 hours ago");
		});

		test("formats 1 day ago", () => {
			const timestamp = now - 24 * 60 * 60 * 1000;
			const result = formatRelativeTime(timestamp, now);
			expect(result).toBe("yesterday");
		});

		test("formats 3 days ago", () => {
			const timestamp = now - 3 * 24 * 60 * 60 * 1000;
			const result = formatRelativeTime(timestamp, now);
			expect(result).toBe("3 days ago");
		});

		test("formats 1 week ago", () => {
			const timestamp = now - 7 * 24 * 60 * 60 * 1000;
			const result = formatRelativeTime(timestamp, now);
			expect(result).toBe("last week");
		});

		test("formats 2 weeks ago", () => {
			const timestamp = now - 14 * 24 * 60 * 60 * 1000;
			const result = formatRelativeTime(timestamp, now);
			expect(result).toBe("2 weeks ago");
		});

		test("formats 1 month ago", () => {
			const timestamp = now - 30 * 24 * 60 * 60 * 1000;
			const result = formatRelativeTime(timestamp, now);
			expect(result).toBe("last month");
		});

		test("formats 3 months ago", () => {
			const timestamp = now - 90 * 24 * 60 * 60 * 1000;
			const result = formatRelativeTime(timestamp, now);
			expect(result).toBe("3 months ago");
		});

		test("formats 1 year ago", () => {
			const timestamp = now - 365 * 24 * 60 * 60 * 1000;
			const result = formatRelativeTime(timestamp, now);
			expect(result).toBe("last year");
		});

		test("formats 2 years ago", () => {
			const timestamp = now - 2 * 365 * 24 * 60 * 60 * 1000;
			const result = formatRelativeTime(timestamp, now);
			expect(result).toBe("2 years ago");
		});
	});

	/**
	 * Formatting Options
	 */
	describe("formatting options", () => {});

	/**
	 * Real-world scenarios
	 */
	describe("real-world scenarios", () => {
		test("handles git commit from 2 hours ago", () => {
			const commitTime = now - 2 * 60 * 60 * 1000;
			const result = formatRelativeTime(commitTime, now);
			expect(result).toBe("2 hours ago");
		});

		test("handles file modified yesterday", () => {
			const modifiedTime = now - 25 * 60 * 60 * 1000; // 25 hours ago
			const result = formatRelativeTime(modifiedTime, now);
			expect(result).toBe("yesterday");
		});

		test("handles old commit from 6 months ago", () => {
			const oldCommit = now - 180 * 24 * 60 * 60 * 1000;
			const result = formatRelativeTime(oldCommit, now);
			expect(result).toBe("6 months ago");
		});
	});

	/**
	 * Boundary conditions
	 */
	describe("boundary conditions", () => {
		test("handles exactly 60 seconds (1 minute threshold)", () => {
			const timestamp = now - 60 * 1000;
			const result = formatRelativeTime(timestamp, now);
			expect(result).toBe("1 minute ago");
		});

		test("handles exactly 3600 seconds (1 hour threshold)", () => {
			const timestamp = now - 3600 * 1000;
			const result = formatRelativeTime(timestamp, now);
			expect(result).toBe("1 hour ago");
		});

		test("handles exactly 86400 seconds (1 day threshold)", () => {
			const timestamp = now - 86400 * 1000;
			const result = formatRelativeTime(timestamp, now);
			expect(result).toBe("yesterday");
		});
	});
});
