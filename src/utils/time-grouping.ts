export type TimePeriod =
	| "today"
	| "yesterday"
	| "last7days"
	| "last30days"
	| "older";

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
	// Derive each boundary as the local midnight of the corresponding calendar
	// day (N days ago) rather than subtracting fixed 24h multiples from today's
	// midnight. On DST transition days a calendar day is 23h or 25h long, so the
	// 24h-multiple approach drifts and lands near-midnight timestamps in the
	// wrong bucket. Date's normalization (getDate() - n) handles month/year
	// rollover and DST correctly.
	const calendarDayStart = (daysAgo: number): number =>
		new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate() - daysAgo,
		).getTime();
	const todayStart = calendarDayStart(0);
	const yesterdayStart = calendarDayStart(1);
	const last7DaysStart = calendarDayStart(7);
	const last30DaysStart = calendarDayStart(30);

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
