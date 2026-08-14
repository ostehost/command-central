#!/usr/bin/env bun

/**
 * bench-agent-status-primitives — standalone cost ceiling for the
 * agent-status-truth wave (Slices 2 and 4).
 *
 * Measures the raw primitives the merged provider will call on every refresh:
 *
 *   1. `tmux list-panes -a -F "#{pane_current_command}|#{pane_pid}"`
 *      via `execFileSync` — the Slice 2 tmux-pane-health probe.
 *      Note: this script uses `-a` (server-wide enumeration) as a
 *      deliberate worst-case upper bound. Slice 2's actual probe is
 *      session-scoped (`list-panes -s -t <sessionId>`) and is therefore
 *      strictly faster in real use. Treat the numbers below as a
 *      ceiling, not an expected value.
 *   2. `fs.statSync` on a real file — the Slice 4-B handoff-file probe.
 *
 * Then synthesizes a worst-case cold-cache refresh cost for N tasks.
 *
 * Deliberately imports nothing from `src/`: this is a diagnostic that must
 * be runnable even before the slice branches are merged, so the team has a
 * hard cost ceiling independent of the integration lane.
 *
 * Usage:
 *   bun run scripts/bench-agent-status-primitives.ts
 *
 * Output: human-readable report on stdout, plus a single grep-friendly
 * summary line as the last line of output.
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

type Stats = {
	label: string;
	samples: number;
	min: number;
	median: number;
	p95: number;
	max: number;
	skipped?: string;
};

function summarize(label: string, samples: number[]): Stats {
	if (samples.length === 0) {
		return {
			label,
			samples: 0,
			min: 0,
			median: 0,
			p95: 0,
			max: 0,
			skipped: "no samples",
		};
	}
	const sorted = [...samples].sort((a, b) => a - b);
	const pct = (q: number) =>
		sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
	return {
		label,
		samples: sorted.length,
		min: sorted[0] ?? 0,
		median: pct(0.5),
		p95: pct(0.95),
		max: sorted[sorted.length - 1] ?? 0,
	};
}

function fmt(ms: number): string {
	return ms.toFixed(3).padStart(8, " ");
}

function printStats(s: Stats): void {
	if (s.skipped) {
		console.log(`  ${s.label}: SKIPPED (${s.skipped})`);
		return;
	}
	console.log(
		`  ${s.label.padEnd(24, " ")} n=${String(s.samples).padStart(4, " ")}  min=${fmt(s.min)}ms  median=${fmt(s.median)}ms  p95=${fmt(s.p95)}ms  max=${fmt(s.max)}ms`,
	);
}

function benchTmux(iterations: number): Stats {
	const samples: number[] = [];
	let firstError: string | null = null;
	for (let i = 0; i < iterations; i++) {
		const t0 = performance.now();
		try {
			execFileSync(
				"tmux",
				["list-panes", "-a", "-F", "#{pane_current_command}|#{pane_pid}"],
				{ timeout: 500, stdio: ["ignore", "pipe", "pipe"] },
			);
			samples.push(performance.now() - t0);
		} catch (err) {
			if (!firstError) {
				firstError = err instanceof Error ? err.message : String(err);
			}
			// stop immediately if tmux is not installed / no server — this
			// is a diagnostic, not a stress test.
			break;
		}
	}
	if (samples.length === 0) {
		return {
			label: "tmux list-panes",
			samples: 0,
			min: 0,
			median: 0,
			p95: 0,
			max: 0,
			skipped: firstError ?? "tmux unavailable",
		};
	}
	return summarize("tmux list-panes", samples);
}

function benchStat(iterations: number): Stats {
	const target = fileURLToPath(import.meta.url);
	const samples: number[] = [];
	let firstError: string | null = null;
	for (let i = 0; i < iterations; i++) {
		const t0 = performance.now();
		try {
			statSync(target);
			samples.push(performance.now() - t0);
		} catch (err) {
			if (!firstError) {
				firstError = err instanceof Error ? err.message : String(err);
			}
			break;
		}
	}
	if (samples.length === 0) {
		return {
			label: "fs.statSync",
			samples: 0,
			min: 0,
			median: 0,
			p95: 0,
			max: 0,
			skipped: firstError ?? "statSync unavailable",
		};
	}
	return summarize("fs.statSync", samples);
}

function printCeilingTable(tmuxMedian: number, statMedian: number): void {
	const sizes = [10, 25, 50, 100];
	console.log(
		"\nSynthesized cold-cache refresh ceiling (tmux_median + stat_median) * N:",
	);
	console.log(
		"  (real provider cost will be LESS — 5s TTL cache amortizes across refreshes)",
	);
	console.log("");
	console.log("    N tasks   ceiling (ms)");
	console.log("    -------   ------------");
	for (const n of sizes) {
		const ceiling = (tmuxMedian + statMedian) * n;
		console.log(
			`    ${String(n).padStart(7, " ")}   ${ceiling.toFixed(2).padStart(12, " ")}`,
		);
	}
}

function main(): void {
	console.log("bench-agent-status-primitives");
	console.log("=============================");
	console.log("");
	console.log("Measures raw primitives used by the agent-status-truth wave:");
	console.log("  Slice 2 — execFileSync('tmux', ['list-panes', ...])");
	console.log("  Slice 4 — fs.statSync(handoff_file)");
	console.log("");

	console.log("tmux primitive (100 iterations):");
	const tmux = benchTmux(100);
	printStats(tmux);

	console.log("\nstatSync primitive (1000 iterations):");
	const stat = benchStat(1000);
	printStats(stat);

	const tmuxMedian = tmux.skipped ? 0 : tmux.median;
	const statMedian = stat.skipped ? 0 : stat.median;

	if (!tmux.skipped && !stat.skipped) {
		printCeilingTable(tmuxMedian, statMedian);
	} else {
		console.log(
			"\nSkipping ceiling table: one or more primitives were unavailable.",
		);
	}

	const ceiling50 = (tmuxMedian + statMedian) * 50;
	console.log("");
	console.log(
		`bench-agent-status-primitives: tmux_median=${tmuxMedian.toFixed(2)}ms stat_median=${statMedian.toFixed(2)}ms ceiling_50tasks=${ceiling50.toFixed(2)}ms`,
	);
}

try {
	main();
} catch (err) {
	// Diagnostic, not a test — never throw.
	const msg = err instanceof Error ? err.message : String(err);
	console.log(`bench-agent-status-primitives: FAILED ${msg}`);
	console.log(
		"bench-agent-status-primitives: tmux_median=NaN stat_median=NaN ceiling_50tasks=NaN",
	);
}
