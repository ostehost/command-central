/**
 * Tests for formatters.ts
 *
 * Testing strategy:
 * - Core functionality: YYYY-MM-DD format validation
 * - Timezone handling: UTC vs local behavior
 * - Edge cases: Leap years, month/day padding, year boundaries
 * - Compatibility: Matches expected behavior (toISOString() equivalent)
 */

import { expect, test } from "bun:test";
import { getUTCDateString } from "../../src/utils/formatters.ts";

// ============================================================================
// getUTCDateString() - Core UTC Formatting Tests
// ============================================================================

test("getUTCDateString returns YYYY-MM-DD format", () => {
	const date = new Date("2025-11-17T15:30:45.123Z");
	const result = getUTCDateString(date);

	expect(result).toBe("2025-11-17");
	expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("getUTCDateString uses UTC timezone (not local)", () => {
	// Test date that might have timezone issues
	// If this test runs in PST (UTC-8), local date would be Dec 31, 2024
	const date = new Date("2025-01-01T00:00:00.000Z");
	const result = getUTCDateString(date);

	// Should be 2025-01-01 in UTC, regardless of local timezone
	expect(result).toBe("2025-01-01");
});

test("getUTCDateString handles month/day padding correctly", () => {
	const date = new Date("2025-03-05T12:00:00.000Z");
	const result = getUTCDateString(date);

	// Should have leading zeros for single-digit month/day
	expect(result).toBe("2025-03-05");
});

test("getUTCDateString matches toISOString() date part", () => {
	const date = new Date("2025-11-17T23:59:59.999Z");
	const result = getUTCDateString(date);
	const isoDate = date.toISOString().split("T")[0] as string;

	// Should match the behavior it replaced
	expect(result).toBe(isoDate);
	expect(result).toBe("2025-11-17");
});

test("getUTCDateString handles leap years", () => {
	const date = new Date("2024-02-29T12:00:00.000Z");
	const result = getUTCDateString(date);

	expect(result).toBe("2024-02-29");
});

// Edge Cases
test("getUTCDateString handles Y2K era", () => {
	const date = new Date("2000-01-01T00:00:00.000Z");
	const result = getUTCDateString(date);

	expect(result).toBe("2000-01-01");
});

test("getUTCDateString handles December 31st edge case", () => {
	const date = new Date("2024-12-31T23:59:59.999Z");
	const result = getUTCDateString(date);

	expect(result).toBe("2024-12-31");
});

test("getUTCDateString handles January 1st edge case", () => {
	const date = new Date("2025-01-01T00:00:00.000Z");
	const result = getUTCDateString(date);

	expect(result).toBe("2025-01-01");
});

test("getUTCDateString is consistent across multiple calls", () => {
	const date = new Date("2025-11-17T15:30:45.123Z");

	// Test memoization doesn't affect correctness
	const result1 = getUTCDateString(date);
	const result2 = getUTCDateString(date);
	const result3 = getUTCDateString(date);

	expect(result1).toBe(result2);
	expect(result2).toBe(result3);
	expect(result1).toBe("2025-11-17");
});
