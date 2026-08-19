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
 * is omitted and the changelog digest still renders. Stable (non-rc) versions
 * also omit the section: without an rc number the current version's own cut
 * commit cannot be recognized, so no base is safe to pick — and a stable cut
 * gets a full changelog section, so nothing is lost.
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
export type GateCheckEvidence = { label: string; status: string };
export type GateEvidence = {
	generatedAt: string;
	success: boolean;
	checks: GateCheckEvidence[];
};

/** Commit subjects that are release-process bookkeeping, not partner-facing changes. */
export const RELEASE_NOISE_PATTERNS: readonly RegExp[] = [
	/^chore\(release\):/,
	/^docs\(research\):/,
];

export const MAX_SINCE_ITEMS = 12;

/** Literal subject prefix of release-cut commits ("chore(release): cut rc52 preview"). */
export const CUT_SUBJECT_PREFIX = "chore(release): cut ";

/** Coarse pre-filter prefix: every release-boundary subject starts with this. */
export const RELEASE_SUBJECT_PREFIX = "chore(release): ";

/**
 * Authoritative cut-commit check.
 *
 * `git log --grep` matches body lines too, so grep results are only a coarse
 * pre-filter — a commit that merely mentions a cut in its body must not be
 * selected as the base.
 *
 * Recognizing ONLY `CUT_SUBJECT_PREFIX` silently broke the "since previous
 * cut" range: cuts have also been recorded as "chore(release): record the
 * rc.88 and rc.89 cuts" and "chore(release): sync launcher and record the
 * rc.87 cut". No such subject matched, so no boundary was found after rc.85
 * and every digest from rc.86 through rc.90 re-listed the same growing range
 * under the heading "Since previous prerelease cut (rc85)". A commit that
 * records a cut marks the release boundary just as firmly as one that performs
 * it, so both forms count — but only when the subject actually names an rc,
 * which is what makes it a boundary rather than release chatter.
 */
export function isCutCommit(subject: string): boolean {
	if (subject.startsWith(CUT_SUBJECT_PREFIX)) return true;
	// "record" is required, not just "cut". Matching any release subject that
	// merely mentions a cut and an rc would accept chatter like
	// "chore(release): refresh the rc71 digest after the cut" — this history
	// already contains near-misses of that shape. A false boundary is worse
	// than a missed one: it silently TRUNCATES the next digest's range, where a
	// miss produces a visibly over-wide range instead.
	return (
		subject.startsWith(RELEASE_SUBJECT_PREFIX) &&
		/\bcuts?\b/.test(subject) &&
		/\brecord(?:ed|ing|s)?\b/.test(subject) &&
		rcNumber(subject) !== null
	);
}

// --- Changelog parsing ---

/**
 * Pick the CHANGELOG section a digest may quote as its body.
 *
 * The body must describe the version in the heading or not exist at all. This
 * used to fall back to `sections[0]` — the newest CHANGELOG entry — whenever
 * the current version had no section of its own. Preview cuts deliberately
 * never touch CHANGELOG (the digest is the record; CHANGELOG is curated for
 * stable GA), so that fallback fired on every preview: rc.87 through rc.90 all
 * published rc.81's release notes under their own heading.
 *
 * Returning null is the correct answer for a preview. The digest still carries
 * the git-derived "Since previous cut" list and the gate evidence, which are
 * the parts that actually describe that cut.
 */
export function selectChangelogSection(
	sections: ChangelogSection[],
	explicitTarget: string | undefined,
	pkgVersion: string,
): ChangelogSection | null {
	const target = explicitTarget ?? pkgVersion;
	return sections.find((section) => section.version === target) ?? null;
}

/**
 * Whether an omitted changelog body deserves a warning.
 *
 * A preview cut legitimately has no CHANGELOG section — CHANGELOG is curated
 * for stable GA — so warning there would fire on every cut and train the
 * operator to ignore it. A STABLE version with no section is the real problem:
 * its digest would render with no release notes at all, and before the body
 * was resolved strictly by version it silently published some other release's
 * notes instead. Neither is acceptable quietly.
 */
export function shouldWarnMissingChangelogSection(
	pkgVersion: string,
	hasSection: boolean,
	explicitTarget?: string,
): boolean {
	if (hasSection) return false;
	// An explicit --version miss is already a hard error in the CLI.
	if (explicitTarget) return false;
	return rcNumber(pkgVersion) === null;
}

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
	// Highest, not first: a single commit can record more than one cut
	// ("record the rc.88 and rc.89 cuts"), and the boundary it marks is the
	// LAST cut it recorded. Taking the first match would resolve that commit to
	// rc.88 and make the next digest re-list rc.89's commits. Version strings
	// carry exactly one rc, so they are unaffected.
	const matches = [...text.matchAll(/\brc\.?(\d+)\b/g)].map((m) =>
		Number(m[1]),
	);
	return matches.length > 0 ? Math.max(...matches) : null;
}

/**
 * Pick the cut commit that marks the previous prerelease: the most recent cut
 * whose rc number differs from the current version. At cut time the current
 * version's cut commit does not exist yet; after the cut it does — skipping
 * same-rc cuts makes the derivation identical in both cases.
 *
 * Non-rc (stable) versions return null. Without an rc number there is no way
 * to recognize the current version's own cut commit, so after a stable cut the
 * most recent cut could be the stable cut itself and the section would
 * silently describe an empty or wrong range. Stable cuts get a full changelog
 * section, so the git-derived section is omitted rather than risk a bad base.
 */
export function resolvePreviousCutBase(
	cuts: CommitRef[],
	currentVersion: string,
): CommitRef | null {
	const currentRc = rcNumber(currentVersion);
	if (currentRc === null) return null;
	for (const cut of cuts) {
		if (rcNumber(cut.subject) !== currentRc) {
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
		// --fixed-strings pins the matching semantics regardless of any
		// grep.patternType config (the default-BRE anchored pattern silently
		// matches nothing under extended/perl). The grep is only a coarse
		// pre-filter — it also matches body lines — so isCutCommit() on the
		// subject is the authoritative check, and -n 50 keeps body-only false
		// positives from crowding the real cut out of the candidate window.
		const cuts = gitLog(repoRoot, [
			"--fixed-strings",
			// Pre-filter on the broader release prefix: grepping the narrow cut
			// prefix kept every record-style boundary commit out of the candidate
			// window entirely, so isCutCommit never got the chance to match one.
			`--grep=${RELEASE_SUBJECT_PREFIX}`,
			"-n",
			"50",
			"--format=%H%x09%s",
		]).filter((c) => isCutCommit(c.subject));
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

// --- CCREL-05 release-gate evidence ---

/**
 * Gate check names whose status is partnership-relevant CCREL-05 evidence:
 * daemon smoke, node readiness, hub repo parity, launcher contract/sync.
 * The base-validation checks ("command-central validation", launcher cli sanity)
 * are deliberately excluded — they are gate plumbing, not the integrated-parity
 * signals CCREL-05 asks the digest to record.
 */
export const GATE_EVIDENCE_LABELS: ReadonlyMap<string, string> = new Map([
	["openclaw daemon smoke", "Daemon smoke"],
	["openclaw node readiness", "Node readiness"],
	["hub repo parity", "Hub repo parity"],
	["cross-repo launcher contract", "Launcher contract / sync"],
]);

const STATUS_EMOJI: Record<string, string> = {
	passed: "✅",
	failed: "❌",
	skipped: "⏭️",
};

/**
 * Read the latest prerelease-gate artifact and project it down to the CCREL-05
 * evidence checks. Best-effort by design (mirrors collectSinceSection): a
 * missing or malformed artifact yields null and the digest omits the section
 * rather than failing. The artifact path is the durable `latest.json` the gate
 * always writes alongside the dated copy.
 */
export function collectGateEvidence(repoRoot: string): GateEvidence | null {
	const artifactPath = path.join(
		repoRoot,
		"research",
		"prerelease-gate",
		"latest.json",
	);
	try {
		const parsed = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
			generatedAt?: unknown;
			success?: unknown;
			checks?: unknown;
		};
		if (!Array.isArray(parsed.checks)) return null;
		const checks: GateCheckEvidence[] = [];
		for (const raw of parsed.checks) {
			if (typeof raw !== "object" || raw === null) continue;
			const record = raw as { name?: unknown; status?: unknown };
			if (typeof record.name !== "string") continue;
			const label = GATE_EVIDENCE_LABELS.get(record.name);
			if (!label) continue;
			checks.push({
				label,
				status: typeof record.status === "string" ? record.status : "unknown",
			});
		}
		if (checks.length === 0) return null;
		return {
			generatedAt:
				typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
			success: parsed.success === true,
			checks,
		};
	} catch {
		return null;
	}
}

function gateEvidenceBullets(evidence: GateEvidence): string[] {
	return evidence.checks.map((check) => {
		const emoji = STATUS_EMOJI[check.status] ?? "•";
		return `${emoji} ${check.label}: ${check.status}`;
	});
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
	gate: GateEvidence | null = null,
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

	if (gate) {
		lines.push("🛡️ **Release gate evidence**");
		for (const bullet of gateEvidenceBullets(gate)) {
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
	gate: GateEvidence | null = null,
): string {
	if (!since && !gate) return sectionContent;
	const lines = [sectionContent];
	if (since) {
		lines.push(
			"",
			`### Since previous prerelease cut (${since.baseLabel})`,
			"",
		);
		for (const bullet of sinceBullets(since)) {
			lines.push(`- ${bullet}`);
		}
	}
	if (gate) {
		lines.push("", "### Release gate evidence", "");
		for (const bullet of gateEvidenceBullets(gate)) {
			lines.push(`- ${bullet}`);
		}
	}
	return lines.join("\n");
}

export function formatPlain(
	categories: Map<string, string[]>,
	currentVersion: string,
	since: SinceSection | null,
	gate: GateEvidence | null = null,
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

	if (gate) {
		lines.push("\nRelease gate evidence:");
		for (const bullet of gateEvidenceBullets(gate)) {
			lines.push(`  - ${bullet}`);
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
	const explicitTarget = versionArg?.replace(/^v/, "");
	const targetSection = selectChangelogSection(
		sections,
		explicitTarget,
		pkg.version,
	);
	if (!targetSection && explicitTarget) {
		console.error(`Version ${explicitTarget} not found in CHANGELOG.md`);
		console.error(`Available: ${sections.map((s) => s.version).join(", ")}`);
		process.exit(1);
	}
	if (
		shouldWarnMissingChangelogSection(
			pkg.version,
			targetSection !== null,
			explicitTarget,
		)
	) {
		// stderr, so it never lands inside the digest artifact itself.
		console.error(
			`WARNING: CHANGELOG.md has no section for stable version ${pkg.version} — the digest will carry no release notes.`,
		);
	}

	// The git-derived section describes HEAD relative to the previous cut, so
	// it only makes sense when digesting the current version — skip it when
	// regenerating a digest for an older --version target.
	const includeSince = !versionArg || versionArg.replace(/^v/, "") === pkg.version;
	const since = includeSince
		? collectSinceSection(projectRoot, pkg.version)
		: null;

	// The gate artifact describes the latest cut (HEAD), so only attach it when
	// digesting the current version — same guard as the git-derived section.
	const gate = includeSince ? collectGateEvidence(projectRoot) : null;

	const categories = targetSection
		? parseSection(targetSection.content)
		: new Map<string, string[]>();

	switch (formatArg) {
		case "discord":
			console.log(formatDiscord(categories, currentVersion, since, gate));
			break;
		case "markdown":
			console.log(formatMarkdown(targetSection?.content ?? "", since, gate));
			break;
		case "plain":
			console.log(formatPlain(categories, currentVersion, since, gate));
			break;
		default:
			console.error(`Unknown format: ${formatArg}`);
			process.exit(1);
	}
}

if (import.meta.main) {
	main();
}
