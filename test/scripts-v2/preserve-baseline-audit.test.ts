import { describe, expect, test } from "bun:test";
import {
	buildReceipt,
	classifyPorcelain,
	detectCredentialInRemote,
	parseBranchHeader,
	parseIgnoredFiles,
	parseRemotes,
	parseStashCount,
	redactRemoteUrl,
	summarizeDirty,
} from "../../scripts-v2/preserve-baseline-audit.ts";

// `git status --porcelain=v1 -z` records are NUL-terminated: "XY <path>\0".
function porcelainZ(entries: string[]): string {
	return entries.map((entry) => `${entry}\0`).join("");
}

describe("classifyPorcelain (CCSTD-01 staged/unstaged/untracked)", () => {
	test("separates staged-only, unstaged, and untracked", () => {
		const out = porcelainZ([
			"M  staged-only.ts", // index modified, worktree clean
			" M unstaged.ts", // worktree modified, not staged
			"?? untracked.ts", // brand new file
		]);
		const result = classifyPorcelain(out);
		expect(result.stagedOnly).toEqual(["staged-only.ts"]);
		expect(result.unstaged).toEqual(["unstaged.ts"]);
		expect(result.untracked).toEqual(["untracked.ts"]);
	});

	test("a file staged AND further modified is NOT counted as staged-only", () => {
		// "MM" = index modified + worktree modified. A `reset` would surface the
		// worktree delta, so it belongs to unstaged, never staged-only.
		const result = classifyPorcelain(porcelainZ(["MM both.ts"]));
		expect(result.unstaged).toEqual(["both.ts"]);
		expect(result.stagedOnly).toEqual([]);
	});

	test("handles paths containing spaces (NUL-delimited)", () => {
		const result = classifyPorcelain(porcelainZ([" M dir/a file.ts"]));
		expect(result.unstaged).toEqual(["dir/a file.ts"]);
	});

	test("empty status is fully clean", () => {
		const result = classifyPorcelain("");
		expect(result).toEqual({ stagedOnly: [], unstaged: [], untracked: [] });
	});
});

describe("parseIgnoredFiles (CCSTD-01 ignored-only / clean -fdx bait)", () => {
	test("parses NUL-separated ignored paths and drops the trailing empty", () => {
		const out = "node_modules/\0.env\0dist/bundle.js\0";
		expect(parseIgnoredFiles(out)).toEqual([
			"node_modules/",
			".env",
			"dist/bundle.js",
		]);
	});

	test("no ignored files yields an empty list", () => {
		expect(parseIgnoredFiles("")).toEqual([]);
	});
});

describe("parseStashCount (CCSTD-01 stash-count)", () => {
	test("counts non-empty stash entries", () => {
		const out = "stash@{0}: WIP on main: abc123 foo\nstash@{1}: On main: bar\n";
		expect(parseStashCount(out)).toBe(2);
	});

	test("empty stash is zero", () => {
		expect(parseStashCount("")).toBe(0);
	});
});

describe("parseRemotes (CCSTD-01 remotes)", () => {
	test("de-duplicates fetch/push lines into one entry per remote", () => {
		const out = [
			"origin\thttps://github.com/o/cc.git (fetch)",
			"origin\thttps://github.com/o/cc.git (push)",
		].join("\n");
		expect(parseRemotes(out)).toEqual([
			{ name: "origin", url: "https://github.com/o/cc.git" },
		]);
	});

	test("records a distinct push URL when it differs from fetch", () => {
		const out = [
			"origin\thttps://github.com/o/cc.git (fetch)",
			"origin\tgit@github.com:o/cc.git (push)",
		].join("\n");
		const remotes = parseRemotes(out);
		expect(remotes).toContainEqual({
			name: "origin",
			url: "https://github.com/o/cc.git",
		});
		expect(remotes).toContainEqual({
			name: "origin (push)",
			url: "git@github.com:o/cc.git",
		});
	});

	test("no remotes yields an empty list", () => {
		expect(parseRemotes("")).toEqual([]);
	});
});

describe("redactRemoteUrl + detectCredentialInRemote (CCSTD-01 credential-in-remote)", () => {
	test("flags a token embedded in the remote URL and redacts the secret", () => {
		const remotes = [
			{
				name: "origin",
				url: "https://mike:TEST_TOKEN_SECRET_123@github.com/o/cc.git",
			},
		];
		const findings = detectCredentialInRemote(remotes);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.remote).toBe("origin");
		expect(findings[0]?.redactedUrl).toBe(
			"https://mike:***@github.com/o/cc.git",
		);
		// The secret must NEVER appear in the finding.
		expect(findings[0]?.redactedUrl).not.toContain("TEST_TOKEN_SECRET_123");
	});

	test("flags a token-as-username remote (no colon) and redacts the whole token", () => {
		const remotes = [
			{
				name: "origin",
				url: "https://TEST_TOKEN_SECRET_123@github.com/o/cc.git",
			},
		];
		const findings = detectCredentialInRemote(remotes);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.redactedUrl).toBe("https://***@github.com/o/cc.git");
		expect(findings[0]?.redactedUrl).not.toContain("TEST_TOKEN_SECRET_123");
		expect(
			redactRemoteUrl("https://TEST_TOKEN_SECRET_123@github.com/o/cc.git"),
		).not.toContain("TEST_TOKEN_SECRET_123");
	});

	test("redacts the full password even when it contains an '@'", () => {
		const url = "https://mike:p@ss:word@github.com/o/cc.git";
		const redacted = redactRemoteUrl(url);
		expect(redacted).toBe("https://mike:***@github.com/o/cc.git");
		// No fragment of the password may survive.
		expect(redacted).not.toContain("p@ss");
		expect(redacted).not.toContain("word");
	});

	test("does NOT flag a bare ssh-scheme identity (ssh://git@host)", () => {
		const remotes = [{ name: "node", url: "ssh://git@github.com/o/cc.git" }];
		expect(detectCredentialInRemote(remotes)).toEqual([]);
		expect(redactRemoteUrl("ssh://git@github.com/o/cc.git")).toBe(
			"ssh://git@github.com/o/cc.git",
		);
	});

	test("redacts a token on an https-transport scheme git accepts (git+https://)", () => {
		// `git+https://`/`gitlab://`/`sshx://` are NOT ssh transports — a bare
		// token-as-username on them is a secret and must be redacted+flagged.
		// (Regression guard: a `startsWith("git"|"ssh")` prefix check leaks these.)
		for (const url of [
			"git+https://TEST_TOKEN_SECRET_123@github.com/o/cc.git",
			"git+http://TEST_TOKEN_SECRET_123@host/cc.git",
			"gitlab://TEST_TOKEN_SECRET_123@host/cc.git",
			"sshx://TEST_TOKEN_SECRET_123@host/cc.git",
		]) {
			const redacted = redactRemoteUrl(url);
			expect(redacted).not.toContain("TEST_TOKEN_SECRET_123");
			expect(redacted).toContain("***@");
			const findings = detectCredentialInRemote([{ name: "origin", url }]);
			expect(findings).toHaveLength(1);
			expect(JSON.stringify(findings)).not.toContain("TEST_TOKEN_SECRET_123");
		}
	});

	test("does NOT flag a genuine ssh-transport scheme (git+ssh / ssh+git)", () => {
		for (const url of [
			"git+ssh://git@github.com/o/cc.git",
			"ssh+git://git@github.com/o/cc.git",
			"git://git@github.com/o/cc.git",
		]) {
			expect(redactRemoteUrl(url)).toBe(url);
			expect(detectCredentialInRemote([{ name: "n", url }])).toEqual([]);
		}
	});

	test("leaves an empty-userinfo URL (https://@host) unchanged", () => {
		expect(redactRemoteUrl("https://@github.com/o/cc.git")).toBe(
			"https://@github.com/o/cc.git",
		);
		expect(
			detectCredentialInRemote([
				{ name: "o", url: "https://@github.com/o/cc.git" },
			]),
		).toEqual([]);
	});

	test("does NOT flag a plain https or ssh-shorthand remote", () => {
		const remotes = [
			{ name: "origin", url: "https://github.com/o/cc.git" },
			{ name: "node", url: "git@github.com:o/cc.git" },
		];
		expect(detectCredentialInRemote(remotes)).toEqual([]);
	});

	test("redactRemoteUrl leaves credential-free URLs unchanged", () => {
		expect(redactRemoteUrl("https://github.com/o/cc.git")).toBe(
			"https://github.com/o/cc.git",
		);
		expect(redactRemoteUrl("git@github.com:o/cc.git")).toBe(
			"git@github.com:o/cc.git",
		);
	});
});

describe("parseBranchHeader (CCSTD-01 divergent-or-gone upstream)", () => {
	test("parses ahead/behind against a configured upstream", () => {
		const result = parseBranchHeader(
			"## main...origin/main [ahead 2, behind 3]",
		);
		expect(result).toEqual({
			upstream: "origin/main",
			ahead: 2,
			behind: 3,
			gone: false,
		});
	});

	test("ahead-only divergence", () => {
		const result = parseBranchHeader("## main...origin/main [ahead 1]");
		expect(result.ahead).toBe(1);
		expect(result.behind).toBe(0);
		expect(result.gone).toBe(false);
	});

	test("detects a configured-but-gone upstream", () => {
		const result = parseBranchHeader("## feature...origin/feature [gone]");
		expect(result.upstream).toBe("origin/feature");
		expect(result.gone).toBe(true);
	});

	test("no upstream configured", () => {
		const result = parseBranchHeader("## main");
		expect(result).toEqual({
			upstream: null,
			ahead: 0,
			behind: 0,
			gone: false,
		});
	});
});

describe("summarizeDirty (CCSTD-01 dirty summary verdict)", () => {
	test("clean only when every category is empty", () => {
		expect(
			summarizeDirty({
				stagedOnly: [],
				unstaged: [],
				untracked: [],
				ignoredOnly: [],
				stashCount: 0,
			}).clean,
		).toBe(true);
	});

	test("a lone stash entry makes the tree non-clean", () => {
		const summary = summarizeDirty({
			stagedOnly: [],
			unstaged: [],
			untracked: [],
			ignoredOnly: [],
			stashCount: 1,
		});
		expect(summary.clean).toBe(false);
		expect(summary.stashCount).toBe(1);
	});
});

describe("buildReceipt (CCSTD-01 host-labeled receipt)", () => {
	test("assembles a full receipt and never persists a live credential", () => {
		const receipt = buildReceipt({
			generatedAt: "2026-06-23T12:00:00.000Z",
			host: "hub-host",
			user: "ostehost",
			repo: "/repo",
			head: "abc1234",
			branch: "main",
			branchHeaderLine: "## main...origin/main [behind 1]",
			porcelainZ: porcelainZ(["M  a.ts", " M b.ts", "?? c.ts"]),
			ignoredZ: "node_modules/\0",
			stashList: "stash@{0}: WIP\n",
			remoteVerbose:
				"origin\thttps://mike:TEST_TOKEN_SHORT@github.com/o/cc.git (fetch)\norigin\thttps://mike:TEST_TOKEN_SHORT@github.com/o/cc.git (push)",
		});

		expect(receipt.version).toBe(1);
		expect(receipt.host).toBe("hub-host");
		expect(receipt.user).toBe("ostehost");
		expect(receipt.head).toBe("abc1234");
		expect(receipt.branch).toBe("main");
		expect(receipt.upstream).toEqual({
			upstream: "origin/main",
			ahead: 0,
			behind: 1,
			gone: false,
		});
		expect(receipt.stagedOnly).toEqual(["a.ts"]);
		expect(receipt.unstaged).toEqual(["b.ts"]);
		expect(receipt.untracked).toEqual(["c.ts"]);
		expect(receipt.ignoredOnly).toEqual(["node_modules/"]);
		expect(receipt.stashCount).toBe(1);
		expect(receipt.credentialFindings).toHaveLength(1);
		expect(receipt.preserveClean).toBe(false);

		// Persisted remotes must be redacted — no secret leaks into the receipt.
		const serialized = JSON.stringify(receipt);
		expect(serialized).not.toContain("TEST_TOKEN_SHORT");
		expect(receipt.remotes[0]?.url).toBe(
			"https://mike:***@github.com/o/cc.git",
		);
	});

	test("preserveClean is true for a pristine repo", () => {
		const receipt = buildReceipt({
			generatedAt: "2026-06-23T12:00:00.000Z",
			host: "node-host",
			user: "ostenode",
			repo: "/repo",
			head: "deadbee",
			branch: "main",
			branchHeaderLine: "## main...origin/main",
			porcelainZ: "",
			ignoredZ: "",
			stashList: "",
			remoteVerbose: "origin\tgit@github.com:o/cc.git (fetch)",
		});
		expect(receipt.preserveClean).toBe(true);
		expect(receipt.credentialFindings).toEqual([]);
		expect(receipt.dirtySummary.clean).toBe(true);
	});
});
