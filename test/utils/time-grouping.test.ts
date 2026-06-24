import { afterEach, describe, expect, test } from "bun:test";
import {
	classifyTimePeriod,
	groupByTimePeriod,
	TIME_PERIOD_LABELS,
} from "../../src/utils/time-grouping.js";

describe("classifyTimePeriod", () => {
	test("classifies calendar-day periods using local midnight boundaries", () => {
		const now = new Date(2026, 3, 2, 12, 0, 0, 0).getTime();
		const today = new Date(2026, 3, 2, 8, 0, 0, 0).getTime();
		const yesterday = new Date(2026, 3, 1, 18, 0, 0, 0).getTime();
		const last7days = new Date(2026, 2, 30, 9, 0, 0, 0).getTime();
		const last30days = new Date(2026, 2, 10, 9, 0, 0, 0).getTime();
		const older = new Date(2026, 1, 15, 9, 0, 0, 0).getTime();

		expect(classifyTimePeriod(today, now)).toBe("today");
		expect(classifyTimePeriod(yesterday, now)).toBe("yesterday");
		expect(classifyTimePeriod(last7days, now)).toBe("last7days");
		expect(classifyTimePeriod(last30days, now)).toBe("last30days");
		expect(classifyTimePeriod(older, now)).toBe("older");
	});

	test("treats invalid timestamps as older", () => {
		const now = new Date(2026, 3, 2, 12, 0, 0, 0).getTime();

		expect(classifyTimePeriod(0, now)).toBe("older");
		expect(classifyTimePeriod(Number.NaN, now)).toBe("older");
	});

	// Regression for CP-33 / PAR-72: boundaries must follow calendar days
	// (local midnight) rather than fixed 24h multiples, otherwise timestamps
	// near midnight on DST transition days land in the wrong bucket because the
	// transition day is only 23h (spring forward) or 25h (fall back) long.
	describe("daylight-saving boundaries (CP-33)", () => {
		const originalTZ = process.env["TZ"];

		afterEach(() => {
			if (originalTZ === undefined) delete process.env["TZ"];
			else process.env["TZ"] = originalTZ;
		});

		test("spring-forward: keeps the 23h day in the yesterday bucket", () => {
			// America/New_York 2025-03-09 02:00 EST -> 03:00 EDT (23h day).
			process.env["TZ"] = "America/New_York";

			const now = new Date(2025, 2, 10, 12, 0, 0, 0).getTime();
			// 23:30 on the day BEFORE the 23h transition day. Calendar-day
			// boundaries place this in last7days; the buggy 24h-multiple math
			// shifts yesterdayStart back an hour and misclassifies it as
			// "yesterday".
			const beforeYesterday = new Date(2025, 2, 8, 23, 30, 0, 0).getTime();
			expect(classifyTimePeriod(beforeYesterday, now)).toBe("last7days");

			// 00:30 just after the previous local midnight stays "yesterday".
			const earlyYesterday = new Date(2025, 2, 9, 0, 30, 0, 0).getTime();
			expect(classifyTimePeriod(earlyYesterday, now)).toBe("yesterday");
		});

		test("fall-back: keeps the early hours of the 25h day in yesterday", () => {
			// America/New_York 2025-11-02 02:00 EDT -> 01:00 EST (25h day).
			process.env["TZ"] = "America/New_York";

			const now = new Date(2025, 10, 3, 12, 0, 0, 0).getTime();
			// 00:30 on the 25h transition day is just after local midnight, so it
			// belongs to "yesterday". The buggy 24h-multiple math pushes
			// yesterdayStart forward an hour and demotes it to "last7days".
			const earlyTransitionDay = new Date(2025, 10, 2, 0, 30, 0, 0).getTime();
			expect(classifyTimePeriod(earlyTransitionDay, now)).toBe("yesterday");
		});
	});
});

describe("groupByTimePeriod", () => {
	test("groups items in default order", () => {
		const now = new Date(2026, 3, 2, 12, 0, 0, 0).getTime();
		const originalNow = Date.now;
		Date.now = () => now;

		try {
			const items = [
				{ id: "today", timestamp: new Date(2026, 3, 2, 8, 0, 0, 0).getTime() },
				{
					id: "yesterday",
					timestamp: new Date(2026, 3, 1, 18, 0, 0, 0).getTime(),
				},
				{
					id: "last7days",
					timestamp: new Date(2026, 2, 30, 9, 0, 0, 0).getTime(),
				},
				{
					id: "last30days",
					timestamp: new Date(2026, 2, 10, 9, 0, 0, 0).getTime(),
				},
				{ id: "older", timestamp: 0 },
			];

			const grouped = groupByTimePeriod(items, (item) => item.timestamp);

			expect([...grouped.keys()]).toEqual([
				"today",
				"yesterday",
				"last7days",
				"last30days",
				"older",
			]);
			expect(grouped.get("today")?.map((item) => item.id)).toEqual(["today"]);
			expect(grouped.get("yesterday")?.map((item) => item.id)).toEqual([
				"yesterday",
			]);
			expect(grouped.get("last7days")?.map((item) => item.id)).toEqual([
				"last7days",
			]);
			expect(grouped.get("last30days")?.map((item) => item.id)).toEqual([
				"last30days",
			]);
			expect(grouped.get("older")?.map((item) => item.id)).toEqual(["older"]);
		} finally {
			Date.now = originalNow;
		}
	});

	test("falls back to the next requested bucket when finer periods are omitted", () => {
		const now = new Date(2026, 3, 2, 12, 0, 0, 0).getTime();
		const originalNow = Date.now;
		Date.now = () => now;

		try {
			const items = [
				{ id: "today", timestamp: new Date(2026, 3, 2, 8, 0, 0, 0).getTime() },
				{
					id: "yesterday",
					timestamp: new Date(2026, 3, 1, 18, 0, 0, 0).getTime(),
				},
				{
					id: "older",
					timestamp: new Date(2026, 2, 28, 9, 0, 0, 0).getTime(),
				},
			];

			const grouped = groupByTimePeriod(items, (item) => item.timestamp, [
				"today",
				"yesterday",
				"older",
			]);

			expect(grouped.get("today")?.map((item) => item.id)).toEqual(["today"]);
			expect(grouped.get("yesterday")?.map((item) => item.id)).toEqual([
				"yesterday",
			]);
			expect(grouped.get("older")?.map((item) => item.id)).toEqual(["older"]);
		} finally {
			Date.now = originalNow;
		}
	});
});

describe("TIME_PERIOD_LABELS", () => {
	test("exports stable labels", () => {
		expect(TIME_PERIOD_LABELS).toEqual({
			today: "Today",
			yesterday: "Yesterday",
			last7days: "Last 7 Days",
			last30days: "Last 30 Days",
			older: "Older",
		});
	});
});
