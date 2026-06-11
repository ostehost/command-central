#!/usr/bin/env bun

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) return `${durationMs.toFixed(0)}ms`;
	return `${(durationMs / 1000).toFixed(2)}s`;
}

async function buildIntegrationSuite(outdir: string): Promise<string> {
	const result = await Bun.build({
		entrypoints: [path.join(import.meta.dir, "suite", "index.ts")],
		outdir,
		target: "node",
		format: "cjs",
		external: ["vscode"],
		naming: {
			entry: "index.js",
		},
	});

	if (result.success) {
		return path.join(outdir, "index.js");
	}

	for (const log of result.logs) {
		console.error(log.message);
	}

	throw new Error("Failed to build the real-VS-Code integration suite.");
}

async function createTestWorkspace(workspaceDir: string): Promise<void> {
	await mkdir(workspaceDir, { recursive: true });
	await writeFile(
		path.join(workspaceDir, "README.md"),
		"# Command Central Integration Test Workspace\n",
	);
}

/**
 * Write a launcher task registry with one fresh `running` task, exposed to
 * the extension host via TASKS_FILE (highest-priority resolution).
 *
 * Field choices keep the truth hierarchy trusting the registry status for
 * the whole run: `session_id` is required by the registry normalizer, while
 * `terminal_backend: "applescript"` routes liveness through the
 * non-tmux/non-persist branch, where a launch-time `started_at` (far under
 * the one-hour staleness floor) means "healthy". This makes the agent
 * status bar deterministically render a working count, letting the
 * infrastructure-health scenario assert the CC-001 invariant — a
 * demonstrably alive task service forbids a DOWN render — against the real
 * providers in a live extension host.
 */
async function writeFixtureTasksFile(fixtureTasksFile: string): Promise<void> {
	const now = new Date().toISOString();
	await mkdir(path.dirname(fixtureTasksFile), { recursive: true });
	await writeFile(
		fixtureTasksFile,
		`${JSON.stringify(
			{
				version: 2,
				tasks: {
					"cc001-proof-working-task": {
						id: "cc001-proof-working-task",
						status: "running",
						project_name: "cc001-integration-proof",
						project_dir: "/tmp/cc001-integration-proof",
						session_id: "cc001-proof-session",
						terminal_backend: "applescript",
						agent_backend: "integration-proof-backend",
						prompt_file: "",
						bundle_path: "(test-mode)",
						created_at: now,
						started_at: now,
						updated_at: now,
						attempts: 1,
						max_attempts: 1,
					},
				},
			},
			null,
			2,
		)}\n`,
	);
}

async function readExtensionId(
	extensionDevelopmentPath: string,
): Promise<string> {
	const packageJson = JSON.parse(
		await readFile(path.join(extensionDevelopmentPath, "package.json"), "utf8"),
	) as { name: string; publisher: string };
	return `${packageJson.publisher}.${packageJson.name}`;
}

function buildLaunchArgs(params: {
	workspaceDir: string;
	userDataDir: string;
	extensionsDir: string;
}): string[] {
	const launchArgs = [
		params.workspaceDir,
		"--disable-extensions",
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

export async function runIntegrationTests(): Promise<void> {
	console.log("🧪 Command Central real-VS-Code integration tests");
	console.log("=".repeat(60));

	const extensionDevelopmentPath = path.resolve(import.meta.dir, "../..");
	const requestedVersion = process.env["VSCODE_VERSION"];
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cc-vsc-"));
	const workspaceDir = path.join(tempRoot, "w");
	const userDataDir = path.join(tempRoot, "u");
	const extensionsDir = path.join(tempRoot, "e");
	const suiteOutdir = path.join(tempRoot, "s");

	try {
		console.log("\n📋 Step 1: Building extension");
		console.log("-".repeat(60));
		const buildResult = await Bun.$`bun run build`.quiet();
		if (buildResult.exitCode !== 0) {
			throw new Error(
				buildResult.stderr.toString() || "Extension build failed.",
			);
		}
		console.log("✅ Extension built successfully");

		console.log("\n📋 Step 2: Preparing VS Code test assets");
		console.log("-".repeat(60));
		await mkdir(suiteOutdir, { recursive: true });
		await mkdir(userDataDir, { recursive: true });
		await mkdir(extensionsDir, { recursive: true });
		await createTestWorkspace(workspaceDir);
		const fixtureTasksFile = path.join(tempRoot, "fixtures", "tasks.json");
		await writeFixtureTasksFile(fixtureTasksFile);
		const extensionTestsPath = await buildIntegrationSuite(suiteOutdir);
		const extensionId = await readExtensionId(extensionDevelopmentPath);
		console.log(`✅ Suite bundled to ${extensionTestsPath}`);
		console.log(`✅ Extension id: ${extensionId}`);

		console.log("\n📋 Step 3: Downloading VS Code");
		console.log("-".repeat(60));
		const vscodeExecutablePath = requestedVersion
			? await downloadAndUnzipVSCode(requestedVersion)
			: await downloadAndUnzipVSCode();
		console.log(`✅ VS Code ready at ${vscodeExecutablePath}`);

		console.log("\n📋 Step 4: Running real-VS-Code scenarios");
		console.log("-".repeat(60));
		const start = performance.now();
		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: buildLaunchArgs({
				workspaceDir,
				userDataDir,
				extensionsDir,
			}),
			extensionTestsEnv: {
				CI: process.env["CI"] ?? "false",
				COMMAND_CENTRAL_EXTENSION_ID: extensionId,
				COMMAND_CENTRAL_TEST_MODE: "1",
				TEST_VERSION: requestedVersion ?? "stable",
				// Deterministic launcher registry for the host (resolution
				// priority #1) — see writeFixtureTasksFile.
				TASKS_FILE: fixtureTasksFile,
			},
		});
		const durationMs = performance.now() - start;
		console.log(
			`✅ Real-VS-Code integration tests passed in ${formatDuration(durationMs)}`,
		);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	runIntegrationTests().catch((error) => {
		console.error("❌ Real-VS-Code integration tests failed");
		console.error(error);
		process.exit(1);
	});
}
