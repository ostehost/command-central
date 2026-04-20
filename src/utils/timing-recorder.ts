/**
 * TimingRecorder — small wall-clock instrumentation for hot paths.
 *
 * Purpose: surface real, measured numbers for `processScanner.scan()`,
 * `agentRegistry.doProcessScan()`, tree-provider getChildren/getTreeItem/
 * resolveTreeItem, and `reload()` in the existing diagnostics report so we
 * can make informed architecture decisions instead of guessing where time
 * is spent.
 *
 * Design:
 *  - Per label, keep a bounded ring of the last N samples (default 20).
 *  - Stats: count, last, p50, p95, max — computed lazily on read.
 *  - Overhead is one Map lookup + one performance.now() pair per call,
 *    well under a microsecond. Safe to leave on in production builds.
 *  - Use `time` / `timeAsync` as fire-and-forget wrappers; they always
 *    record duration, including on thrown/rejected paths.
 */

const DEFAULT_RING_SIZE = 20;

export interface TimingStats {
	label: string;
	count: number;
	lastMs: number;
	p50Ms: number;
	p95Ms: number;
	maxMs: number;
}

interface RingEntry {
	samples: number[]; // ring buffer of last N durations (ms)
	cursor: number; // next write index
	totalCount: number; // total samples ever recorded (for the n= column)
}

export class TimingRecorder {
	private readonly rings = new Map<string, RingEntry>();
	private readonly ringSize: number;

	constructor(ringSize: number = DEFAULT_RING_SIZE) {
		this.ringSize = Math.max(1, ringSize);
	}

	record(label: string, durationMs: number): void {
		const entry = this.rings.get(label) ?? {
			samples: [],
			cursor: 0,
			totalCount: 0,
		};
		if (entry.samples.length < this.ringSize) {
			entry.samples.push(durationMs);
		} else {
			entry.samples[entry.cursor] = durationMs;
		}
		entry.cursor = (entry.cursor + 1) % this.ringSize;
		entry.totalCount += 1;
		this.rings.set(label, entry);
	}

	time<T>(label: string, fn: () => T): T {
		const start = performance.now();
		try {
			return fn();
		} finally {
			this.record(label, performance.now() - start);
		}
	}

	async timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
		const start = performance.now();
		try {
			return await fn();
		} finally {
			this.record(label, performance.now() - start);
		}
	}

	getStats(label: string): TimingStats | null {
		const entry = this.rings.get(label);
		if (!entry || entry.samples.length === 0) return null;
		return computeStats(label, entry);
	}

	getAllStats(): TimingStats[] {
		const result: TimingStats[] = [];
		for (const [label, entry] of this.rings) {
			if (entry.samples.length > 0) {
				result.push(computeStats(label, entry));
			}
		}
		return result.sort((a, b) => b.maxMs - a.maxMs);
	}

	clear(): void {
		this.rings.clear();
	}

	formatReportLines(): string[] {
		const stats = this.getAllStats();
		if (stats.length === 0) return [];
		const lines = [`Timings (last ${this.ringSize} samples, sorted by max):`];
		const labelWidth = Math.max(...stats.map((s) => s.label.length));
		for (const s of stats) {
			lines.push(
				`  ${s.label.padEnd(labelWidth)} n=${s.count} last=${formatMs(s.lastMs)} p50=${formatMs(s.p50Ms)} p95=${formatMs(s.p95Ms)} max=${formatMs(s.maxMs)}`,
			);
		}
		return lines;
	}
}

function computeStats(label: string, entry: RingEntry): TimingStats {
	const sorted = [...entry.samples].sort((a, b) => a - b);
	const lastWriteIndex =
		(entry.cursor - 1 + entry.samples.length) % entry.samples.length;
	const lastMs = entry.samples[lastWriteIndex] ?? 0;
	return {
		label,
		count: entry.totalCount,
		lastMs,
		p50Ms: percentile(sorted, 0.5),
		p95Ms: percentile(sorted, 0.95),
		maxMs: sorted[sorted.length - 1] ?? 0,
	};
}

function percentile(sortedAsc: number[], q: number): number {
	// "Top (1-q) of samples" semantics — for small ring buffers this collapses
	// p95 toward the maximum so a single slow outlier in the last 20 samples
	// is visible in the diagnostics report instead of being averaged away.
	// For larger N it behaves like a normal floor-rank percentile.
	if (sortedAsc.length === 0) return 0;
	const idx = Math.min(
		sortedAsc.length - 1,
		Math.max(0, Math.floor(q * sortedAsc.length)),
	);
	return sortedAsc[idx] ?? 0;
}

function formatMs(ms: number): string {
	if (ms < 1) return `${ms.toFixed(2)}ms`;
	if (ms < 100) return `${ms.toFixed(1)}ms`;
	return `${Math.round(ms)}ms`;
}

/**
 * Process-wide singleton. Tests can either clear it between runs or
 * construct their own `TimingRecorder` and inject it where needed.
 */
export const defaultTimingRecorder = new TimingRecorder();
