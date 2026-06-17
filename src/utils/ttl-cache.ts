/**
 * Small time-to-live cache for memoizing short-lived probe results.
 *
 * The agent-status provider repeatedly re-probes liveness / file-state with a
 * uniform pattern: keep a `Map<key, { value, checkedAt }>`, return the cached
 * value while it is younger than a fixed TTL, otherwise re-run the probe and
 * stamp the result. This type centralizes that pattern so each probe site is a
 * declarative `getFresh`/`set` pair instead of hand-rolled freshness math.
 *
 * Timestamps default to `Date.now()` to match the previous inline behavior;
 * `setAt`/the optional `now` arg let callers (and tests) supply deterministic
 * clocks.
 */
export class TtlCache<V> {
	private readonly store = new Map<string, { value: V; checkedAt: number }>();

	constructor(private readonly ttlMs: number) {}

	/** Cached value if present and younger than the TTL, else undefined. */
	getFresh(key: string, now: number = Date.now()): V | undefined {
		const entry = this.store.get(key);
		if (entry && now - entry.checkedAt < this.ttlMs) {
			return entry.value;
		}
		return undefined;
	}

	/** Store a value stamped at `now` (defaults to the current time). */
	set(key: string, value: V, now: number = Date.now()): void {
		this.store.set(key, { value, checkedAt: now });
	}

	/** Store a value with an explicit `checkedAt` timestamp. */
	setAt(key: string, value: V, checkedAt: number): void {
		this.store.set(key, { value, checkedAt });
	}

	/** True if a key has an entry (regardless of freshness). */
	has(key: string): boolean {
		return this.store.has(key);
	}

	delete(key: string): void {
		this.store.delete(key);
	}

	/** Delete every entry whose key satisfies the predicate (suffix scans, etc.). */
	deleteWhere(predicate: (key: string) => boolean): void {
		for (const key of this.store.keys()) {
			if (predicate(key)) this.store.delete(key);
		}
	}

	clear(): void {
		this.store.clear();
	}

	get size(): number {
		return this.store.size;
	}
}
