import { describe, expect, test } from "bun:test";
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
