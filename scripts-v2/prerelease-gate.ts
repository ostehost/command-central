#!/usr/bin/env bun

import { spawn } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

type CheckStatus = "passed" | "failed" | "skipped";

type CheckRecord = {
	name: string;
	status: CheckStatus;
	command?: string;
	cwd?: string;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	output?: string;
	error?: string;
};

type GateReport = {
	version: 1;
	generatedAt: string;
	commandCentral: {
		repo: string;
		sha: string;
	};
	ghosttyLauncher: {
		repo: string;
		sha: string;
		launcherBinary: string;
	};
	checks: CheckRecord[];
	success: boolean;
};

type GateConfig = {
	commandCentralRepo: string;
	ghosttyLauncherRepo: string;
	launcherBinary: string;
	outputDir: string;
	skipCcValidation: boolean;
	skipLauncherValidation: boolean;
	requireNodeReadiness: boolean;
	nodeReadinessGate: string;
	openClawBinary: string;
	expectedOpenClawVersion?: string;
	requireDaemonSmoke?: boolean;
	requireRepoParity?: boolean;
	requirePushTarget?: boolean;
	pushRemote?: string;
	configRepo?: string;
};

class GateError extends Error {
	readonly checks: CheckRecord[];

	constructor(message: string, checks: CheckRecord[]) {
		super(message);
		this.name = "GateError";
		this.checks = checks;
	}
}

const REQUIRED_LAUNCHER_FLAGS = [
	"--create-bundle",
	"--parse-name",
	"--parse-icon",
	"--session-id",
];
const REQUIRED_LAUNCHER_HELPERS = [
	"oste-capture.sh",
	"oste-kill.sh",
	"oste-pause.sh",
];

const REQUIRED_STEER_FLAGS = ["--raw", "--by-task-id"];

const args = process.argv.slice(2);

function getArgValue(flag: string): string | undefined {
	const index = args.findIndex(arg => arg === flag || arg.startsWith(`${flag}=`));
	if (index === -1) return undefined;

	const arg = args[index];
	if (!arg) return undefined;
	if (arg.includes("=")) {
		return arg.split("=")[1];
	}

	return args[index + 1];
}

function parseArgs(): GateConfig {
	const home = process.env["HOME"];
	if (!home) {
		throw new Error("HOME is not set.");
	}

	return {
		commandCentralRepo: process.cwd(),
		ghosttyLauncherRepo:
			getArgValue("--launcher-repo") ||
			path.join(home, "projects", "ghostty-launcher"),
		launcherBinary:
			getArgValue("--launcher-binary") ||
			path.join(
				getArgValue("--launcher-repo") ||
					path.join(home, "projects", "ghostty-launcher"),
				"launcher",
			),
		outputDir:
			getArgValue("--output-dir") ||
			path.join(process.cwd(), "research", "prerelease-gate"),
		skipCcValidation: args.includes("--skip-cc-validation"),
		skipLauncherValidation: args.includes("--skip-launcher-validation"),
		requireNodeReadiness: args.includes("--require-node-readiness"),
		nodeReadinessGate:
			getArgValue("--node-readiness-gate") ||
			path.join(
				home,
				"projects",
				"config",
				"openclaw",
				"scripts",
				"openclaw-node-readiness-gate.mjs",
			),
		openClawBinary: getArgValue("--openclaw-bin") || "openclaw",
		expectedOpenClawVersion: getArgValue("--expected-openclaw-version"),
		requireDaemonSmoke: args.includes("--require-daemon-smoke"),
		requireRepoParity: args.includes("--require-repo-parity"),
		requirePushTarget: args.includes("--require-push-target"),
		pushRemote: getArgValue("--push-remote") || "origin",
		configRepo:
			getArgValue("--config-repo") ||
			path.join(home, "projects", "config"),
	};
}

function nowIso(): string {
	return new Date().toISOString();
}

async function runCommand(
	command: string[],
	cwd: string,
): Promise<{ exitCode: number; output: string }> {
	let proc: ReturnType<typeof spawn>;
	try {
		proc = spawn(command, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		return {
			exitCode: -1,
			output: (error as Error).message,
		};
	}

	try {
		const stdout = await new Response(
			proc.stdout as ReadableStream<Uint8Array>,
		).text();
		const stderr = await new Response(
			proc.stderr as ReadableStream<Uint8Array>,
		).text();
		await proc.exited;

		return {
			exitCode: proc.exitCode ?? -1,
			output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
		};
	} catch (error) {
		return {
			exitCode: proc.exitCode ?? -1,
			output: (error as Error).message,
		};
	}
}

async function getGitSha(repo: string): Promise<string> {
	const result = await runCommand(["git", "rev-parse", "HEAD"], repo);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to read git SHA in ${repo}: ${result.output}`);
	}
	const [firstLine = ""] = result.output.split("\n");
	return firstLine.trim();
}

function extractFlagsFromHelp(helpText: string): Set<string> {
	return new Set(helpText.match(/--[a-z0-9-]+/g) || []);
}

function extractSessionFlagsFromTerminalManager(source: string): Set<string> {
	const found = new Set<string>();
	for (const match of source.matchAll(/"--(session-id|tmux-session)"/g)) {
		const flag = match[1];
		if (flag) {
			found.add(`--${flag}`);
		}
	}
	return found;
}

type SteerInvocationContract = {
	usesLegacySessionFlag: boolean;
	usesRawMode: boolean;
	usesPositionalSession: boolean;
};

const STEER_EXEC_COMMAND_REGEX =
	/execCommand\(\s*(?:"oste-steer\.sh"|steerPath\d*)\s*,\s*\[([\s\S]*?)\]\s*\)/g;

function extractSteerInvocationArgBlocks(
	terminalManagerSource: string,
): string[] {
	return [...terminalManagerSource.matchAll(STEER_EXEC_COMMAND_REGEX)]
		.map(match => match[1])
		.filter((argsBlock): argsBlock is string => typeof argsBlock === "string");
}

function extractSteerInvocationContract(
	terminalManagerSource: string,
): SteerInvocationContract {
	let usesLegacySessionFlag = false;
	let usesRawMode = false;
	let usesPositionalSession = false;

	for (const argsBlock of extractSteerInvocationArgBlocks(
		terminalManagerSource,
	)) {
		if (/"--session"/.test(argsBlock)) {
			usesLegacySessionFlag = true;
		}

		if (/"--raw"/.test(argsBlock)) {
			usesRawMode = true;
		}

		const [firstArg = ""] = argsBlock.split(",", 1);
		const trimmedFirstArg = firstArg.trim();
		if (
			trimmedFirstArg.length > 0 &&
			!trimmedFirstArg.startsWith('"--') &&
			!trimmedFirstArg.startsWith("'--")
		) {
			usesPositionalSession = true;
		}
	}

	return {
		usesLegacySessionFlag,
		usesRawMode,
		usesPositionalSession,
	};
}

function extractLauncherHelperCallsFromExtension(source: string): Set<string> {
	const found = new Set<string>();
	for (const match of source.matchAll(
		/resolveLauncherHelperScriptPath\s*\(\s*"([^"]+)"/g,
	)) {
		const helper = match[1];
		if (helper) {
			found.add(helper);
		}
	}
	return found;
}

function hasLegacyTasksDirHelperResolution(source: string): boolean {
	return /path\.dirname\(tasksFilePath\)[\s\S]{0,240}oste-(capture|kill)\.sh/.test(
		source,
	);
}

function anchorsHelperScriptsToLauncher(source: string): boolean {
	return /resolveLauncherHelperScriptPath[\s\S]*path\.join\(\s*path\.dirname\(launcherPath\),\s*"scripts",\s*scriptName/s.test(
		source,
	);
}
function validateLauncherContract(
	terminalManagerSource: string,
	launcherHelpText: string,
	extensionSource = "",
): string[] {
	const issues: string[] = [];
	const helpFlags = extractFlagsFromHelp(launcherHelpText);
	const sessionFlags = extractSessionFlagsFromTerminalManager(
		terminalManagerSource,
	);

	for (const flag of REQUIRED_LAUNCHER_FLAGS) {
		if (!helpFlags.has(flag)) {
			issues.push(`launcher help is missing required flag ${flag}`);
		}
	}

	if (!sessionFlags.has("--session-id")) {
		issues.push("Command Central does not reference --session-id.");
	}

	if (sessionFlags.has("--tmux-session")) {
		issues.push("Command Central still references legacy --tmux-session.");
	}

	if (extensionSource) {
		const helperCalls = extractLauncherHelperCallsFromExtension(extensionSource);
		for (const helper of REQUIRED_LAUNCHER_HELPERS) {
			if (!helperCalls.has(helper)) {
				issues.push(
					`Command Central is missing launcher helper resolution for ${helper}.`,
				);
			}
		}

		if (hasLegacyTasksDirHelperResolution(extensionSource)) {
			issues.push(
				"Command Central still resolves launcher helper scripts relative to tasks.json.",
			);
		}
	}

	if (!anchorsHelperScriptsToLauncher(terminalManagerSource)) {
		issues.push(
			"Command Central does not anchor launcher helper scripts to the resolved launcher binary.",
		);
	}

	return issues;
}

function validateSteerContract(
	terminalManagerSource: string,
	steerHelpText: string,
): string[] {
	const issues: string[] = [];
	const helpFlags = extractFlagsFromHelp(steerHelpText);
	const steerContract = extractSteerInvocationContract(terminalManagerSource);

	// oste-steer.sh is still part of the launcher's `--send` tmux dispatch,
	// so verify the helper's own surface stays stable.
	for (const flag of REQUIRED_STEER_FLAGS) {
		if (!helpFlags.has(flag)) {
			issues.push(`oste-steer help is missing required flag ${flag}`);
		}
	}

	if (!/oste-steer\.sh <session-name> <text>/.test(steerHelpText)) {
		issues.push(
			"oste-steer help is missing the positional <session-name> usage contract.",
		);
	}

	// rc.31 inverted the extension-side contract: the extension delegates the
	// entire send-to-project-session flow to `launcher --send`, which calls
	// oste-steer.sh internally. The extension MUST NOT shell out to the helper
	// directly anymore. usesLegacySessionFlag / usesRawMode / usesPositionalSession
	// describe the extension's call shape — they should all be false now (the
	// extension makes no oste-steer.sh calls at all).
	if (steerContract.usesLegacySessionFlag) {
		issues.push(
			"Command Central source still references oste-steer.sh --session — should delegate via launcher --send.",
		);
	}
	if (steerContract.usesRawMode) {
		issues.push(
			"Command Central source still passes --raw to oste-steer.sh directly — should delegate via launcher --send.",
		);
	}
	if (steerContract.usesPositionalSession) {
		issues.push(
			"Command Central source still calls oste-steer.sh with a positional session — should delegate via launcher --send.",
		);
	}

	// Positive contract: the extension's TerminalManager source must reference
	// `--send` and `--command` (the new launcher invocation).
	if (!/"--send"/.test(terminalManagerSource)) {
		issues.push(
			"Command Central TerminalManager.ts missing `--send` invocation — should call launcher --send <dir> --command <cmd>.",
		);
	}
	if (!/"--command"/.test(terminalManagerSource)) {
		issues.push(
			"Command Central TerminalManager.ts missing `--command` flag in launcher invocation.",
		);
	}

	return issues;
}

async function writeReport(config: GateConfig, report: GateReport): Promise<string> {
	await fs.mkdir(config.outputDir, { recursive: true });
	const timestamp = report.generatedAt.replaceAll(":", "-");
	const datedPath = path.join(
		config.outputDir,
		`prerelease-gate-${timestamp}.json`,
	);
	const latestPath = path.join(config.outputDir, "latest.json");
	const content = `${JSON.stringify(report, null, 2)}\n`;
	await fs.writeFile(datedPath, content, "utf8");
	await fs.writeFile(latestPath, content, "utf8");
	return datedPath;
}

function buildRecord(
	name: string,
	status: CheckStatus,
	startedAtMs: number,
	finishedAtMs: number,
	command?: string,
	cwd?: string,
	output?: string,
	error?: string,
): CheckRecord {
	return {
		name,
		status,
		command,
		cwd,
		startedAt: new Date(startedAtMs).toISOString(),
		finishedAt: new Date(finishedAtMs).toISOString(),
		durationMs: finishedAtMs - startedAtMs,
		output,
		error,
	};
}

function extractOpenClawVersion(output: string): string {
	const [version = ""] = output.match(/\d{4}\.\d+\.\d+/) ?? [];
	return version;
}

type DaemonSmokeResult = {
	ok: boolean;
	issues: string[];
};

/**
 * Pure evaluation of `openclaw daemon status --json` output for the CCREL-05
 * daemon-smoke gate. The daemon must report a running state and a usable socket
 * so the hub can dispatch to compute nodes during the release window. Parse
 * failures are issues (not crashes) so the caller can surface a clean check
 * failure and persist a structured artifact. The JSON shape is intentionally
 * tolerant: `running`/`alive`/`ok` are accepted truthiness signals and either a
 * `socket`/`socketPath` string or a `pid` integer counts as a live endpoint.
 */
function evaluateDaemonSmoke(statusOutput: string): DaemonSmokeResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(statusOutput);
	} catch {
		return { ok: false, issues: ["daemon status output is not valid JSON"] };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { ok: false, issues: ["daemon status JSON is not an object"] };
	}
	const status = parsed as Record<string, unknown>;
	const issues: string[] = [];

	const service =
		status["service"] && typeof status["service"] === "object"
			? (status["service"] as Record<string, unknown>)
			: undefined;
	const runtime =
		service?.["runtime"] && typeof service["runtime"] === "object"
			? (service["runtime"] as Record<string, unknown>)
			: undefined;

	const running =
		status["running"] === true ||
		status["alive"] === true ||
		status["ok"] === true ||
		status["state"] === "running" ||
		runtime?.["status"] === "running" ||
		runtime?.["state"] === "running" ||
		runtime?.["state"] === "active";
	if (!running) {
		issues.push("daemon is not reporting a running state");
	}

	const gateway =
		status["gateway"] && typeof status["gateway"] === "object"
			? (status["gateway"] as Record<string, unknown>)
			: undefined;
	const socket = status["socket"] ?? status["socketPath"] ?? gateway?.["probeUrl"];
	const hasSocket = typeof socket === "string" && socket.length > 0;
	const pid = status["pid"] ?? runtime?.["pid"];
	const hasPid = typeof pid === "number" && Number.isFinite(pid);
	if (!hasSocket && !hasPid) {
		issues.push("daemon status is missing a live endpoint (socket or pid)");
	}

	return { ok: issues.length === 0, issues };
}

type RepoParityInput = {
	repo: string;
	porcelain: string;
	aheadBehind: string;
};

type RepoParityResult = {
	repo: string;
	ok: boolean;
	issues: string[];
};

/**
 * Pure evaluation of a single hub repo's parity with `origin/main` for the CCREL-05
 * hub repo-parity gate. A repo is RC-ready only when its tree is clean and
 * it is exactly at `origin/main` (0 ahead / 0 behind). `porcelain` is the output
 * of `git status --porcelain`; `aheadBehind` is the output of
 * `git rev-list --left-right --count origin/main...HEAD` ("behind<TAB>ahead").
 * This is intentionally local-only: node readiness is a separate live check,
 * and this gate does not claim to inspect node-side working trees.
 */
function evaluateRepoParity(input: RepoParityInput): RepoParityResult {
	const issues: string[] = [];
	if (input.porcelain.trim().length > 0) {
		issues.push(`${input.repo} has uncommitted changes (tree not clean)`);
	}

	const [behindRaw = "", aheadRaw = ""] = input.aheadBehind.trim().split(/\s+/);
	const behind = Number.parseInt(behindRaw, 10);
	const ahead = Number.parseInt(aheadRaw, 10);
	if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
		issues.push(
			`${input.repo} ahead/behind against origin/main could not be parsed: "${input.aheadBehind.trim()}"`,
		);
	} else {
		if (ahead > 0) {
			issues.push(`${input.repo} is ${ahead} commit(s) ahead of origin/main`);
		}
		if (behind > 0) {
			issues.push(`${input.repo} is ${behind} commit(s) behind origin/main`);
		}
	}

	return { repo: input.repo, ok: issues.length === 0, issues };
}

type PushTargetInput = {
	/** The configured push remote, e.g. "origin". */
	remote: string;
	/** Output of `git remote get-url <remote>` (the live push target). */
	remoteUrl: string;
	/** The `repository.url` (or `repository`) string from package.json. */
	packageRepoUrl: string;
};

type PushTargetResult = {
	ok: boolean;
	remote: string;
	/** Normalized owner/repo slug parsed from the live remote, or "" if unknown. */
	remoteSlug: string;
	/** Normalized owner/repo slug expected from package.json, or "" if unknown. */
	expectedSlug: string;
	issues: string[];
};

/**
 * Normalize a GitHub remote URL to a lowercase `owner/repo` slug so SSH/HTTPS,
 * a trailing `.git`, a trailing slash, and case differences all compare equal.
 * Returns "" when the URL is not a recognizable GitHub remote so the caller can
 * surface a clear "could not parse" issue rather than silently matching.
 * Supported shapes:
 *   - https://github.com/owner/repo(.git)
 *   - git@github.com:owner/repo(.git)
 *   - ssh://git@github.com/owner/repo(.git)
 */
function normalizeGitHubRemote(url: string): string {
	const trimmed = url.trim();
	if (trimmed.length === 0) return "";

	const scpLike = trimmed.match(
		/^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
	);
	if (scpLike) {
		const owner = scpLike[1];
		const repo = scpLike[2];
		if (!owner || !repo) return "";
		return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return "";
	}
	if (parsed.hostname.toLowerCase() !== "github.com") return "";
	const parts = parsed.pathname.split("/").filter(Boolean);
	if (parts.length !== 2) return "";
	const owner = parts[0];
	const repo = parts[1]?.replace(/\.git$/i, "");
	if (!owner || !repo) return "";
	return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/**
 * Pure evaluation of the CCSTD-05 release split-identity / push-target guardrail.
 * Command Central and ghostty-launcher are a split identity (two repos, two
 * remotes); a release script run from the wrong checkout — or against a fork or
 * mis-set remote — must never tag/push to the wrong remote. This compares the
 * live push remote (`git remote get-url <remote>`) against the canonical
 * `repository` declared in package.json (the source of truth) and refuses when
 * they disagree or cannot be parsed. It is non-destructive: it only inspects
 * injected strings and never pushes or tags.
 */
function evaluatePushTarget(input: PushTargetInput): PushTargetResult {
	const issues: string[] = [];
	const remoteSlug = normalizeGitHubRemote(input.remoteUrl);
	const expectedSlug = normalizeGitHubRemote(input.packageRepoUrl);

	if (expectedSlug.length === 0) {
		issues.push(
			`could not parse expected GitHub repo from package.json repository "${input.packageRepoUrl.trim()}"`,
		);
	}
	if (remoteSlug.length === 0) {
		issues.push(
			`could not parse GitHub repo from remote "${input.remote}" url "${input.remoteUrl.trim()}"`,
		);
	}
	if (
		expectedSlug.length > 0 &&
		remoteSlug.length > 0 &&
		expectedSlug !== remoteSlug
	) {
		issues.push(
			`push remote "${input.remote}" points at ${remoteSlug} but package.json declares ${expectedSlug} — refusing to tag/push across the split identity`,
		);
	}

	return {
		ok: issues.length === 0,
		remote: input.remote,
		remoteSlug,
		expectedSlug,
		issues,
	};
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function runNodeReadinessCheck(config: GateConfig): Promise<CheckRecord> {
	const startedAtMs = Date.now();
	const commandLabel = [
		`${config.openClawBinary} nodes status --json`,
		"|",
		config.nodeReadinessGate,
		"--strict --json",
	].join(" ");

	if (!(await fileExists(config.nodeReadinessGate))) {
		const finishedAtMs = Date.now();
		return buildRecord(
			"openclaw node readiness",
			"failed",
			startedAtMs,
			finishedAtMs,
			commandLabel,
			config.commandCentralRepo,
			undefined,
			`Node readiness gate not found: ${config.nodeReadinessGate}`,
		);
	}

	let expectedVersion = config.expectedOpenClawVersion;
	if (!expectedVersion) {
		const versionResult = await runCommand(
			[config.openClawBinary, "--version"],
			config.commandCentralRepo,
		);
		if (versionResult.exitCode !== 0) {
			const finishedAtMs = Date.now();
			return buildRecord(
				"openclaw node readiness",
				"failed",
				startedAtMs,
				finishedAtMs,
				commandLabel,
				config.commandCentralRepo,
				versionResult.output,
				`Failed to resolve expected OpenClaw version: openclaw --version exited with ${versionResult.exitCode}`,
			);
		}
		expectedVersion = extractOpenClawVersion(versionResult.output);
		if (!expectedVersion) {
			const finishedAtMs = Date.now();
			return buildRecord(
				"openclaw node readiness",
				"failed",
				startedAtMs,
				finishedAtMs,
				commandLabel,
				config.commandCentralRepo,
				versionResult.output,
				"Failed to parse expected OpenClaw version from openclaw --version",
			);
		}
	}

	const statusResult = await runCommand(
		[config.openClawBinary, "nodes", "status", "--json"],
		config.commandCentralRepo,
	);
	if (statusResult.exitCode !== 0) {
		const finishedAtMs = Date.now();
		return buildRecord(
			"openclaw node readiness",
			"failed",
			startedAtMs,
			finishedAtMs,
			commandLabel,
			config.commandCentralRepo,
			statusResult.output,
			`openclaw nodes status --json exited with ${statusResult.exitCode}`,
		);
	}

	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-node-readiness-"));
	const statusPath = path.join(tmpDir, "nodes-status.json");
	try {
		await fs.writeFile(statusPath, statusResult.output, "utf8");
		const gateResult = await runCommand(
			[
				config.nodeReadinessGate,
				"--input",
				statusPath,
				"--expected-version",
				expectedVersion,
				"--strict",
				"--json",
			],
			config.commandCentralRepo,
		);
		const finishedAtMs = Date.now();
		if (gateResult.exitCode === 0) {
			return buildRecord(
				"openclaw node readiness",
				"passed",
				startedAtMs,
				finishedAtMs,
				`${commandLabel} --expected-version ${expectedVersion}`,
				config.commandCentralRepo,
				gateResult.output,
			);
		}
		return buildRecord(
			"openclaw node readiness",
			"failed",
			startedAtMs,
			finishedAtMs,
			`${commandLabel} --expected-version ${expectedVersion}`,
			config.commandCentralRepo,
			gateResult.output,
			`Node readiness gate exited with ${gateResult.exitCode}`,
		);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
}

async function runDaemonSmokeCheck(config: GateConfig): Promise<CheckRecord> {
	const startedAtMs = Date.now();
	const commandLabel = `${config.openClawBinary} daemon status --json`;

	const statusResult = await runCommand(
		[config.openClawBinary, "daemon", "status", "--json"],
		config.commandCentralRepo,
	);
	if (statusResult.exitCode !== 0) {
		const finishedAtMs = Date.now();
		return buildRecord(
			"openclaw daemon smoke",
			"failed",
			startedAtMs,
			finishedAtMs,
			commandLabel,
			config.commandCentralRepo,
			statusResult.output,
			`openclaw daemon status --json exited with ${statusResult.exitCode}`,
		);
	}

	const smoke = evaluateDaemonSmoke(statusResult.output);
	const finishedAtMs = Date.now();
	if (smoke.ok) {
		return buildRecord(
			"openclaw daemon smoke",
			"passed",
			startedAtMs,
			finishedAtMs,
			commandLabel,
			config.commandCentralRepo,
			statusResult.output,
		);
	}
	return buildRecord(
		"openclaw daemon smoke",
		"failed",
		startedAtMs,
		finishedAtMs,
		commandLabel,
		config.commandCentralRepo,
		statusResult.output,
		smoke.issues.join("\n"),
	);
}

async function readRepoParity(
	label: string,
	repo: string,
): Promise<RepoParityResult> {
	const porcelain = await runCommand(["git", "status", "--porcelain"], repo);
	if (porcelain.exitCode !== 0) {
		return {
			repo: label,
			ok: false,
			issues: [`${label}: git status failed: ${porcelain.output}`],
		};
	}
	const aheadBehind = await runCommand(
		["git", "rev-list", "--left-right", "--count", "origin/main...HEAD"],
		repo,
	);
	if (aheadBehind.exitCode !== 0) {
		return {
			repo: label,
			ok: false,
			issues: [
				`${label}: git rev-list against origin/main failed: ${aheadBehind.output}`,
			],
		};
	}
	return evaluateRepoParity({
		repo: label,
		porcelain: porcelain.output,
		aheadBehind: aheadBehind.output,
	});
}

function resolveConfigRepo(config: GateConfig): string {
	if (config.configRepo) return config.configRepo;
	const home = process.env["HOME"] ?? "";
	return path.join(home, "projects", "config");
}

async function runRepoParityCheck(config: GateConfig): Promise<CheckRecord> {
	const startedAtMs = Date.now();
	const repos: Array<{ label: string; path: string }> = [
		{ label: "command-central", path: config.commandCentralRepo },
		{ label: "ghostty-launcher", path: config.ghosttyLauncherRepo },
		{ label: "config", path: resolveConfigRepo(config) },
	];

	const results: RepoParityResult[] = [];
	for (const repo of repos) {
		if (!(await fileExists(repo.path))) {
			results.push({
				repo: repo.label,
				ok: false,
				issues: [`${repo.label}: repo not found at ${repo.path}`],
			});
			continue;
		}
		results.push(await readRepoParity(repo.label, repo.path));
	}

	const finishedAtMs = Date.now();
	const issues = results.flatMap(result => result.issues);
	const summary = JSON.stringify(results, null, 2);
	if (issues.length === 0) {
		return buildRecord(
			"hub repo parity",
			"passed",
			startedAtMs,
			finishedAtMs,
			"git status --porcelain && git rev-list --left-right --count origin/main...HEAD",
			config.commandCentralRepo,
			summary,
		);
	}
	return buildRecord(
		"hub repo parity",
		"failed",
		startedAtMs,
		finishedAtMs,
		"git status --porcelain && git rev-list --left-right --count origin/main...HEAD",
		config.commandCentralRepo,
		summary,
		issues.join("\n"),
	);
}

async function readPackageRepoUrl(repo: string): Promise<string> {
	const raw = await fs.readFile(path.join(repo, "package.json"), "utf8");
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null) return "";
	const repository = (parsed as Record<string, unknown>)["repository"];
	if (typeof repository === "string") return repository;
	if (typeof repository === "object" && repository !== null) {
		const url = (repository as Record<string, unknown>)["url"];
		if (typeof url === "string") return url;
	}
	return "";
}

async function runPushTargetCheck(config: GateConfig): Promise<CheckRecord> {
	const startedAtMs = Date.now();
	const remote = config.pushRemote ?? "origin";
	const commandLabel = `git remote get-url ${remote}`;

	let packageRepoUrl = "";
	try {
		packageRepoUrl = await readPackageRepoUrl(config.commandCentralRepo);
	} catch (error) {
		const finishedAtMs = Date.now();
		return buildRecord(
			"release push-target identity",
			"failed",
			startedAtMs,
			finishedAtMs,
			commandLabel,
			config.commandCentralRepo,
			undefined,
			`Failed to read package.json repository: ${(error as Error).message}`,
		);
	}

	const remoteResult = await runCommand(
		["git", "remote", "get-url", remote],
		config.commandCentralRepo,
	);
	if (remoteResult.exitCode !== 0) {
		const finishedAtMs = Date.now();
		return buildRecord(
			"release push-target identity",
			"failed",
			startedAtMs,
			finishedAtMs,
			commandLabel,
			config.commandCentralRepo,
			remoteResult.output,
			`git remote get-url ${remote} exited with ${remoteResult.exitCode}`,
		);
	}

	const result = evaluatePushTarget({
		remote,
		remoteUrl: remoteResult.output,
		packageRepoUrl,
	});
	const finishedAtMs = Date.now();
	const summary = JSON.stringify(result, null, 2);
	if (result.ok) {
		return buildRecord(
			"release push-target identity",
			"passed",
			startedAtMs,
			finishedAtMs,
			commandLabel,
			config.commandCentralRepo,
			summary,
		);
	}
	return buildRecord(
		"release push-target identity",
		"failed",
		startedAtMs,
		finishedAtMs,
		commandLabel,
		config.commandCentralRepo,
		summary,
		result.issues.join("\n"),
	);
}

async function runGate(config: GateConfig): Promise<GateReport> {
	const checks: CheckRecord[] = [];
	const ccSha = await getGitSha(config.commandCentralRepo);
	const launcherSha = await getGitSha(config.ghosttyLauncherRepo);

	const runStep = async (
		name: string,
		command: string[],
		cwd: string,
	): Promise<void> => {
		const startedAtMs = Date.now();
		const result = await runCommand(command, cwd);
		const finishedAtMs = Date.now();
		if (result.exitCode === 0) {
			checks.push(
				buildRecord(
					name,
					"passed",
					startedAtMs,
					finishedAtMs,
					command.join(" "),
					cwd,
					result.output,
				),
			);
			return;
		}

		checks.push(
			buildRecord(
				name,
				"failed",
				startedAtMs,
				finishedAtMs,
				command.join(" "),
				cwd,
				result.output,
				`Command exited with ${result.exitCode}`,
			),
		);
		throw new GateError(`${name} failed:\n${result.output}`, [...checks]);
	};

	if (config.requireNodeReadiness) {
		const nodeReadinessCheck = await runNodeReadinessCheck(config);
		checks.push(nodeReadinessCheck);
		if (nodeReadinessCheck.status === "failed") {
			throw new GateError(
				`openclaw node readiness failed:\n${
					nodeReadinessCheck.error ?? nodeReadinessCheck.output ?? ""
				}`,
				[...checks],
			);
		}
	}

	if (config.requireDaemonSmoke) {
		const daemonSmokeCheck = await runDaemonSmokeCheck(config);
		checks.push(daemonSmokeCheck);
		if (daemonSmokeCheck.status === "failed") {
			throw new GateError(
				`openclaw daemon smoke failed:\n${
					daemonSmokeCheck.error ?? daemonSmokeCheck.output ?? ""
				}`,
				[...checks],
			);
		}
	}

	if (config.requireRepoParity) {
		const repoParityCheck = await runRepoParityCheck(config);
		checks.push(repoParityCheck);
		if (repoParityCheck.status === "failed") {
			throw new GateError(
				`hub repo parity failed:\n${
					repoParityCheck.error ?? repoParityCheck.output ?? ""
				}`,
				[...checks],
			);
		}
	}

	if (config.requirePushTarget) {
		const pushTargetCheck = await runPushTargetCheck(config);
		checks.push(pushTargetCheck);
		if (pushTargetCheck.status === "failed") {
			throw new GateError(
				`release push-target identity failed:\n${
					pushTargetCheck.error ?? pushTargetCheck.output ?? ""
				}`,
				[...checks],
			);
		}
	}

	if (config.skipCcValidation) {
		const ts = Date.now();
		checks.push(buildRecord("command-central validation", "skipped", ts, ts));
	} else {
		await runStep(
			"command-central validation",
			["just", "ci"],
			config.commandCentralRepo,
		);
	}

	if (config.skipLauncherValidation) {
		const ts = Date.now();
		checks.push(buildRecord("ghostty-launcher validation", "skipped", ts, ts));
	} else {
		await runStep(
			"ghostty-launcher validation",
			["just", "check"],
			config.ghosttyLauncherRepo,
		);
	}

	const contractStart = Date.now();
	try {
		const steerScript = path.join(
			config.ghosttyLauncherRepo,
			"scripts",
			"oste-steer.sh",
		);
		const [
			extensionSource,
			agentRegistryCommandsSource,
			terminalManagerSource,
			launcherHelp,
			steerHelp,
		] = await Promise.all([
			fs.readFile(
				path.join(config.commandCentralRepo, "src/extension.ts"),
				"utf8",
			),
			// Capture/kill helper resolution lives in the agent registry
			// activation module; absence degrades to the helper-call contract
			// failing below rather than an unreadable-file crash.
			fs
				.readFile(
					path.join(
						config.commandCentralRepo,
						"src/activation/register-agent-registry-commands.ts",
					),
					"utf8",
				)
				.catch(() => ""),
			fs.readFile(
				path.join(config.commandCentralRepo, "src/ghostty/TerminalManager.ts"),
				"utf8",
			),
			runCommand(
				[config.launcherBinary, "--help"],
				config.ghosttyLauncherRepo,
			),
			runCommand([steerScript, "--help"], config.ghosttyLauncherRepo),
		]);

		if (launcherHelp.exitCode !== 0) {
			throw new Error(
				`launcher --help failed (${launcherHelp.exitCode}): ${launcherHelp.output}`,
			);
		}
		if (steerHelp.exitCode !== 0) {
			throw new Error(
				`oste-steer.sh --help failed (${steerHelp.exitCode}): ${steerHelp.output}`,
			);
		}

		const contractIssues = [
			...validateLauncherContract(
				terminalManagerSource,
				launcherHelp.output,
				`${extensionSource}\n${agentRegistryCommandsSource}`,
			),
			...validateSteerContract(terminalManagerSource, steerHelp.output),
		];
		if (contractIssues.length > 0) {
			throw new Error(contractIssues.join("\n"));
		}

		await runStep(
			"launcher cli parse-name sanity",
			[config.launcherBinary, "--parse-name", config.commandCentralRepo],
			config.ghosttyLauncherRepo,
		);
		await runStep(
			"launcher cli parse-icon sanity",
			[config.launcherBinary, "--parse-icon", config.commandCentralRepo],
			config.ghosttyLauncherRepo,
		);
		await runStep(
			"launcher cli session-id sanity",
			[config.launcherBinary, "--session-id", config.commandCentralRepo],
			config.ghosttyLauncherRepo,
		);

		const contractEnd = Date.now();
		checks.push(
			buildRecord(
				"cross-repo launcher contract",
				"passed",
				contractStart,
				contractEnd,
				`${config.launcherBinary} --help`,
				config.ghosttyLauncherRepo,
			),
		);
	} catch (error) {
		const contractEnd = Date.now();
		checks.push(
			buildRecord(
				"cross-repo launcher contract",
				"failed",
				contractStart,
				contractEnd,
				`${config.launcherBinary} --help`,
				config.ghosttyLauncherRepo,
				undefined,
				(error as Error).message,
			),
		);
		throw new GateError((error as Error).message, [...checks]);
	}

	return {
		version: 1,
		generatedAt: nowIso(),
		commandCentral: {
			repo: config.commandCentralRepo,
			sha: ccSha,
		},
		ghosttyLauncher: {
			repo: config.ghosttyLauncherRepo,
			sha: launcherSha,
			launcherBinary: config.launcherBinary,
		},
		checks,
		success: checks.every(check => check.status !== "failed"),
	};
}

export {
	evaluateDaemonSmoke,
	evaluatePushTarget,
	evaluateRepoParity,
	extractFlagsFromHelp,
	extractSessionFlagsFromTerminalManager,
	extractSteerInvocationArgBlocks,
	extractSteerInvocationContract,
	normalizeGitHubRemote,
	parseArgs,
	runDaemonSmokeCheck,
	runGate,
	runNodeReadinessCheck,
	runPushTargetCheck,
	runRepoParityCheck,
	validateLauncherContract,
	validateSteerContract,
};

if (import.meta.main) {
	const config = parseArgs();
	let report: GateReport | null = null;
	try {
		report = await runGate(config);
	} catch (error) {
		if (!report) {
			const failedChecks =
				error instanceof GateError ? error.checks : [];
			report = {
				version: 1,
				generatedAt: nowIso(),
				commandCentral: {
					repo: config.commandCentralRepo,
					sha: await getGitSha(config.commandCentralRepo).catch(() => "unknown"),
				},
				ghosttyLauncher: {
					repo: config.ghosttyLauncherRepo,
					sha: await getGitSha(config.ghosttyLauncherRepo).catch(() => "unknown"),
					launcherBinary: config.launcherBinary,
				},
				checks: failedChecks,
				success: false,
			};
		}

		const artifactPath = await writeReport(config, report);
		console.error(`\n❌ prerelease gate failed`);
		console.error(`Artifact: ${artifactPath}`);
		console.error((error as Error).message);
		process.exit(1);
	}

	const artifactPath = await writeReport(config, report);
	console.log("\n✅ prerelease gate passed");
	console.log(`Artifact: ${artifactPath}`);
}
