#!/usr/bin/env bun
/**
 * VSIX content/size gate.
 *
 * Deterministically inspects a built VSIX (zip listing via `unzip -l`) and
 * fails when dev/proof artifacts leak into the package or the size budget
 * regresses. rc50 shipped 2.6MB compressed / 21.2MB / 488 files because
 * `.vscodeignore` missed nested directories; this gate makes that class of
 * regression a hard build failure instead of a prose review finding.
 *
 * Wired into scripts-v2/dist-simple.ts so every production candidate is
 * gated at packaging time, before it reaches releases/ or VS Code.
 * Standalone usage:
 *
 *   bun run scripts-v2/vsix-content-gate.ts [--vsix <path>]
 *   (defaults to the newest VSIX in releases/)
 */

import { spawn } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compareReleaseFileNames } from "./dist-simple-utils.ts";

export type VsixEntry = {
	path: string;
	uncompressedBytes: number;
};

export type VsixGateBudget = {
	maxCompressedBytes: number;
	maxUncompressedBytes: number;
	maxFileCount: number;
};

export type VsixGateViolation = {
	rule: string;
	detail: string;
};

export type VsixGateResult = {
	vsixPath: string;
	compressedBytes: number;
	uncompressedBytes: number;
	fileCount: number;
	violations: VsixGateViolation[];
	ok: boolean;
};

/**
 * Repo-relative directories that must never ship (the gate strips the
 * VSIX's `extension/` prefix before matching). Mirrors `.vscodeignore` —
 * the ignore file prevents the leak, this list detects a regression.
 */
export const FORBIDDEN_DIR_PREFIXES: readonly string[] = [
	".claude/",
	".clawpatch/",
	".cursor/",
	".git/",
	".githooks/",
	".github/",
	".preview-status/",
	".turbo/",
	".vscode/",
	".vscode-test/",
	"assets/",
	"coverage/",
	"coverage-ci/",
	"docs/",
	"drafts/",
	"logo-concepts/",
	"logs/",
	"memory/",
	"node_modules/",
	"releases/",
	"research/",
	"screenshots/",
	"scripts/",
	"scripts-v2/",
	"site/",
	"specs/",
	"src/",
	"test/",
];

const FORBIDDEN_SUFFIXES: readonly string[] = [
	".map",
	".log",
	".vsix",
	".tsbuildinfo",
];

/** vsce lowercases the packaged readme/changelog/license entry names. */
const ALLOWED_ROOT_MARKDOWN = new Set(["readme.md", "changelog.md", "license.md"]);

/**
 * Root-level non-markdown files permitted in the package. README/CHANGELOG/
 * LICENSE markdown are governed by {@link ALLOWED_ROOT_MARKDOWN}; this set
 * covers the remaining legitimate root entries. Anything else dropped at the
 * repo root — e.g. an internal `ledger.json` work-queue — matches no forbidden
 * directory or suffix and is not markdown, so without an allowlist it ships
 * silently under the size budget. This list makes that a hard gate failure.
 */
export const ALLOWED_ROOT_FILES: ReadonlySet<string> = new Set([
	"package.json",
	"LICENSE",
	"LICENSE.txt",
]);

/** Runtime payload that must survive any `.vscodeignore` tightening. */
export const REQUIRED_ENTRIES: readonly string[] = [
	"extension/package.json",
	"extension/dist/extension.js",
	"extension/resources/bin/ghostty-launcher",
	// bundle-runtime.sh probes windows via this helper; rc51 shipped without
	// it because sync-launcher only mirrored .sh/.py lib files.
	"extension/resources/bin/scripts/lib/window-probe.applescript",
	"extension/resources/icons/icon.png",
];

/**
 * The dieted VSIX measures 258KB compressed / 0.88MB / 51 files. Budgets
 * leave 2-3× headroom for organic growth while failing long before a
 * dev-artifact sweep-up (rc50 scale: 2.6MB / 21.2MB / 488 files) ships again.
 */
export const DEFAULT_BUDGET: VsixGateBudget = {
	maxCompressedBytes: 600_000,
	maxUncompressedBytes: 2_000_000,
	maxFileCount: 120,
};

/**
 * Parse `unzip -l` output into entries. Entry lines carry a size, a date,
 * a time, and a name; header/footer lines do not match the shape.
 */
export function parseUnzipListing(output: string): VsixEntry[] {
	const entries: VsixEntry[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(/^\s*(\d+)\s+[\d-]+\s+[\d:]+\s+(.+?)\s*$/);
		if (!match) continue;
		const [, size = "", name = ""] = match;
		if (!name || name.endsWith("/")) continue;
		entries.push({ path: name, uncompressedBytes: Number.parseInt(size, 10) });
	}
	return entries;
}

/** VSIX entries live under `extension/`; package metadata (manifest,
 * [Content_Types].xml) sits beside it and is exempt from content rules. */
function toRepoRelativePath(entryPath: string): string | null {
	return entryPath.startsWith("extension/")
		? entryPath.slice("extension/".length)
		: null;
}

function checkEntryRules(entries: VsixEntry[]): VsixGateViolation[] {
	const violations: VsixGateViolation[] = [];
	for (const entry of entries) {
		const relative = toRepoRelativePath(entry.path);
		if (relative === null) continue;

		const dir = FORBIDDEN_DIR_PREFIXES.find(prefix =>
			relative.startsWith(prefix),
		);
		if (dir) {
			violations.push({
				rule: `forbidden directory ${dir}`,
				detail: entry.path,
			});
			continue;
		}

		const suffix = FORBIDDEN_SUFFIXES.find(s => relative.endsWith(s));
		if (suffix) {
			violations.push({ rule: `forbidden suffix ${suffix}`, detail: entry.path });
			continue;
		}

		const lower = relative.toLowerCase();
		if (lower.endsWith(".md")) {
			if (!ALLOWED_ROOT_MARKDOWN.has(lower)) {
				violations.push({ rule: "markdown outside allowlist", detail: entry.path });
			}
			continue;
		}

		// Root-level non-source files must be explicitly allowlisted. A stray
		// file at the repo root (e.g. an internal ledger.json) matches no
		// forbidden directory or suffix and is not markdown, so without this it
		// sails through under the size budget. Nested files are governed by the
		// forbidden-directory rules above.
		if (!relative.includes("/") && !ALLOWED_ROOT_FILES.has(relative)) {
			violations.push({ rule: "unexpected root file", detail: entry.path });
		}
	}
	return violations;
}

function checkRequiredEntries(entries: VsixEntry[]): VsixGateViolation[] {
	const present = new Set(entries.map(entry => entry.path));
	return REQUIRED_ENTRIES.filter(required => !present.has(required)).map(
		required => ({ rule: "missing required entry", detail: required }),
	);
}

function checkBudget(
	compressedBytes: number,
	uncompressedBytes: number,
	fileCount: number,
	budget: VsixGateBudget,
): VsixGateViolation[] {
	const violations: VsixGateViolation[] = [];
	if (compressedBytes > budget.maxCompressedBytes) {
		violations.push({
			rule: "compressed size budget",
			detail: `${compressedBytes} bytes > ${budget.maxCompressedBytes} allowed`,
		});
	}
	if (uncompressedBytes > budget.maxUncompressedBytes) {
		violations.push({
			rule: "uncompressed size budget",
			detail: `${uncompressedBytes} bytes > ${budget.maxUncompressedBytes} allowed`,
		});
	}
	if (fileCount > budget.maxFileCount) {
		violations.push({
			rule: "file count budget",
			detail: `${fileCount} files > ${budget.maxFileCount} allowed`,
		});
	}
	return violations;
}

/**
 * Settings that drive a subprocess spawn or otherwise execute code, and so
 * MUST be listed in `capabilities.untrustedWorkspaces.restrictedConfigurations`
 * — a hostile workspace must not be able to point them at attacker-controlled
 * binaries/paths. `commandCentral.ghostty.launcherPath` is the binary
 * TerminalManager exec's; CCSTD-03 (PAR-82) pins it here so a future
 * config edit that drops it from the restricted list fails the build.
 */
export const SUBPROCESS_SPAWNING_SETTINGS: readonly string[] = [
	"commandCentral.ghostty.launcherPath",
];

type WorkspaceTrustManifest = {
	capabilities?: {
		untrustedWorkspaces?: {
			supported?: unknown;
			restrictedConfigurations?: unknown;
		};
	};
};

/**
 * Validates the Workspace Trust posture declared in package.json. The
 * extension executes project-defined shell via the launcher, so it must
 * declare an `untrustedWorkspaces` capability and restrict every
 * subprocess-spawning setting. This is the CCSTD-03 manifest receipt.
 */
export function evaluateWorkspaceTrustManifest(
	manifest: WorkspaceTrustManifest,
): VsixGateViolation[] {
	const violations: VsixGateViolation[] = [];
	const trust = manifest.capabilities?.untrustedWorkspaces;
	if (!trust) {
		violations.push({
			rule: "missing untrustedWorkspaces capability",
			detail: "capabilities.untrustedWorkspaces must be declared",
		});
		return violations;
	}

	const supported = trust.supported;
	if (supported !== true && supported !== false && supported !== "limited") {
		violations.push({
			rule: "invalid untrustedWorkspaces.supported",
			detail: `expected true | false | "limited", got ${JSON.stringify(supported)}`,
		});
	}

	const restricted = Array.isArray(trust.restrictedConfigurations)
		? new Set(trust.restrictedConfigurations.map(String))
		: new Set<string>();
	for (const setting of SUBPROCESS_SPAWNING_SETTINGS) {
		if (!restricted.has(setting)) {
			violations.push({
				rule: "subprocess setting not trust-restricted",
				detail: `${setting} must be in capabilities.untrustedWorkspaces.restrictedConfigurations`,
			});
		}
	}
	return violations;
}

export function evaluateVsixEntries(
	vsixPath: string,
	entries: VsixEntry[],
	compressedBytes: number,
	budget: VsixGateBudget = DEFAULT_BUDGET,
): VsixGateResult {
	const uncompressedBytes = entries.reduce(
		(sum, entry) => sum + entry.uncompressedBytes,
		0,
	);
	const violations = [
		...checkEntryRules(entries),
		...checkRequiredEntries(entries),
		...checkBudget(compressedBytes, uncompressedBytes, entries.length, budget),
	];
	return {
		vsixPath,
		compressedBytes,
		uncompressedBytes,
		fileCount: entries.length,
		violations,
		ok: violations.length === 0,
	};
}

async function listVsixEntries(vsixPath: string): Promise<VsixEntry[]> {
	const proc = spawn(["unzip", "-l", vsixPath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
	const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
	await proc.exited;
	if (proc.exitCode !== 0) {
		throw new Error(`unzip -l ${vsixPath} failed: ${stderr || stdout}`);
	}
	return parseUnzipListing(stdout);
}

export async function gateVsix(
	vsixPath: string,
	budget: VsixGateBudget = DEFAULT_BUDGET,
): Promise<VsixGateResult> {
	const stats = await fs.stat(vsixPath);
	const entries = await listVsixEntries(vsixPath);
	return evaluateVsixEntries(vsixPath, entries, stats.size, budget);
}

export function formatGateReport(result: VsixGateResult): string {
	const lines = [
		`VSIX content gate: ${result.vsixPath}`,
		`  compressed: ${result.compressedBytes} bytes (budget ${DEFAULT_BUDGET.maxCompressedBytes})`,
		`  uncompressed: ${result.uncompressedBytes} bytes (budget ${DEFAULT_BUDGET.maxUncompressedBytes})`,
		`  files: ${result.fileCount} (budget ${DEFAULT_BUDGET.maxFileCount})`,
	];
	if (result.ok) {
		lines.push("  ✅ no forbidden artifacts, budgets respected");
	} else {
		lines.push(`  ❌ ${result.violations.length} violation(s):`);
		for (const violation of result.violations) {
			lines.push(`     • ${violation.rule}: ${violation.detail}`);
		}
	}
	return lines.join("\n");
}

async function resolveNewestRelease(releasesDir: string): Promise<string> {
	const files = await fs.readdir(releasesDir);
	const vsixFiles = files
		.filter(file => file.endsWith(".vsix"))
		.sort(compareReleaseFileNames);
	const [newest] = vsixFiles;
	if (!newest) {
		throw new Error(`No .vsix files found in ${releasesDir}`);
	}
	return path.join(releasesDir, newest);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const vsixFlagIndex = args.indexOf("--vsix");
	const vsixPath =
		vsixFlagIndex !== -1 && args[vsixFlagIndex + 1]
			? (args[vsixFlagIndex + 1] as string)
			: await resolveNewestRelease(path.join(process.cwd(), "releases"));

	const result = await gateVsix(vsixPath);
	console.log(formatGateReport(result));

	// CCSTD-03 (PAR-82): the package must keep a valid Workspace Trust posture
	// (untrustedWorkspaces capability + every subprocess-spawning setting
	// trust-restricted). Validated against the repo manifest so a regression
	// fails the build alongside the content/size budget.
	const manifestPath = path.join(process.cwd(), "package.json");
	const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
	const trustViolations = evaluateWorkspaceTrustManifest(manifest);
	if (trustViolations.length > 0) {
		console.log("Workspace Trust gate (CCSTD-03):");
		for (const violation of trustViolations) {
			console.log(`     • ${violation.rule}: ${violation.detail}`);
		}
	} else {
		console.log("Workspace Trust gate (CCSTD-03): ✅ posture valid");
	}

	process.exit(result.ok && trustViolations.length === 0 ? 0 : 1);
}
