/**
 * Generic value-coercion helpers for parsing loosely-typed JSON (task
 * registries, projections, config blobs) into typed fields. Kept dependency-free
 * so any module can share them without pulling in provider state.
 */

/** Trimmed non-empty string, or undefined. */
export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

/** Finite number, or the supplied fallback. */
export function asNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) return fallback;
	return value;
}

/** Finite number, explicit `null`, or undefined when absent/invalid. */
export function asNullableNumber(value: unknown): number | null | undefined {
	if (value === null) return null;
	if (typeof value !== "number" || Number.isNaN(value)) return undefined;
	return value;
}
