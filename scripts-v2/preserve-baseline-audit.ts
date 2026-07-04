#!/usr/bin/env bun
/**
 * CCSTD-01 / PAR-80 — Command Central baseline preserve-before-destroy audit.
 *
 * A re-runnable, NON-MUTATING, host-labeled audit that enumerates everything a
 * destructive operation (reset --hard, clean -fdx, branch -D, force-push, repo
 * delete) would silently throw away, then emits a machine-readable receipt so
 * the discarded state can be reconstructed or consciously accepted.
 *
 * The audit reads ONLY git plumbing/porcelain in read-only mode. It never
 * stages, commits, stashes, checks out, fetches, prunes, or writes to the repo
 * under audit — the only write is the receipt under the (separate) output dir.
 * Run it before any preserve-before-destroy decision; the receipt is the proof
 * the baseline was preserved.
 *
 * Categories enumerated (per the kit's preserve-before-destroy checklist):
 *   - staged-only        files staged but with no further unstaged delta
 *   - unstaged           working-tree modifications not yet staged
 *   - untracked          new files git is not tracking
 *   - ignored-only       files present but matched by .gitignore (clean -fdx bait)
 *   - stash-count        entries in the stash that a reset would orphan
 *   - upstream divergence ahead/behind, or a configured-but-gone upstream
 *   - remotes            each remote's {scheme, host, hasCredential} — capture-less:
 *                        the credential is DETECTED but never captured, so no full
 *                        or redacted URL (and therefore no userinfo/token) is stored
 *   - credential-in-remote remotes whose userinfo embeds a token/secret, flagged by
 *                        {scheme, host} only — the URL itself never touches disk
 *
 * Pure parsing/classification is exported for unit testing; the live git I/O and
 * the CLI run only when `import.meta.main` is true.
 */

import { spawn } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// v2 (PAR-268): remotes + credential findings are capture-less — persist
// {scheme, host, hasCredential} instead of the (redacted) remote URL, so no
// userinfo/token can ever reach disk. v1 stored redactRemoteUrl(remote.url).
export const PRESERVE_BASELINE_AUDIT_SCHEMA_VERSION = 2;

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type PorcelainClassification = {
	stagedOnly: string[];
	unstaged: string[];
	untracked: string[];
};

export type UpstreamDivergence = {
	upstream: string | null;
	ahead: number;
	behind: number;
	/** Upstream is configured for the branch but no longer resolves (gone). */
	gone: boolean;
};

/** A remote as parsed from `git remote -v` — transient/in-memory; NEVER persisted. */
export type Remote = {
	name: string;
	url: string;
};

/**
 * Credential-free structured view of a remote URL, safe to persist. `scheme` and
 * `host` carry no userinfo; `hasCredential` records whether a token/secret was
 * DETECTED in the URL's userinfo — the credential itself is never captured.
 */
export type RemoteDescriptor = {
	scheme: string;
	host: string;
	hasCredential: boolean;
};

/** A named remote as persisted in the receipt: {scheme, host, hasCredential}, never a URL. */
export type RemoteIdentity = RemoteDescriptor & { name: string };

/**
 * A remote whose userinfo embeds a credential/secret. Capture-less: records only
 * the credential-free {scheme, host}, never the URL (not even redacted), so no
 * userinfo/token can leak into the persisted receipt.
 */
export type CredentialFinding = {
	remote: string;
	scheme: string;
	host: string;
	reason: string;
};

export type DirtySummary = {
	stagedOnly: number;
	unstaged: number;
	untracked: number;
	ignoredOnly: number;
	stashCount: number;
	clean: boolean;
};

export type PreserveBaselineReceipt = {
	version: typeof PRESERVE_BASELINE_AUDIT_SCHEMA_VERSION;
	generatedAt: string;
	host: string;
	user: string;
	repo: string;
	head: string;
	branch: string;
	upstream: UpstreamDivergence;
	remotes: RemoteIdentity[];
	stagedOnly: string[];
	unstaged: string[];
	untracked: string[];
	ignoredOnly: string[];
	stashCount: number;
	credentialFindings: CredentialFinding[];
	dirtySummary: DirtySummary;
	/** True when there is no uncommitted/untracked/ignored/stash state at all. */
	preserveClean: boolean;
};

// ────────────────────────────────────────────────────────────────────────────
// Pure parsing / classification (unit-tested)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Classify `git status --porcelain` (v1, NUL-separated) output into
 * staged-only / unstaged / untracked buckets.
 *
 * Porcelain v1 status is two characters: X (index/staged) then Y (worktree).
 * "??" is untracked. A path is "staged-only" when X is a real status letter and
 * Y is clean (space); it is "unstaged" when Y is a real status letter (it may
 * also be staged, but the unstaged delta is what a `reset` would surface). A
 * path with both X and Y dirty is reported in BOTH staged-only-adjacent terms;
 * we keep it simple and the kit's intent literal: stagedOnly = index dirty &&
 * worktree clean; unstaged = worktree dirty. Renames (`R`/`C`) carry an
 * "orig -> new" payload; we report the new path.
 *
 * Records are NUL-delimited so paths with spaces/newlines are handled. Rename
 * entries in `-z` mode emit two NUL fields (new\0orig); the orig is consumed.
 */
export function classifyPorcelain(porcelainZ: string): PorcelainClassification {
	const stagedOnly: string[] = [];
	const unstaged: string[] = [];
	const untracked: string[] = [];

	const fields = porcelainZ.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const entry = fields[i];
		if (entry === undefined || entry.length === 0) continue;
		// Each porcelain record is "XY <path>" (min length 4: 2 status + space + 1).
		if (entry.length < 4) continue;

		const x = entry[0] ?? " ";
		const y = entry[1] ?? " ";
		const filePath = entry.slice(3);

		// Rename/copy consume the following NUL field (the original path).
		if (x === "R" || x === "C" || y === "R" || y === "C") {
			i += 1;
		}

		if (x === "?" && y === "?") {
			untracked.push(filePath);
			continue;
		}

		const indexDirty = x !== " " && x !== "?";
		const worktreeDirty = y !== " " && y !== "?";

		if (worktreeDirty) {
			unstaged.push(filePath);
		}
		if (indexDirty && !worktreeDirty) {
			stagedOnly.push(filePath);
		}
	}

	return { stagedOnly, unstaged, untracked };
}

/**
 * Parse NUL-separated `git ls-files --others --ignored --exclude-standard -z`
 * output into the list of present-but-ignored paths (the files a `clean -fdx`
 * would silently delete). Empty trailing field from the final NUL is dropped.
 */
export function parseIgnoredFiles(lsFilesZ: string): string[] {
	return lsFilesZ
		.split("\0")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/**
 * Parse the stash count from `git stash list` (one entry per line). A reset or
 * branch deletion does not drop the stash, but reflog-expiry / gc does, so the
 * count is preserved evidence.
 */
export function parseStashCount(stashList: string): number {
	return stashList
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0).length;
}

/**
 * Parse `git remote -v` output into a de-duplicated list of name -> URL. The
 * porcelain emits "<name>\t<url> (fetch)" and "(push)" lines; we keep one entry
 * per remote name (fetch URL wins, push recorded only when it differs).
 */
export function parseRemotes(remoteVerbose: string): Remote[] {
	const fetchUrls = new Map<string, string>();
	const pushUrls = new Map<string, string>();

	for (const line of remoteVerbose.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const match = trimmed.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
		if (!match) continue;
		const name = match[1];
		const url = match[2];
		const kind = match[3];
		if (name === undefined || url === undefined) continue;
		if (kind === "fetch") {
			fetchUrls.set(name, url);
		} else {
			pushUrls.set(name, url);
		}
	}

	const remotes: Remote[] = [];
	const names = new Set<string>([...fetchUrls.keys(), ...pushUrls.keys()]);
	for (const name of names) {
		const fetch = fetchUrls.get(name);
		const push = pushUrls.get(name);
		const url = fetch ?? push;
		if (url === undefined) continue;
		remotes.push({ name, url });
		if (push !== undefined && fetch !== undefined && push !== fetch) {
			remotes.push({ name: `${name} (push)`, url: push });
		}
	}

	return remotes;
}

/**
 * Redact embedded credentials from a remote URL for HUMAN-FACING DISPLAY ONLY
 * (log / stderr lines) — never for the persisted receipt or --json output, which
 * are capture-less (see {@link describeRemote}). A redacted URL still carries the
 * host and username, so it must not touch disk; keep it to ephemeral operator
 * output. Behaviour:
 * - `https://user:token@host/repo.git` -> `https://user:***@host/repo.git`
 *   (the WHOLE password is redacted even if it contains '@', since userinfo is
 *   split at the LAST '@' before the authority).
 * - `https://TOKEN@host/repo.git` (token-as-username, no colon) ->
 *   `https://***@host/repo.git` — a bare userinfo on an http(s)-style scheme is
 *   itself a secret (e.g. a GitHub PAT) and must be redacted.
 * A bare userinfo on an ssh/git scheme (`ssh://git@host`) is the normal SSH
 * identity, not a secret, and is left unchanged. Non-credentialed URLs are
 * returned unchanged.
 */
export function redactRemoteUrl(url: string): string {
	// scheme://userinfo@authority... — `[^/]*` is greedy and stops at the first
	// '/', so the captured userinfo runs up to the LAST '@' before the path.
	return url.replace(
		/^([a-z][a-z0-9+.-]*:\/\/)([^/]*)@/i,
		(full, scheme: string, userinfo: string) => {
			// Empty userinfo (e.g. `https://@host`) carries no credential.
			if (userinfo === "") return full;
			const colon = userinfo.indexOf(":");
			if (colon >= 0) {
				// user:password — keep the user, redact the entire password.
				return `${scheme}${userinfo.slice(0, colon)}:***@`;
			}
			// No colon: a bare token-as-username. Legitimate ONLY for ssh-transport
			// schemes (ssh://, git://, *+ssh://, *+git://); on any other scheme it
			// is a secret. Match the transport EXACTLY — a `startsWith` prefix would
			// wrongly exempt git+https:// / gitlab:// / sshx:// and leak their token.
			const transport = scheme.toLowerCase().replace(/:\/\/$/, "");
			if (
				transport === "ssh" ||
				transport === "git" ||
				transport.endsWith("+ssh") ||
				transport.endsWith("+git")
			) {
				return full;
			}
			return `${scheme}***@`;
		},
	);
}

/**
 * Extract the host from a `scheme://` URL's authority ([userinfo@]host[:port]),
 * discarding the userinfo entirely — capture-less: the credential is never even
 * read into the result. IPv6 literals keep their brackets; the port is dropped.
 */
function hostFromAuthority(authority: string): string {
	// Host is everything after the LAST '@'; the userinfo before it is discarded.
	const at = authority.lastIndexOf("@");
	const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
	if (hostPort.startsWith("[")) {
		// IPv6 literal: `[::1]:8080` — the host is the bracketed part.
		const close = hostPort.indexOf("]");
		return close >= 0 ? hostPort.slice(0, close + 1) : hostPort;
	}
	const colon = hostPort.indexOf(":");
	return colon >= 0 ? hostPort.slice(0, colon) : hostPort;
}

/**
 * Whether a remote URL embeds a credential/secret in its userinfo. The
 * capture-less credential-presence predicate — it decides PRESENCE without ever
 * building a redacted string. Applies the exact same rule as
 * {@link redactRemoteUrl} (a unit test asserts the two never disagree across the
 * adversarial corpus): a `scheme://user:password@` is always a secret; a bare
 * token-as-username is a secret UNLESS the scheme is an ssh transport
 * (ssh / git / *+ssh / *+git), where `user@` is a benign SSH identity.
 */
function hasEmbeddedCredential(url: string): boolean {
	const match = url.match(/^([a-z][a-z0-9+.-]*):\/\/([^/]*)@/i);
	if (!match) return false;
	const scheme = (match[1] ?? "").toLowerCase();
	const userinfo = match[2] ?? "";
	if (userinfo === "") return false;
	if (userinfo.includes(":")) return true;
	const sshTransport =
		scheme === "ssh" ||
		scheme === "git" ||
		scheme.endsWith("+ssh") ||
		scheme.endsWith("+git");
	return !sshTransport;
}

/**
 * Decompose a remote URL into credential-free structured fields — {scheme, host,
 * hasCredential} — that are safe to persist. This is the capture-less
 * replacement for storing a redacted URL: the userinfo/token is DETECTED
 * (hasCredential) but never captured into the result, so a redact-after-capture
 * leak is impossible by construction. Handles `scheme://[userinfo@]host` URLs,
 * scp-like SSH shorthand (`git@host:path`, an implicit ssh transport), and falls
 * back to empty scheme/host for local paths / unrecognized forms.
 */
export function describeRemote(url: string): RemoteDescriptor {
	const hasCredential = hasEmbeddedCredential(url);

	// scheme://authority/... — authority = [userinfo@]host[:port]
	const schemeMatch = url.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i);
	if (schemeMatch) {
		return {
			scheme: (schemeMatch[1] ?? "").toLowerCase(),
			host: hostFromAuthority(schemeMatch[2] ?? ""),
			hasCredential,
		};
	}

	// scp-like SSH shorthand: `[user@]host:path` (no scheme, no `//`).
	const scpMatch = url.match(/^(?:[^@/]+@)?([^:/]+):/);
	if (scpMatch) {
		return { scheme: "ssh", host: scpMatch[1] ?? "", hasCredential };
	}

	// Local path or unrecognized form — nothing host-like to record.
	return { scheme: "", host: "", hasCredential };
}

/**
 * Detect remotes whose URL embeds a credential/secret in userinfo. A force-push
 * or re-clone of such a remote would leak the token; the audit flags them so it
 * can be rotated before any destructive action. Capture-less: each finding
 * carries only the credential-free {scheme, host} (via {@link describeRemote}),
 * never the URL — not even redacted — so no secret can reach the receipt.
 */
export function detectCredentialInRemote(remotes: Remote[]): CredentialFinding[] {
	const findings: CredentialFinding[] = [];
	for (const remote of remotes) {
		const { scheme, host, hasCredential } = describeRemote(remote.url);
		if (!hasCredential) continue;
		findings.push({
			remote: remote.name,
			scheme,
			host,
			reason: "remote URL embeds a credential/secret in userinfo",
		});
	}
	return findings;
}

/**
 * Parse the upstream-tracking header from `git status --porcelain=v1 --branch`
 * (the `## branch...upstream [ahead N, behind M]` first line, or the
 * `## branch...upstream [gone]` form, or `## branch` with no upstream).
 */
export function parseBranchHeader(branchLine: string): UpstreamDivergence {
	const noUpstream: UpstreamDivergence = {
		upstream: null,
		ahead: 0,
		behind: 0,
		gone: false,
	};

	const header = branchLine.startsWith("## ")
		? branchLine.slice(3)
		: branchLine;
	const trimmed = header.trim();
	if (trimmed.length === 0) return noUpstream;

	// "<branch>...<upstream> [ahead N, behind M]" — the upstream is after "...".
	const upstreamMatch = trimmed.match(/^[^.\s]\S*\.\.\.(\S+)(.*)$/);
	if (!upstreamMatch) {
		return noUpstream;
	}
	const upstream = upstreamMatch[1] ?? null;
	const tail = upstreamMatch[2] ?? "";

	if (/\[gone\]/.test(tail)) {
		return { upstream, ahead: 0, behind: 0, gone: true };
	}

	const aheadMatch = tail.match(/ahead (\d+)/);
	const behindMatch = tail.match(/behind (\d+)/);
	const ahead = aheadMatch?.[1] ? Number.parseInt(aheadMatch[1], 10) : 0;
	const behind = behindMatch?.[1] ? Number.parseInt(behindMatch[1], 10) : 0;

	return { upstream, ahead, behind, gone: false };
}

/**
 * Build the dirty summary + preserve-clean verdict from the classified state.
 * `preserveClean` is true only when there is genuinely nothing a destructive
 * action would lose: no staged/unstaged/untracked/ignored files and no stash.
 */
export function summarizeDirty(input: {
	stagedOnly: string[];
	unstaged: string[];
	untracked: string[];
	ignoredOnly: string[];
	stashCount: number;
}): DirtySummary {
	const clean =
		input.stagedOnly.length === 0 &&
		input.unstaged.length === 0 &&
		input.untracked.length === 0 &&
		input.ignoredOnly.length === 0 &&
		input.stashCount === 0;
	return {
		stagedOnly: input.stagedOnly.length,
		unstaged: input.unstaged.length,
		untracked: input.untracked.length,
		ignoredOnly: input.ignoredOnly.length,
		stashCount: input.stashCount,
		clean,
	};
}

/**
 * Assemble the full receipt from raw git command outputs. Pure: takes already
 * collected strings and host/repo identity, performs no I/O. Exported so a test
 * can drive a complete receipt from fixtures without a real repo.
 */
export function buildReceipt(input: {
	generatedAt: string;
	host: string;
	user: string;
	repo: string;
	head: string;
	branch: string;
	branchHeaderLine: string;
	porcelainZ: string;
	ignoredZ: string;
	stashList: string;
	remoteVerbose: string;
}): PreserveBaselineReceipt {
	const { stagedOnly, unstaged, untracked } = classifyPorcelain(
		input.porcelainZ,
	);
	const ignoredOnly = parseIgnoredFiles(input.ignoredZ);
	const stashCount = parseStashCount(input.stashList);
	const remotes = parseRemotes(input.remoteVerbose);
	const credentialFindings = detectCredentialInRemote(remotes);
	const upstream = parseBranchHeader(input.branchHeaderLine);
	const dirtySummary = summarizeDirty({
		stagedOnly,
		unstaged,
		untracked,
		ignoredOnly,
		stashCount,
	});

	// Persist a capture-less structured view of each remote — {scheme, host,
	// hasCredential}. No URL (full or redacted) touches disk, so no userinfo/
	// token can ever leak into the receipt.
	const safeRemotes: RemoteIdentity[] = remotes.map((remote) => ({
		name: remote.name,
		...describeRemote(remote.url),
	}));

	return {
		version: PRESERVE_BASELINE_AUDIT_SCHEMA_VERSION,
		generatedAt: input.generatedAt,
		host: input.host,
		user: input.user,
		repo: input.repo,
		head: input.head,
		branch: input.branch,
		upstream,
		remotes: safeRemotes,
		stagedOnly,
		unstaged,
		untracked,
		ignoredOnly,
		stashCount,
		credentialFindings,
		dirtySummary,
		preserveClean: dirtySummary.clean,
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Live git I/O (read-only) + CLI
// ────────────────────────────────────────────────────────────────────────────

type AuditConfig = {
	repo: string;
	outputDir: string;
	json: boolean;
};

function getArgValue(args: string[], flag: string): string | undefined {
	const index = args.findIndex(
		(arg) => arg === flag || arg.startsWith(`${flag}=`),
	);
	if (index === -1) return undefined;
	const arg = args[index];
	if (!arg) return undefined;
	if (arg.includes("=")) {
		return arg.split("=")[1];
	}
	return args[index + 1];
}

function parseConfig(args: string[]): AuditConfig {
	const repo = getArgValue(args, "--repo") ?? process.cwd();
	const outputDir =
		getArgValue(args, "--output-dir") ??
		path.join(process.cwd(), "research", "preserve-baseline");
	return { repo, outputDir, json: args.includes("--json") };
}

async function runGit(
	repo: string,
	gitArgs: string[],
): Promise<{ exitCode: number; output: string }> {
	let proc: ReturnType<typeof spawn>;
	try {
		proc = spawn(["git", ...gitArgs], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		return { exitCode: -1, output: (error as Error).message };
	}
	const stdout = await new Response(
		proc.stdout as ReadableStream<Uint8Array>,
	).text();
	const stderr = await new Response(
		proc.stderr as ReadableStream<Uint8Array>,
	).text();
	await proc.exited;
	return {
		exitCode: proc.exitCode ?? -1,
		output: stdout.length > 0 ? stdout : stderr,
	};
}

async function collectReceipt(
	config: AuditConfig,
): Promise<PreserveBaselineReceipt> {
	const repo = config.repo;
	// All read-only plumbing/porcelain — none of these mutate the repo.
	const [
		headRes,
		branchRes,
		statusBranchRes,
		porcelainRes,
		ignoredRes,
		stashRes,
		remoteRes,
	] = await Promise.all([
		runGit(repo, ["rev-parse", "HEAD"]),
		runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
		runGit(repo, ["status", "--porcelain=v1", "--branch"]),
		runGit(repo, ["status", "--porcelain=v1", "-z"]),
		runGit(repo, [
			"ls-files",
			"--others",
			"--ignored",
			"--exclude-standard",
			"-z",
		]),
		runGit(repo, ["stash", "list"]),
		runGit(repo, ["remote", "-v"]),
	]);

	const [branchHeaderLine = ""] = statusBranchRes.output.split("\n");
	const [head = ""] = headRes.output.split("\n");
	const [branch = ""] = branchRes.output.split("\n");

	// Human-facing (stderr) only: surface any credential-bearing remote using the
	// display-safe redactor so the operator knows which token to rotate. This is
	// the sole retained use of redactRemoteUrl — the receipt/--json stay
	// capture-less (the redacted string never touches disk or stdout).
	for (const remote of parseRemotes(remoteRes.output)) {
		const redacted = redactRemoteUrl(remote.url);
		if (redacted !== remote.url) {
			console.warn(
				`⚠️  credential-in-remote: ${remote.name} → ${redacted} (rotate before any destructive action)`,
			);
		}
	}

	return buildReceipt({
		generatedAt: new Date().toISOString(),
		host: os.hostname(),
		user: os.userInfo().username,
		repo,
		head: head.trim(),
		branch: branch.trim(),
		branchHeaderLine,
		porcelainZ: porcelainRes.output,
		ignoredZ: ignoredRes.output,
		stashList: stashRes.output,
		remoteVerbose: remoteRes.output,
	});
}

async function writeReceipt(
	config: AuditConfig,
	receipt: PreserveBaselineReceipt,
): Promise<string> {
	await fs.mkdir(config.outputDir, { recursive: true });
	const timestamp = receipt.generatedAt.replaceAll(":", "-");
	const safeHost = receipt.host.replace(/[^a-zA-Z0-9_.-]/g, "_");
	const datedPath = path.join(
		config.outputDir,
		`preserve-baseline-${safeHost}-${timestamp}.json`,
	);
	const latestPath = path.join(config.outputDir, "latest.json");
	const content = `${JSON.stringify(receipt, null, 2)}\n`;
	await fs.writeFile(datedPath, content, "utf8");
	await fs.writeFile(latestPath, content, "utf8");
	return datedPath;
}

function renderSummary(receipt: PreserveBaselineReceipt): string {
	const lines: string[] = [];
	lines.push(
		`🛟 preserve-before-destroy baseline — ${receipt.host} (${receipt.user})`,
	);
	lines.push(`   repo:     ${receipt.repo}`);
	lines.push(`   branch:   ${receipt.branch}`);
	lines.push(`   HEAD:     ${receipt.head}`);
	const up = receipt.upstream;
	if (up.upstream === null) {
		lines.push("   upstream: (none)");
	} else if (up.gone) {
		lines.push(`   upstream: ${up.upstream} [GONE]`);
	} else {
		lines.push(
			`   upstream: ${up.upstream} (ahead ${up.ahead}, behind ${up.behind})`,
		);
	}
	const d = receipt.dirtySummary;
	lines.push(
		`   dirty:    staged-only ${d.stagedOnly} · unstaged ${d.unstaged} · untracked ${d.untracked} · ignored ${d.ignoredOnly} · stash ${d.stashCount}`,
	);
	lines.push(`   remotes:  ${receipt.remotes.length}`);
	if (receipt.credentialFindings.length > 0) {
		lines.push(
			`   ⚠️ credential-in-remote: ${receipt.credentialFindings.length} (rotate before destroy)`,
		);
	}
	lines.push(
		receipt.preserveClean
			? "   verdict:  CLEAN — nothing to preserve before a destructive action"
			: "   verdict:  DIRTY — preserve the above before any destructive action",
	);
	return lines.join("\n");
}

export { collectReceipt, parseConfig };

if (import.meta.main) {
	const config = parseConfig(process.argv.slice(2));
	const receipt = await collectReceipt(config);
	const artifactPath = await writeReceipt(config, receipt);
	if (config.json) {
		console.log(JSON.stringify(receipt, null, 2));
	} else {
		console.log(renderSummary(receipt));
	}
	console.log(`\nReceipt: ${artifactPath}`);
}
