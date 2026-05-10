#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import { assertNodeExecutionContext } from "../../scripts-v2/node-execution-guard.js";

export type InstalledVsixProofMode = "passive" | "live";

export interface InstalledVsixProofArgs {
	mode: InstalledVsixProofMode;
	vsixPath?: string;
	expectedSha256?: string;
}

export interface VsixResolutionInput {
	cliVsixPath?: string;
	envVsixPath?: string;
	repoRoot: string;
	packageVersion: string;
}

export function resolveInstalledProofVsixPath(
	input: VsixResolutionInput,
): string {
	const requested =
		input.cliVsixPath?.trim() ||
		input.envVsixPath?.trim() ||
		path.join(
			input.repoRoot,
			"releases",
			`command-central-${input.packageVersion}.vsix`,
		);
	return path.resolve(input.repoRoot, requested);
}

export function parseInstalledProofArgs(
	argv: string[],
): InstalledVsixProofArgs {
	const parsed: InstalledVsixProofArgs = {
		mode: process.env["COMMAND_CENTRAL_REQUIRED_TASK_ID"] ? "live" : "passive",
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--vsix") {
			const value = argv[index + 1];
			if (!value) throw new Error("--vsix requires a path.");
			parsed.vsixPath = value;
			index += 1;
			continue;
		}
		if (arg === "--expected-sha") {
			const value = argv[index + 1];
			if (!value) throw new Error("--expected-sha requires a SHA256 value.");
			parsed.expectedSha256 = value;
			index += 1;
			continue;
		}
		if (arg === "--live") {
			parsed.mode = "live";
			continue;
		}
		if (arg === "--passive") {
			parsed.mode = "passive";
			continue;
		}
		throw new Error(`Unknown installed proof argument: ${arg}`);
	}
	return parsed;
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) return `${durationMs.toFixed(0)}ms`;
	return `${(durationMs / 1000).toFixed(2)}s`;
}

async function buildProofSuite(outdir: string): Promise<string> {
	const result = await Bun.build({
		entrypoints: [path.join(import.meta.dir, "installed-vsix-proof-suite.ts")],
		outdir,
		target: "node",
		format: "cjs",
		external: ["vscode"],
		naming: {
			entry: "index.js",
		},
	});

	if (result.success) return path.join(outdir, "index.js");
	for (const log of result.logs) console.error(log.message);
	throw new Error("Failed to build installed-VSIX proof suite.");
}

async function createHarnessExtension(extensionDir: string): Promise<void> {
	await mkdir(path.join(extensionDir, "dist"), { recursive: true });
	await writeFile(
		path.join(extensionDir, "package.json"),
		JSON.stringify(
			{
				name: "command-central-installed-proof-harness",
				publisher: "oste-test",
				version: "0.0.0",
				engines: { vscode: "^1.90.0" },
				activationEvents: ["*"],
				main: "./dist/extension.js",
			},
			null,
			2,
		),
	);
	await writeFile(
		path.join(extensionDir, "dist", "extension.js"),
		[
			"Object.defineProperty(exports, '__esModule', { value: true });",
			"function activate() { return { kind: 'installed-proof-harness' }; }",
			"function deactivate() {}",
			"exports.activate = activate;",
			"exports.deactivate = deactivate;",
		].join("\n"),
	);
}

async function createTestWorkspace(workspaceDir: string): Promise<void> {
	await mkdir(workspaceDir, { recursive: true });
	await writeFile(
		path.join(workspaceDir, "README.md"),
		"# Command Central Installed VSIX Proof Workspace\n",
	);
}

async function writeUserSettings(
	userDataDir: string,
	taskRegistryPath: string,
): Promise<void> {
	const settingsDir = path.join(userDataDir, "User");
	await mkdir(settingsDir, { recursive: true });
	await writeFile(
		path.join(settingsDir, "settings.json"),
		JSON.stringify(
			{
				"commandCentral.agentTasksFile": taskRegistryPath,
				"commandCentral.agentTasksFiles": [],
			},
			null,
			2,
		),
	);
}

function buildLaunchArgs(params: {
	workspaceDir: string;
	userDataDir: string;
	extensionsDir: string;
}): string[] {
	const launchArgs = [
		params.workspaceDir,
		"--disable-workspace-trust",
		"--skip-welcome",
		"--skip-release-notes",
		"--user-data-dir",
		params.userDataDir,
		"--extensions-dir",
		params.extensionsDir,
	];
	if (process.platform === "linux") {
		launchArgs.push("--disable-gpu", "--no-sandbox");
	}
	return launchArgs;
}

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	hash.update(await readFile(filePath));
	return hash.digest("hex");
}

interface VsixManifestPackage {
	name: string;
	publisher: string;
	version: string;
}

function readVsixManifestPackage(vsixPath: string): VsixManifestPackage {
	const raw = execFileSync(
		"unzip",
		["-p", vsixPath, "extension/package.json"],
		{
			encoding: "utf8",
		},
	);
	const manifest = JSON.parse(raw) as Partial<VsixManifestPackage>;
	if (!manifest.publisher || !manifest.name || !manifest.version) {
		throw new Error(
			`VSIX package.json must include publisher, name, and version: ${vsixPath}`,
		);
	}
	return {
		name: manifest.name,
		publisher: manifest.publisher,
		version: manifest.version,
	};
}

async function installVsix(params: {
	vsixPath: string;
	extensionsDir: string;
}): Promise<void> {
	const manifest = readVsixManifestPackage(params.vsixPath);
	const installDir = path.join(
		params.extensionsDir,
		`${manifest.publisher}.${manifest.name}-${manifest.version}`,
	);
	const unpackDir = await mkdtemp(
		path.join(params.extensionsDir, ".unpack-command-central-"),
	);
	try {
		execFileSync(
			"unzip",
			["-q", params.vsixPath, "extension/*", "-d", unpackDir],
			{ encoding: "utf8" },
		);
		await rm(installDir, { recursive: true, force: true });
		await rename(path.join(unpackDir, "extension"), installDir);
	} finally {
		await rm(unpackDir, { recursive: true, force: true });
	}
}

function readVsixManifestVersion(vsixPath: string): string {
	return readVsixManifestPackage(vsixPath).version;
}

function gitCommit(repoRoot: string): string {
	return execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repoRoot,
		encoding: "utf8",
	}).trim();
}

function taskRegistryPath(): string {
	return (
		process.env["COMMAND_CENTRAL_TASK_REGISTRY_PATH"] ??
		path.join(os.homedir(), ".config", "ghostty-launcher", "tasks.json")
	);
}

async function readManifestSummary(manifestPath: string): Promise<{
	installedVersion: string;
	taskCount: number;
	roots: string[];
	mode: string;
	actionsPassed: number;
	actionsSkipped: number;
}> {
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		installed_version: string;
		mode: string;
		tree_snapshot: { taskCount: number; roots: Array<{ label: string }> };
		actions: Array<{ status: string }>;
	};
	return {
		installedVersion: manifest.installed_version,
		taskCount: manifest.tree_snapshot.taskCount,
		roots: manifest.tree_snapshot.roots
			.map((root) => root.label)
			.filter((label) => label.startsWith("Symphony /")),
		mode: manifest.mode,
		actionsPassed: manifest.actions.filter(
			(action) => action.status === "passed",
		).length,
		actionsSkipped: manifest.actions.filter(
			(action) => action.status === "skipped",
		).length,
	};
}

export async function runInstalledVsixAgentStatusProof(): Promise<void> {
	assertNodeExecutionContext();

	const repoRoot = path.resolve(import.meta.dir, "../..");
	const args = parseInstalledProofArgs(Bun.argv.slice(2));
	const packageJson = JSON.parse(
		await readFile(path.join(repoRoot, "package.json"), "utf8"),
	) as { publisher: string; name: string; version: string };
	const extensionId = `${packageJson.publisher}.${packageJson.name}`;
	const vsixPath = resolveInstalledProofVsixPath({
		cliVsixPath: args.vsixPath,
		envVsixPath: process.env["COMMAND_CENTRAL_VSIX_PATH"],
		repoRoot,
		packageVersion: packageJson.version,
	});
	const manifestVersion = readVsixManifestVersion(vsixPath);
	const vsixSha256 = await sha256File(vsixPath);
	const expectedVsixSha256 =
		args.expectedSha256?.trim() ||
		process.env["COMMAND_CENTRAL_EXPECTED_VSIX_SHA256"]?.trim() ||
		"";
	const registryPath = taskRegistryPath();
	const requestedVersion = process.env["VSCODE_VERSION"];
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cc-installed-proof-"));
	const workspaceDir = path.join(tempRoot, "workspace");
	const userDataDir = path.join(tempRoot, "user-data");
	const extensionsDir = path.join(tempRoot, "extensions");
	const suiteOutdir = path.join(tempRoot, "suite");
	const harnessExtensionDir = path.join(tempRoot, "harness-extension");
	const defaultManifestPath = path.join(
		repoRoot,
		"logs",
		`installed-vsix-agent-status-proof-${Date.now()}.json`,
	);
	const manifestPath =
		process.env["COMMAND_CENTRAL_PROOF_MANIFEST"] ?? defaultManifestPath;

	try {
		await mkdir(suiteOutdir, { recursive: true });
		await mkdir(extensionsDir, { recursive: true });
		await mkdir(path.dirname(manifestPath), { recursive: true });
		await createTestWorkspace(workspaceDir);
		await writeUserSettings(userDataDir, registryPath);
		await createHarnessExtension(harnessExtensionDir);
		const extensionTestsPath = await buildProofSuite(suiteOutdir);
		const vscodeExecutablePath = requestedVersion
			? await downloadAndUnzipVSCode(requestedVersion)
			: await downloadAndUnzipVSCode();
		await installVsix({ vsixPath, extensionsDir });

		const start = performance.now();
		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath: harnessExtensionDir,
			extensionTestsPath,
			launchArgs: buildLaunchArgs({
				workspaceDir,
				userDataDir,
				extensionsDir,
			}),
			extensionTestsEnv: {
				CI: process.env["CI"] ?? "false",
				COMMAND_CENTRAL_EXTENSION_ID: extensionId,
				COMMAND_CENTRAL_EXPECTED_VERSION: manifestVersion,
				COMMAND_CENTRAL_EXPECTED_VSIX_SHA256: expectedVsixSha256,
				COMMAND_CENTRAL_PROOF_COMMIT: gitCommit(repoRoot),
				COMMAND_CENTRAL_PROOF_MANIFEST: manifestPath,
				COMMAND_CENTRAL_PROOF_MODE: args.mode,
				COMMAND_CENTRAL_REPO_ROOT: repoRoot,
				COMMAND_CENTRAL_REQUIRED_TASK_ID:
					process.env["COMMAND_CENTRAL_REQUIRED_TASK_ID"] ?? "",
				COMMAND_CENTRAL_TASK_REGISTRY_PATH: registryPath,
				COMMAND_CENTRAL_TEST_MODE: "1",
				COMMAND_CENTRAL_VSIX_PROOF_PATH: vsixPath,
				COMMAND_CENTRAL_VSIX_SHA256: vsixSha256,
			},
		});

		const summary = await readManifestSummary(manifestPath);
		console.log("");
		console.log("installed-vsix-agent-status-proof-ok");
		console.log(`version: ${summary.installedVersion}`);
		console.log(`task count: ${summary.taskCount}`);
		console.log(`symphony roots: ${summary.roots.join(" | ")}`);
		console.log(`mode: ${summary.mode}`);
		console.log(
			`actions: ${summary.actionsPassed} passed / ${summary.actionsSkipped} skipped`,
		);
		console.log(`manifest: ${manifestPath}`);
		console.log(`duration: ${formatDuration(performance.now() - start)}`);
	} finally {
		if (!process.env["COMMAND_CENTRAL_KEEP_PROOF_TEMP"]) {
			await rm(tempRoot, { recursive: true, force: true });
		}
	}
}

if (import.meta.main) {
	runInstalledVsixAgentStatusProof().catch((error) => {
		console.error("installed-vsix-agent-status-proof-failed");
		console.error(
			error instanceof Error ? error.stack || error.message : String(error),
		);
		process.exit(1);
	});
}
