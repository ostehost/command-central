/**
 * Formats a timestamp as relative time using native Intl.RelativeTimeFormat
 * Zero dependencies, maximum performance, built-in i18n support
 *
 * @module relative-time
 */

export interface FormatOptions {
	/** Style of the relative time format */
	style?: "long" | "short" | "narrow";
	/** Locale for formatting (default: 'en') */
	locale?: string;
}

/**
 * Formats a timestamp as a compact relative time string used in sidebar labels
 * and descriptions (for example "2s ago", "5m ago", "2h ago").
 *
 * Invalid or future timestamps collapse to "just now" so tree items never show
 * misleading raw dates or negative durations.
 */
export function relativeTime(
	date: Date | string | number | null | undefined,
	now: number = Date.now(),
): string {
	if (date === null || date === undefined) {
		return "just now";
	}

	const then = date instanceof Date ? date.getTime() : new Date(date).getTime();
	if (!Number.isFinite(then)) {
		return "just now";
	}

	const diffMs = now - then;
	if (diffMs <= 0) {
		return "just now";
	}

	if (diffMs < 60_000) {
		return `${Math.max(1, Math.floor(diffMs / 1000))}s ago`;
	}
	if (diffMs < 3_600_000) {
		return `${Math.floor(diffMs / 60_000)}m ago`;
	}
	if (diffMs < 86_400_000) {
		return `${Math.floor(diffMs / 3_600_000)}h ago`;
	}
	return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

// Time unit thresholds in seconds
const TIME_UNITS = [
	{ unit: "year" as const, seconds: 31536000 }, // 365 days
	{ unit: "month" as const, seconds: 2592000 }, // 30 days
	{ unit: "week" as const, seconds: 604800 }, // 7 days
	{ unit: "day" as const, seconds: 86400 }, // 24 hours
	{ unit: "hour" as const, seconds: 3600 }, // 60 minutes
	{ unit: "minute" as const, seconds: 60 }, // 60 seconds
	{ unit: "second" as const, seconds: 1 },
] as const;

/**
 * Formats a timestamp as relative time (e.g., "2 hours ago", "yesterday")
 * Uses native Intl.RelativeTimeFormat for zero-dependency, performant formatting
 *
 * @param timestamp - Unix timestamp in milliseconds, or undefined
 * @param now - Current time in milliseconds (default: Date.now())
 * @param options - Formatting options (style, locale)
 * @returns Formatted relative time string
 *
 * @remarks
 * Edge cases handled gracefully:
 * - Invalid timestamps (undefined, 0, NaN) return "unknown"
 * - Future timestamps (clock skew) return "now"
 * - Times < 60 seconds return "now"
 * - Automatically uses locale-appropriate formats ("yesterday" vs "1 day ago")
 * - Safe fallback for any unexpected conditions
 *
 * Performance considerations:
 * - Native browser API, no external dependencies
 * - Efficient O(1) time unit selection
 * - Minimal object allocations
 *
 * @example
 * // Basic usage
 * formatRelativeTime(Date.now() - 60000) // "1 minute ago"
 * formatRelativeTime(Date.now() - 86400000) // "yesterday"
 *
 * @example
 * // Edge cases
 * formatRelativeTime(undefined) // "unknown"
 * formatRelativeTime(0) // "unknown"
 * formatRelativeTime(NaN) // "unknown"
 * formatRelativeTime(Date.now() + 60000) // "now" (future date)
 * formatRelativeTime(Date.now() - 30000) // "now" (< 1 minute)
 *
 * @example
 * // With options
 * formatRelativeTime(timestamp, now, { style: 'short' }) // "5 min. ago"
 * formatRelativeTime(timestamp, now, { locale: 'es' }) // "hace 5 minutos"
 */
export function formatRelativeTime(
	timestamp: number | undefined,
	now: number = Date.now(),
	options: FormatOptions = {},
): string {
	// Handle invalid timestamps
	if (!timestamp || timestamp === 0 || Number.isNaN(timestamp)) {
		return "unknown";
	}

	// Handle future dates (clock skew) - show as "now"
	if (timestamp > now) {
		return "now";
	}

	const { style = "long", locale = "en" } = options;

	// Create formatter with auto numeric (shows "yesterday" instead of "1 day ago")
	const rtf = new Intl.RelativeTimeFormat(locale, {
		numeric: "auto",
		style,
	});

	// Calculate time difference in seconds
	const seconds = Math.round((now - timestamp) / 1000);

	// Special case: less than a minute shows as "now"
	if (seconds < 60) {
		// Use 0 seconds which Intl formats as "now" with numeric: 'auto'
		return rtf.format(0, "second");
	}

	// Find the appropriate unit for the time difference
	for (const { unit, seconds: unitSeconds } of TIME_UNITS) {
		if (seconds >= unitSeconds) {
			const value = Math.round(seconds / unitSeconds);
			// Use negative value to indicate past time
			return rtf.format(-value, unit);
		}
	}

	// This should never be reached, but just in case
	return rtf.format(0, "second");
}
