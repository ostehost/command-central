export type TimePeriod =
	| "today"
	| "yesterday"
	| "last7days"
	| "last30days"
	| "older";

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_PERIODS: TimePeriod[] = [
	"today",
	"yesterday",
	"last7days",
	"last30days",
	"older",
];

export const TIME_PERIOD_LABELS: Record<TimePeriod, string> = {
	today: "Today",
	yesterday: "Yesterday",
	last7days: "Last 7 Days",
	last30days: "Last 30 Days",
	older: "Older",
};

export function classifyTimePeriod(
	timestampMs: number,
	nowMs: number = Date.now(),
): TimePeriod {
	if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
		return "older";
	}

	const now = new Date(nowMs);
	const todayStart = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate(),
	).getTime();
	const yesterdayStart = todayStart - DAY_MS;
	const last7DaysStart = todayStart - 7 * DAY_MS;
	const last30DaysStart = todayStart - 30 * DAY_MS;

	if (timestampMs >= todayStart) return "today";
	if (timestampMs >= yesterdayStart) return "yesterday";
	if (timestampMs >= last7DaysStart) return "last7days";
	if (timestampMs >= last30DaysStart) return "last30days";
	return "older";
}

function resolveRequestedPeriod(
	classified: TimePeriod,
	requestedPeriods: TimePeriod[],
): TimePeriod | null {
	if (requestedPeriods.includes(classified)) {
		return classified;
	}

	const classifiedIndex = DEFAULT_PERIODS.indexOf(classified);
	for (
		let index = classifiedIndex + 1;
		index < DEFAULT_PERIODS.length;
		index++
	) {
		const fallback = DEFAULT_PERIODS[index];
		if (fallback && requestedPeriods.includes(fallback)) {
			return fallback;
		}
	}

	return null;
}

/**
 * Formats a timestamp as a compact relative time string for sidebar descriptions.
 *
 * Rules:
 * - < 1 minute  → "just now"
 * - < 60 minutes → "Nm ago"  (e.g. "5m ago")
 * - < 24 hours   → "Nh ago"  (e.g. "2h ago")
 * - < 7 days     → "Nd ago"  (e.g. "3d ago")
 * - < 30 days    → "Nw ago"  (e.g. "2w ago")
 * - ≥ 30 days    → "Nd ago"  (e.g. "45d ago")
 */
export function formatRelativeTime(
	timestampMs: number,
	nowMs: number = Date.now(),
): string {
	if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
		return "just now";
	}
	const diffMs = nowMs - timestampMs;
	if (diffMs <= 0) return "just now";

	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.floor(diffMs / 3_600_000);
	if (hours < 24) return `${hours}h ago`;

	const days = Math.floor(diffMs / 86_400_000);
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	return `${days}d ago`;
}

export function groupByTimePeriod<T>(
	items: T[],
	getTimestamp: (item: T) => number,
	periods: TimePeriod[] = DEFAULT_PERIODS,
): Map<TimePeriod, T[]> {
	const grouped = new Map<TimePeriod, T[]>();
	for (const period of periods) {
		grouped.set(period, []);
	}

	const nowMs = Date.now();
	for (const item of items) {
		const classified = classifyTimePeriod(getTimestamp(item), nowMs);
		const resolved = resolveRequestedPeriod(classified, periods);
		if (!resolved) continue;
		grouped.get(resolved)?.push(item);
	}

	return grouped;
}
