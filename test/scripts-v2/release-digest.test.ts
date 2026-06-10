import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CommitRef,
	collectSinceSection,
	filterReleaseNoise,
	formatDiscord,
	formatMarkdown,
	formatPlain,
	MAX_SINCE_ITEMS,
	parseChangelogSections,
	parseSection,
	rcNumber,
	resolvePreviousCutBase,
} from "../../scripts-v2/release-digest.ts";

const CLI_PATH = path.resolve(
	import.meta.dir,
	"..",
	"..",
	"scripts-v2",
	"release-digest.ts",
);

const SAMPLE_CHANGELOG = `# Changelog

Intro prose.

## [0.6.0-rc.23] - 2026-05-09

### Added
- **Installed VSIX proof harness** — Added a node-only proof path.

### Fixed
- **Review queue continuation gaps** — Completed runs now surface as gaps.

## [0.6.0-rc.14] - 2026-04-30

### Fixed
- **Codex Runs identity joins** — Launcher metadata joins by explicit ids only.
`;

function commit(ref: { hash: string; subject: string }): CommitRef {
	return ref;
}

describe("rcNumber", () => {
	test("extracts rc number from package versions", () => {
		expect(rcNumber("0.6.0-rc.52")).toBe(52);
	});

	test("extracts rc number from cut commit subjects", () => {
		expect(rcNumber("chore(release): cut rc51 preview")).toBe(51);
	});

	test("returns null for non-rc text", () => {
		expect(rcNumber("0.6.0")).toBeNull();
		expect(rcNumber("fix: something unrelated")).toBeNull();
	});
});

describe("parseChangelogSections", () => {
	test("splits sections by version heading", () => {
		const sections = parseChangelogSections(SAMPLE_CHANGELOG);
		expect(sections.map((s) => s.version)).toEqual([
			"0.6.0-rc.23",
			"0.6.0-rc.14",
		]);
		expect(sections[0]?.content).toContain("Installed VSIX proof harness");
		expect(sections[0]?.content).not.toContain("Codex Runs identity joins");
		expect(sections[1]?.content).toContain("Codex Runs identity joins");
	});

	test("returns empty array when no versions exist", () => {
		expect(parseChangelogSections("# Changelog\n\nnothing here")).toEqual([]);
	});
});

describe("parseSection", () => {
	test("groups items under their category", () => {
		const sections = parseChangelogSections(SAMPLE_CHANGELOG);
		const categories = parseSection(sections[0]?.content ?? "");
		expect([...categories.keys()]).toEqual(["Added", "Fixed"]);
		expect(categories.get("Added")?.[0]).toContain(
			"Installed VSIX proof harness",
		);
	});
});

describe("resolvePreviousCutBase", () => {
	const rc52 = commit({
		hash: "aaa",
		subject: "chore(release): cut rc52 preview",
	});
	const rc51 = commit({
		hash: "bbb",
		subject: "chore(release): cut rc51 preview",
	});

	test("skips the current version's own cut commit", () => {
		expect(resolvePreviousCutBase([rc52, rc51], "0.6.0-rc.52")).toBe(rc51);
	});

	test("uses the most recent cut when it is a different rc", () => {
		expect(resolvePreviousCutBase([rc51], "0.6.0-rc.52")).toBe(rc51);
	});

	test("returns null when no cut commits exist", () => {
		expect(resolvePreviousCutBase([], "0.6.0-rc.52")).toBeNull();
	});

	test("uses the most recent cut for non-rc versions", () => {
		expect(resolvePreviousCutBase([rc52, rc51], "0.6.0")).toBe(rc52);
	});
});

describe("filterReleaseNoise", () => {
	test("drops release-process commits and keeps functional ones", () => {
		const commits = [
			commit({ hash: "1", subject: "chore(release): cut rc52 preview" }),
			commit({
				hash: "2",
				subject: "docs(research): add rc51 preview cut receipt",
			}),
			commit({
				hash: "3",
				subject:
					"fix(sync-launcher): bundle applescript lib helpers (window-probe)",
			}),
			commit({ hash: "4", subject: "feat(tree): add agent grouping" }),
		];
		expect(filterReleaseNoise(commits).map((c) => c.hash)).toEqual(["3", "4"]);
	});
});

describe("format output with since-section", () => {
	const categories = new Map([["Fixed", ["**Thing** — got fixed"]]]);
	const since = {
		baseLabel: "rc51",
		commits: [
			commit({
				hash: "ebdb738",
				subject:
					"fix(sync-launcher): bundle applescript lib helpers (window-probe)",
			}),
		],
		omitted: 0,
	};

	test("discord format renders the since-section with hash and subject", () => {
		const out = formatDiscord(categories, "v0.6.0-rc.52", since);
		expect(out).toContain("## 🚀 Command Central v0.6.0-rc.52");
		expect(out).toContain("📦 **Since previous prerelease cut (rc51)**");
		expect(out).toContain(
			"`ebdb738` fix(sync-launcher): bundle applescript lib helpers (window-probe)",
		);
	});

	test("discord format omits the section when since is null", () => {
		const out = formatDiscord(categories, "v0.6.0-rc.52", null);
		expect(out).not.toContain("Since previous prerelease cut");
	});

	test("empty commit list renders an explicit no-functional-changes line", () => {
		const out = formatDiscord(categories, "v0.6.0-rc.53", {
			baseLabel: "rc52",
			commits: [],
			omitted: 0,
		});
		expect(out).toContain(
			"No functional commits since the rc52 cut (release-process commits only)",
		);
	});

	test("overflow beyond the cap is summarized", () => {
		const out = formatDiscord(categories, "v0.6.0-rc.53", {
			baseLabel: "rc52",
			commits: Array.from({ length: MAX_SINCE_ITEMS }, (_, i) =>
				commit({ hash: `h${i}`, subject: `fix: change ${i}` }),
			),
			omitted: 3,
		});
		expect(out).toContain("… and 3 more");
	});

	test("markdown format appends the since-section", () => {
		const out = formatMarkdown(
			"## [0.6.0-rc.23]\n\n### Fixed\n- **X** — y",
			since,
		);
		expect(out).toContain("### Since previous prerelease cut (rc51)");
		expect(out).toContain("- `ebdb738` fix(sync-launcher):");
	});

	test("plain format strips markdown from the since-section", () => {
		const out = formatPlain(categories, "v0.6.0-rc.52", since);
		expect(out).toContain("Since previous prerelease cut (rc51):");
		expect(out).toContain("  - ebdb738 fix(sync-launcher):");
		expect(out).not.toContain("`");
	});
});

describe("collectSinceSection (temp git repo)", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	async function makeRepo(): Promise<string> {
		const dir = await fs.mkdtemp(
			path.join(os.tmpdir(), "release-digest-test-"),
		);
		tempDirs.push(dir);
		git(dir, "init", "-q", "-b", "main");
		return dir;
	}

	function git(dir: string, ...args: string[]): void {
		execFileSync(
			"git",
			[
				"-c",
				"user.name=test",
				"-c",
				"user.email=test@example.com",
				"-c",
				"commit.gpgsign=false",
				...args,
			],
			{ cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
	}

	function emptyCommit(dir: string, subject: string): void {
		git(dir, "commit", "--allow-empty", "-q", "-m", subject);
	}

	test("surfaces functional commits since the previous cut", async () => {
		const dir = await makeRepo();
		emptyCommit(dir, "chore(release): cut rc1 preview");
		emptyCommit(dir, "docs(research): add rc1 preview cut receipt");
		emptyCommit(
			dir,
			"fix(sync-launcher): bundle applescript lib helpers (window-probe)",
		);

		const since = collectSinceSection(dir, "0.0.1-rc.2");
		expect(since).not.toBeNull();
		expect(since?.baseLabel).toBe("rc1");
		expect(since?.commits.map((c) => c.subject)).toEqual([
			"fix(sync-launcher): bundle applescript lib helpers (window-probe)",
		]);
		expect(since?.omitted).toBe(0);
	});

	test("is identical before and after the current version's cut commit", async () => {
		const dir = await makeRepo();
		emptyCommit(dir, "chore(release): cut rc1 preview");
		emptyCommit(
			dir,
			"fix(sync-launcher): bundle applescript lib helpers (window-probe)",
		);
		const preCut = collectSinceSection(dir, "0.0.1-rc.2");

		emptyCommit(dir, "chore(release): cut rc2 preview");
		emptyCommit(dir, "docs(research): add rc2 preview cut receipt");
		const postCut = collectSinceSection(dir, "0.0.1-rc.2");

		expect(preCut?.commits.map((c) => c.subject)).toEqual([
			"fix(sync-launcher): bundle applescript lib helpers (window-probe)",
		]);
		expect(postCut?.commits.map((c) => c.subject)).toEqual(
			preCut?.commits.map((c) => c.subject) ?? [],
		);
		expect(postCut?.baseLabel).toBe("rc1");
	});

	test("reports no functional commits when only release-process commits landed", async () => {
		const dir = await makeRepo();
		emptyCommit(dir, "chore(release): cut rc1 preview");
		emptyCommit(dir, "chore(release): cut rc2 preview");
		emptyCommit(dir, "docs(research): add rc2 preview cut receipt");

		const since = collectSinceSection(dir, "0.0.1-rc.3");
		expect(since).not.toBeNull();
		expect(since?.baseLabel).toBe("rc2");
		expect(since?.commits).toEqual([]);
	});

	test("returns null when no cut commits exist", async () => {
		const dir = await makeRepo();
		emptyCommit(dir, "feat: initial");
		expect(collectSinceSection(dir, "0.0.1-rc.1")).toBeNull();
	});

	test("returns null outside a git repository", async () => {
		const dir = await fs.mkdtemp(
			path.join(os.tmpdir(), "release-digest-nogit-"),
		);
		tempDirs.push(dir);
		expect(collectSinceSection(dir, "0.0.1-rc.1")).toBeNull();
	});
});

describe("CLI smoke", () => {
	test("renders a discord digest for the current repo", () => {
		const stdout = execFileSync(
			"bun",
			["run", CLI_PATH, "--format", "discord"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		expect(stdout).toContain("## 🚀 Command Central v");
	});
});
