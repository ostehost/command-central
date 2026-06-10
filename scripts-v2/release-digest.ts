#!/usr/bin/env bun
/**
 * release-digest.ts — Generate a partnership-facing release digest
 *
 * Reads CHANGELOG.md, extracts the target version section, and formats it as
 * a concise summary suitable for Discord/chat delivery. Because preview cuts
 * do not add CHANGELOG sections, the changelog body alone goes stale between
 * RCs — so the digest also appends a deterministic "Since previous prerelease
 * cut" section derived from local git history: commits after the most recent
 * `chore(release): cut rcNN preview` commit that is not the current version,
 * with release-process noise filtered out. No network, no LLM — git only.
 * If git history is unavailable (shallow clone, no cut commits), the section
 * is omitted and the changelog digest still renders.
 *
 * Pure module API is exported for testing; the CLI is invoked only when
 * `import.meta.main` is true.
 *
 * Usage:
 *   bun run scripts-v2/release-digest.ts [--version v0.6.0-rc.52] [--format discord|markdown|plain]
 *
 * Output: formatted digest to stdout
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type ChangelogSection = { version: string; content: string };
export type CommitRef = { hash: string; subject: string };
export type SinceSection = {
	baseLabel: string;
	commits: CommitRef[];
	omitted: number;
};

/** Commit subjects that are release-process bookkeeping, not partner-facing changes. */
export const RELEASE_NOISE_PATTERNS: readonly RegExp[] = [
	/^chore\(release\):/,
	/^docs\(research\):/,
];

export const MAX_SINCE_ITEMS = 12;

const CUT_SUBJECT_GREP = "^chore(release): cut ";

// --- Changelog parsing ---

export function parseChangelogSections(changelog: string): ChangelogSection[] {
	const versionRegex = /^## \[([^\]]+)\]/gm;
	const raw: { version: string; start: number }[] = [];
	let match: RegExpExecArray | null;
	while ((match = versionRegex.exec(changelog)) !== null) {
		raw.push({ version: match[1] ?? "", start: match.index });
	}
	return raw.map((section, i) => {
		const next = raw[i + 1];
		return {
			version: section.version,
			content: changelog
				.slice(section.start, next ? next.start : changelog.length)
				.trim(),
		};
	});
}

export function parseSection(content: string): Map<string, string[]> {
	const categories = new Map<string, string[]>();
	let currentCategory = "";

	for (const line of content.split("\n")) {
		const categoryMatch = line.match(/^### (.+)/);
		if (categoryMatch) {
			currentCategory = categoryMatch[1] ?? "";
			categories.set(currentCategory, []);
			continue;
		}

		const itemMatch = line.match(/^- \*\*(.+?)\*\*\s*[—–-]\s*(.+)/);
		if (itemMatch && currentCategory) {
			const items = categories.get(currentCategory) ?? [];
			items.push(`**${itemMatch[1]}** — ${itemMatch[2]}`);
			categories.set(currentCategory, items);
		}
	}

	return categories;
}

// --- "Since previous prerelease cut" derivation ---

/** Extract an rc number from a version string or cut-commit subject ("0.6.0-rc.52", "cut rc52 preview"). */
export function rcNumber(text: string): number | null {
	const match = text.match(/\brc\.?(\d+)\b/);
	return match ? Number(match[1]) : null;
}

/**
 * Pick the cut commit that marks the previous prerelease: the most recent cut
 * whose rc number differs from the current version. At cut time the current
 * version's cut commit does not exist yet; after the cut it does — skipping
 * same-rc cuts makes the derivation identical in both cases.
 */
export function resolvePreviousCutBase(
	cuts: CommitRef[],
	currentVersion: string,
): CommitRef | null {
	const currentRc = rcNumber(currentVersion);
	for (const cut of cuts) {
		const cutRc = rcNumber(cut.subject);
		if (currentRc === null || cutRc === null || cutRc !== currentRc) {
			return cut;
		}
	}
	return null;
}

export function filterReleaseNoise(commits: CommitRef[]): CommitRef[] {
	return commits.filter(
		(c) => !RELEASE_NOISE_PATTERNS.some((pattern) => pattern.test(c.subject)),
	);
}

function gitLog(repoRoot: string, args: string[]): CommitRef[] {
	const out = execFileSync("git", ["log", ...args], {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	if (!out) return [];
	return out.split("\n").map((line) => {
		const tab = line.indexOf("\t");
		return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
	});
}

/**
 * Gather the commits since the previous prerelease cut from local git
 * history. Returns null when the section cannot be derived (not a git repo,
 * git missing, shallow history, no prior cut commits) — callers omit the
 * section rather than fail, since the digest is best-effort by design.
 */
export function collectSinceSection(
	repoRoot: string,
	currentVersion: string,
): SinceSection | null {
	try {
		const cuts = gitLog(repoRoot, [
			`--grep=${CUT_SUBJECT_GREP}`,
			"-n",
			"10",
			"--format=%H%x09%s",
		]);
		const base = resolvePreviousCutBase(cuts, currentVersion);
		if (!base) return null;

		const since = gitLog(repoRoot, ["--format=%h%x09%s", `${base.hash}..HEAD`]);
		const filtered = filterReleaseNoise(since);
		const baseRc = rcNumber(base.subject);
		return {
			baseLabel: baseRc !== null ? `rc${baseRc}` : "previous prerelease",
			commits: filtered.slice(0, MAX_SINCE_ITEMS),
			omitted: Math.max(0, filtered.length - MAX_SINCE_ITEMS),
		};
	} catch {
		return null;
	}
}

// --- Formatting ---

function sinceBullets(since: SinceSection): string[] {
	if (since.commits.length === 0) {
		return [
			`No functional commits since the ${since.baseLabel} cut (release-process commits only)`,
		];
	}
	const bullets = since.commits.map((c) => `\`${c.hash}\` ${c.subject}`);
	if (since.omitted > 0) {
		bullets.push(`… and ${since.omitted} more`);
	}
	return bullets;
}

export function formatDiscord(
	categories: Map<string, string[]>,
	currentVersion: string,
	since: SinceSection | null,
): string {
	const lines: string[] = [];
	lines.push(`## 🚀 Command Central ${currentVersion}`);
	lines.push("");

	const emojiMap: Record<string, string> = {
		Added: "✨",
		Changed: "⚡",
		Fixed: "🔧",
		Removed: "🗑️",
		Deprecated: "⚠️",
		Security: "🔒",
	};

	for (const [category, items] of categories) {
		const emoji = emojiMap[category] ?? "📋";
		lines.push(`${emoji} **${category}**`);
		for (const item of items) {
			lines.push(`  • ${item}`);
		}
		lines.push("");
	}

	if (since) {
		lines.push(`📦 **Since previous prerelease cut (${since.baseLabel})**`);
		for (const bullet of sinceBullets(since)) {
			lines.push(`  • ${bullet}`);
		}
		lines.push("");
	}

	// Add a highlight if there are performance items
	const allItems = [...categories.values()].flat().join(" ").toLowerCase();
	if (
		allItems.includes("faster") ||
		allItems.includes("performance") ||
		allItems.includes("optimiz")
	) {
		lines.push("⚡ *Performance improvements in this release*");
		lines.push("");
	}

	return lines.join("\n").trim();
}

export function formatMarkdown(
	sectionContent: string,
	since: SinceSection | null,
): string {
	if (!since) return sectionContent;
	const lines = [
		sectionContent,
		"",
		`### Since previous prerelease cut (${since.baseLabel})`,
		"",
	];
	for (const bullet of sinceBullets(since)) {
		lines.push(`- ${bullet}`);
	}
	return lines.join("\n");
}

export function formatPlain(
	categories: Map<string, string[]>,
	currentVersion: string,
	since: SinceSection | null,
): string {
	const lines: string[] = [];
	lines.push(`Command Central ${currentVersion}`);
	lines.push("=".repeat(40));

	for (const [category, items] of categories) {
		lines.push(`\n${category}:`);
		for (const item of items) {
			lines.push(`  - ${item.replace(/\*\*/g, "")}`);
		}
	}

	if (since) {
		lines.push(`\nSince previous prerelease cut (${since.baseLabel}):`);
		for (const bullet of sinceBullets(since)) {
			lines.push(`  - ${bullet.replace(/`/g, "")}`);
		}
	}

	return lines.join("\n").trim();
}

// --- CLI ---

function main(): void {
	const args = process.argv.slice(2);
	const versionArg =
		args.find((a) => a.startsWith("--version="))?.split("=")[1] ??
		(args.includes("--version") ? args[args.indexOf("--version") + 1] : undefined);
	const formatArg =
		args.find((a) => a.startsWith("--format="))?.split("=")[1] ??
		(args.includes("--format") ? args[args.indexOf("--format") + 1] : "discord");

	const projectRoot = path.resolve(import.meta.dir, "..");
	const changelogPath = path.join(projectRoot, "CHANGELOG.md");
	const packagePath = path.join(projectRoot, "package.json");

	if (!fs.existsSync(changelogPath)) {
		console.error("CHANGELOG.md not found");
		process.exit(1);
	}

	const changelog = fs.readFileSync(changelogPath, "utf-8");
	const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
	const currentVersion = `v${pkg.version}`;

	const sections = parseChangelogSections(changelog);
	const targetVersion = versionArg?.replace(/^v/, "") ?? sections[0]?.version;
	if (!targetVersion) {
		console.error("No versions found in CHANGELOG.md");
		process.exit(1);
	}

	const targetSection = sections.find((s) => s.version === targetVersion);
	if (!targetSection) {
		console.error(`Version ${targetVersion} not found in CHANGELOG.md`);
		console.error(`Available: ${sections.map((s) => s.version).join(", ")}`);
		process.exit(1);
	}

	// The git-derived section describes HEAD relative to the previous cut, so
	// it only makes sense when digesting the current version — skip it when
	// regenerating a digest for an older --version target.
	const includeSince = !versionArg || versionArg.replace(/^v/, "") === pkg.version;
	const since = includeSince
		? collectSinceSection(projectRoot, pkg.version)
		: null;

	const categories = parseSection(targetSection.content);

	switch (formatArg) {
		case "discord":
			console.log(formatDiscord(categories, currentVersion, since));
			break;
		case "markdown":
			console.log(formatMarkdown(targetSection.content, since));
			break;
		case "plain":
			console.log(formatPlain(categories, currentVersion, since));
			break;
		default:
			console.error(`Unknown format: ${formatArg}`);
			process.exit(1);
	}
}

if (import.meta.main) {
	main();
}
