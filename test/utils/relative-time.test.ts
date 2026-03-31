/**
 * Relative Time Formatting Tests
 *
 * Tests formatRelativeTime utility for all time units and edge cases.
 * Focus on coverage of uncovered lines (78, 96, 99-105).
 */

import { describe, expect, test } from "bun:test";
import {
	formatRelativeTime,
	relativeTime,
} from "../../src/utils/relative-time.js";

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

describe("relativeTime", () => {
	const now = new Date("2026-03-31T16:00:00Z").getTime();

	test("formats seconds ago", () => {
		expect(relativeTime(now - 2_000, now)).toBe("2s ago");
	});

	test("formats minutes ago", () => {
		expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
	});

	test("formats hours ago", () => {
		expect(relativeTime(now - 2 * 3_600_000, now)).toBe("2h ago");
	});

	test("formats days ago", () => {
		expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3d ago");
	});

	test("returns just now for null and undefined", () => {
		expect(relativeTime(null, now)).toBe("just now");
		expect(relativeTime(undefined, now)).toBe("just now");
	});

	test("returns just now for invalid dates", () => {
		expect(relativeTime("not-a-date", now)).toBe("just now");
	});

	test("returns just now for future dates", () => {
		expect(relativeTime(now + 30_000, now)).toBe("just now");
	});
});
