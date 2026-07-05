#!/usr/bin/env bun
/**
 * Mock hygiene gate — CCSTD-06 (PAR-301).
 *
 * Bun's `mock.module()` is process-global and is NOT undone by
 * `mock.restore()` (bun #7823, #12823, #6024). A test file that mocks a shared
 * pure Node builtin — `node:fs`, `node:fs/promises`, `node:child_process` — with
 * a PARTIAL factory (only the handful of methods it needs, no fall-through) can
 * therefore shadow the real module for any test that loads afterwards in the
 * same worker. When that happens the victim gets `undefined` for every method
 * the partial mock omitted, and the full suite only stays green by file
 * load-order. This class of flake recurred 3× during the ledger work
 * (classifier stub pin, BinaryManager↔session-resolver fs leak, taskflow
 * ThemeColor) — see research + the Test-suite-mock-architecture note.
 *
 * The documented safe pattern (test/MOCK_HYGIENE.md) is to fall through to a
 * frozen real snapshot stashed by `test/setup/global-test-cleanup.ts` at worker
 * startup, so unmocked calls hit the real implementation instead of `undefined`:
 *
 *     const realFs = (globalThis as Record<string, unknown>)["__realNodeFs"]
 *         as typeof import("node:fs");
 *     mock.module("node:fs", () => ({ ...realFs, watch: myWatchStub }));
 *
 * A bare `mock.module("node:fs", () => (fs))` that returns the real snapshot
 * (or `require("node:fs")`) directly is also safe — it pins the real module.
 *
 * This gate flags any test file that mocks a guarded builtin without referencing
 * the matching real snapshot (or a `require()` real-pin), making the leak a hard
 * CI failure instead of an order-dependent surprise.
 *
 * Wired into `just test-quality` (which `just ci` runs). Standalone:
 *
 *   bun run scripts-v2/mock-hygiene-gate.ts [--dir test]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Guarded builtins → the frozen real-snapshot token that makes a mock safe. */
export const GUARDED_BUILTINS: Record<string, string> = {
	"node:fs": "__realNodeFs",
	"node:fs/promises": "__realNodeFsPromises",
	"node:child_process": "__realNodeChildProcess",
};

export type MockHygieneViolation = {
	file: string;
	module: string;
	rule: string;
	detail: string;
};

/**
 * Strip line + block comments so `mock.module(...)` examples inside JSDoc
 * (e.g. test/helpers/typed-mocks.ts) — and prose that happens to contain a
 * `/*` glob fragment like `tree-view/*.test.ts` — are never mistaken for real
 * code. A single left-to-right scanner (not regex) is required: a naive
 * block-comment regex pairs a `/*` inside a `//` comment with a much later
 * `*\/`, swallowing real code in between.
 *
 * String literals are preserved verbatim, including their delimiters — a mock
 * target really is a string literal (`mock.module("node:fs", …)`), so the
 * scanner must not treat `//` or `/*` inside a string as a comment.
 */
export function stripComments(src: string): string {
	let out = "";
	let i = 0;
	const n = src.length;
	while (i < n) {
		const c = src[i];
		const d = src[i + 1];
		// Line comment: drop to end of line, keep the newline.
		if (c === "/" && d === "/") {
			i += 2;
			while (i < n && src[i] !== "\n") i++;
			continue;
		}
		// Block comment: drop to the closing */, emit a space so tokens on
		// either side stay separated.
		if (c === "/" && d === "*") {
			i += 2;
			while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			out += " ";
			continue;
		}
		// String / template literal: copy verbatim, honoring escapes.
		if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			out += c;
			i++;
			while (i < n) {
				out += src[i];
				if (src[i] === "\\") {
					out += src[i + 1] ?? "";
					i += 2;
					continue;
				}
				if (src[i] === quote) {
					i++;
					break;
				}
				i++;
			}
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** True when the file registers a module mock for exactly `mod`. */
function mocksBuiltin(code: string, mod: string): boolean {
	// Anchor the closing quote so "node:fs" does not match "node:fs/promises".
	const re = new RegExp(
		`mock\\.module\\(\\s*["']${escapeRegExp(mod)}["']`,
	);
	return re.test(code);
}

/**
 * True when the file references the frozen real snapshot for `mod`, matched as a
 * whole token so `__realNodeFs` is not spuriously satisfied by a lone
 * `__realNodeFsPromises` reference.
 */
function referencesSnapshot(code: string, snapshotToken: string): boolean {
	const re = new RegExp(`${escapeRegExp(snapshotToken)}(?![A-Za-z])`);
	return re.test(code);
}

/** True when the file pins the real module via `require("<mod>")`. */
function pinsRealViaRequire(code: string, mod: string): boolean {
	const re = new RegExp(`require\\(\\s*["']${escapeRegExp(mod)}["']\\s*\\)`);
	return re.test(code);
}

/**
 * Scan a single source file's text for guarded-builtin mocks that lack a real
 * fall-through. Pure — takes text, returns violations. Exposed for unit tests.
 */
export function scanSource(
	file: string,
	src: string,
): MockHygieneViolation[] {
	const code = stripComments(src);
	const violations: MockHygieneViolation[] = [];
	for (const [mod, snapshotToken] of Object.entries(GUARDED_BUILTINS)) {
		if (!mocksBuiltin(code, mod)) continue;
		const safe =
			referencesSnapshot(code, snapshotToken) || pinsRealViaRequire(code, mod);
		if (!safe) {
			violations.push({
				file,
				module: mod,
				rule: "node-builtin-fallthrough",
				detail:
					`mock.module("${mod}", …) has no fall-through to the real module. ` +
					`Spread the frozen snapshot: ` +
					`const real = (globalThis as Record<string, unknown>)["${snapshotToken}"]; ` +
					`mock.module("${mod}", () => ({ ...real, /* overrides */ })). ` +
					`See test/MOCK_HYGIENE.md.`,
			});
		}
	}
	return violations;
}

const SKIP_DIR = new Set([
	"node_modules",
	"_deleted",
	".legacy",
	"legacy",
	"discovery-e2e",
]);

/** Recursively collect `*.ts` files under `dir`, honoring the bunfig ignores. */
export function collectTestFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (SKIP_DIR.has(entry)) continue;
			out.push(...collectTestFiles(full));
		} else if (
			entry.endsWith(".ts") &&
			// The gate's own script + test intentionally contain unsafe example
			// strings; never scan them.
			!full.includes("mock-hygiene-gate")
		) {
			out.push(full);
		}
	}
	return out;
}

export function scanTree(dir: string): MockHygieneViolation[] {
	const violations: MockHygieneViolation[] = [];
	for (const file of collectTestFiles(dir)) {
		violations.push(...scanSource(file, readFileSync(file, "utf8")));
	}
	return violations;
}

async function main(): Promise<void> {
	const dirArg = process.argv.indexOf("--dir");
	const dir = dirArg !== -1 ? (process.argv[dirArg + 1] ?? "test") : "test";
	const violations = scanTree(dir);
	if (violations.length === 0) {
		console.log(
			"✅ mock hygiene: all node-builtin mocks fall through to the real snapshot",
		);
		return;
	}
	console.error(
		`❌ mock hygiene: ${violations.length} partial node-builtin mock(s) without real fall-through\n`,
	);
	for (const v of violations) {
		console.error(`  ${v.file}`);
		console.error(`    ${v.module}: ${v.detail}\n`);
	}
	console.error(
		"💡 Partial mocks of shared Node builtins leak across Bun test files " +
			"(mock.module is process-global). Fall through to globalThis.__realNode*.\n" +
			"   See test/MOCK_HYGIENE.md.",
	);
	process.exit(1);
}

if (import.meta.main) {
	await main();
}
