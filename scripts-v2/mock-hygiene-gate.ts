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
 * The check is PER `mock.module(...)` call, not per file: each guarded factory
 * must ITSELF fall through — by spreading/returning the snapshot token, a local
 * alias bound to it, or a `require()` real-pin. A real-snapshot decl elsewhere in
 * the file does NOT excuse a sibling factory that returns a bare partial like
 * `{ watch }`. That shape — the file mentions `__realNodeFs` but the offending
 * factory ignores it — is exactly the leak this gate exists to catch, so the
 * violation is a hard CI failure instead of an order-dependent surprise.
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

/** Advance past a string / template literal that starts at `start`. */
function skipString(code: string, start: number): number {
	const quote = code[start];
	const n = code.length;
	let i = start + 1;
	while (i < n) {
		if (code[i] === "\\") {
			i += 2;
			continue;
		}
		if (code[i] === quote) return i + 1;
		i++;
	}
	return i;
}

/**
 * Given the index of the `(` that opens a `mock.module(` call, return the text
 * of its factory argument (everything after the first top-level comma) and the
 * index just past the call's matching `)`. Parens are balanced with a string-
 * aware scanner so factory bodies like `() => ({ close() {} })` are handled, and
 * the module-string argument is excluded so an alias named `fs`/`cp` cannot be
 * spuriously matched inside `"node:fs"`.
 */
function sliceCallFactory(
	code: string,
	openParen: number,
): { factory: string; end: number } {
	const n = code.length;
	let i = openParen + 1;
	let depth = 1;
	let commaIdx = -1;
	while (i < n) {
		const c = code[i];
		if (c === '"' || c === "'" || c === "`") {
			i = skipString(code, i);
			continue;
		}
		if (c === "(") {
			depth++;
		} else if (c === ")") {
			depth--;
			if (depth === 0) {
				i++;
				break;
			}
		} else if (c === "," && depth === 1 && commaIdx === -1) {
			commaIdx = i;
		}
		i++;
	}
	const factory = commaIdx === -1 ? "" : code.slice(commaIdx + 1, i - 1);
	return { factory, end: i };
}

/**
 * Extract the factory text of every `mock.module("<mod>", <factory>)` call.
 * Anchoring the closing quote keeps "node:fs" from matching "node:fs/promises".
 */
function extractMockFactories(code: string, mod: string): string[] {
	const opener = new RegExp(
		`mock\\.module\\(\\s*["']${escapeRegExp(mod)}["']`,
		"g",
	);
	const factories: string[] = [];
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: canonical regex scan loop
	while ((m = opener.exec(code)) !== null) {
		const open = code.indexOf("(", m.index);
		if (open === -1) break;
		const { factory, end } = sliceCallFactory(code, open);
		factories.push(factory);
		opener.lastIndex = Math.max(end, opener.lastIndex);
	}
	return factories;
}

/**
 * Collect identifiers bound at file scope to the real module for `mod`: either
 * the frozen snapshot token (`const realFs = (globalThis…)["__realNodeFs"]`) or a
 * `require("<mod>")` pin. A factory that references one of these has fallen
 * through to the real module. The initializer may span lines (the token often
 * sits on its own line), so the gap is bounded by `;`/`{`/`}` — not newlines — to
 * stay inside a single declaration.
 */
function collectRealAliases(
	code: string,
	mod: string,
	snapshotToken: string,
): string[] {
	const aliases = new Set<string>();
	const snapDecl = new RegExp(
		`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;{}]*?${escapeRegExp(snapshotToken)}(?![A-Za-z])`,
		"g",
	);
	const reqDecl = new RegExp(
		`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;{}]*?require\\(\\s*["']${escapeRegExp(mod)}["']\\s*\\)`,
		"g",
	);
	for (const re of [snapDecl, reqDecl]) {
		let m: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: canonical regex scan loop
		while ((m = re.exec(code)) !== null) {
			if (m[1]) aliases.add(m[1]);
		}
	}
	return [...aliases];
}

/** True when `code` references `ident` as a whole token. */
function referencesIdentifier(code: string, ident: string): boolean {
	const re = new RegExp(`(?<![\\w$])${escapeRegExp(ident)}(?![\\w$])`);
	return re.test(code);
}

/**
 * True when a single `mock.module` factory falls through to the real module —
 * directly (snapshot token or `require()` pin inside the factory) or via a local
 * alias bound to the real snapshot.
 */
function factoryIsSafe(
	factory: string,
	mod: string,
	snapshotToken: string,
	aliases: string[],
): boolean {
	if (referencesSnapshot(factory, snapshotToken)) return true;
	if (pinsRealViaRequire(factory, mod)) return true;
	return aliases.some((a) => referencesIdentifier(factory, a));
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
		const factories = extractMockFactories(code, mod);
		if (factories.length === 0) continue;
		const aliases = collectRealAliases(code, mod, snapshotToken);
		for (const factory of factories) {
			if (factoryIsSafe(factory, mod, snapshotToken, aliases)) continue;
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
