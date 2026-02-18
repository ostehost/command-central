/**
 * Date and time formatting utilities using native ECMA-402 APIs
 *
 * 2025 Monorepo Standard: Type-safe, performant, native-first formatting
 *
 * Key principles:
 * - Use memoized Intl.DateTimeFormat for performance
 * - Native API preferred over user-land libraries (date-fns, moment)
 * - Type-safe: respects noUncheckedIndexedAccess strict mode
 * - Explicit timezone handling (UTC) when needed
 *
 * Reference: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat
 */

/**
 * Memoized formatter for UTC dates in YYYY-MM-DD format
 * Created once at module load, reused for all invocations
 *
 * Performance note: Creating Intl.DateTimeFormat instances is expensive (~1ms each).
 * Memoizing it at module level ensures this cost is paid only once.
 */
const utcDateFormatter = new Intl.DateTimeFormat("en-CA", {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	// Explicitly set timezone to UTC to match toISOString() behavior
	timeZone: "UTC",
});

/**
 * Returns a date string in YYYY-MM-DD format (UTC timezone)
 *
 * This function replaces unsafe patterns like:
 * - `new Date().toISOString().split("T")[0]!` (uses non-null assertion)
 * - `new Date().toISOString().slice(0, 10)` (fragile to extended format)
 *
 * @param date - The date to format
 * @returns A string in YYYY-MM-DD format (UTC)
 *
 * @example
 * ```typescript
 * const filename = `build-${getUTCDateString(new Date())}.vsix`;
 * // Result: "build-2025-11-16.vsix"
 * ```
 */
export function getUTCDateString(date: Date): string {
	return utcDateFormatter.format(date);
}
