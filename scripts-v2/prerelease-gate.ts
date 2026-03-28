#!/usr/bin/env bun

import { spawn } from "bun";
import * as fs from "node:fs/promises";
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
	};
}

function nowIso(): string {
	return new Date().toISOString();
}

async function runCommand(
	command: string[],
	cwd: string,
): Promise<{ exitCode: number; output: string }> {
	const proc = spawn(command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;

	return {
		exitCode: proc.exitCode ?? -1,
		output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
	};
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

function validateLauncherContract(
	terminalManagerSource: string,
	launcherHelpText: string,
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

	if (config.skipCcValidation) {
		const ts = Date.now();
		checks.push(buildRecord("command-central validation", "skipped", ts, ts));
	} else {
		await runStep(
			"command-central validation",
			["just", "verify"],
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
		const [terminalManagerSource, launcherHelp] = await Promise.all([
			fs.readFile(
				path.join(config.commandCentralRepo, "src/ghostty/TerminalManager.ts"),
				"utf8",
			),
			runCommand([config.launcherBinary, "--help"], config.ghosttyLauncherRepo),
		]);

		if (launcherHelp.exitCode !== 0) {
			throw new Error(
				`launcher --help failed (${launcherHelp.exitCode}): ${launcherHelp.output}`,
			);
		}

		const contractIssues = validateLauncherContract(
			terminalManagerSource,
			launcherHelp.output,
		);
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
	extractFlagsFromHelp,
	extractSessionFlagsFromTerminalManager,
	validateLauncherContract,
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
