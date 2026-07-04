#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
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
import {
	expandedDefaultLaneRegistryPaths,
	type InstalledVsixProofPhase,
	type LauncherRegistryProofSnapshot,
	type LauncherTaskIdHit,
} from "./installed-vsix-proof-shared.js";

export type InstalledVsixProofMode = "passive" | "live";
export type InstalledVsixProofPhaseSelection = InstalledVsixProofPhase | "both";
export type ExpectedVsixIdentityKind =
	| "published-prerelease"
	| "temporary-proof-artifact";

export interface InstalledVsixProofArgs {
	mode: InstalledVsixProofMode;
	phase: InstalledVsixProofPhaseSelection;
	vsixPath?: string;
	expectedSha256?: string;
	expectedIdentityKind?: ExpectedVsixIdentityKind;
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
		phase: "both",
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
		if (arg === "--identity-kind") {
			const value = argv[index + 1];
			if (
				value !== "published-prerelease" &&
				value !== "temporary-proof-artifact"
			) {
				throw new Error(
					"--identity-kind must be published-prerelease or temporary-proof-artifact.",
				);
			}
			parsed.expectedIdentityKind = value;
			index += 1;
			continue;
		}
		if (arg === "--phase") {
			const value = argv[index + 1];
			if (
				value !== "quarantine-default" &&
				value !== "legacy-fixture" &&
				value !== "both"
			) {
				throw new Error(
					"--phase must be quarantine-default, legacy-fixture, or both.",
				);
			}
			parsed.phase = value;
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

/**
 * Sentinel launcher registry injected through the legacy escape hatch. Two
 * tasks with distinct agent backends so the proof never depends on a single
 * backend's rendering path.
 */
export function buildSentinelFixtureRegistry(nowIso: string): {
	registry: { version: 2; tasks: Record<string, Record<string, unknown>> };
	taskIds: string[];
} {
	const makeTask = (id: string, agentBackend: string) => ({
		id,
		status: "running",
		project_dir: `/tmp/cc-installed-proof/${id}`,
		project_name: `Installed Proof ${agentBackend}`,
		session_id: `${id}-session`,
		agent_backend: agentBackend,
		bundle_path: "",
		prompt_file: "",
		started_at: nowIso,
		updated_at: nowIso,
		attempts: 1,
		max_attempts: 3,
	});
	const tasks = {
		"installed-proof-legacy-alpha": makeTask(
			"installed-proof-legacy-alpha",
			"claude",
		),
		"installed-proof-legacy-beta": makeTask(
			"installed-proof-legacy-beta",
			"codex",
		),
	};
	return { registry: { version: 2, tasks }, taskIds: Object.keys(tasks) };
}

/** Read task ids from a launcher registry without failing on absence. */
export function readRegistryTaskIdsSafe(filePath: string): string[] {
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
			tasks?: Record<string, unknown>;
		};
		return raw.tasks && typeof raw.tasks === "object"
			? Object.keys(raw.tasks)
			: [];
	} catch {
		return [];
	}
}

export interface RegistryTaskIdSplit {
	/** Ids carrying a Work Registry `project_ref.id` — admitted by default. */
	laneBacked: string[];
	/** Launcher-era ids without `project_ref` — quarantined by default. */
	stale: string[];
}

/**
 * Split a registry's task ids by the default ingest contract: under default
 * settings the extension reads the zero-config lane registries with the
 * `lane-records-only` filter, so LaneRef records (`project_ref.id`) may
 * legitimately surface while stale rows must stay quarantined.
 */
export function readRegistryTaskIdSplitSafe(
	filePath: string,
): RegistryTaskIdSplit {
	const split: RegistryTaskIdSplit = { laneBacked: [], stale: [] };
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
			tasks?: Record<string, unknown>;
		};
		if (!raw.tasks || typeof raw.tasks !== "object") return split;
		for (const [taskId, record] of Object.entries(raw.tasks)) {
			const projectRef =
				record && typeof record === "object"
					? (record as { project_ref?: { id?: unknown } }).project_ref
					: undefined;
			const laneBacked =
				typeof projectRef?.id === "string" && projectRef.id.trim() !== "";
			(laneBacked ? split.laneBacked : split.stale).push(taskId);
		}
		return split;
	} catch {
		return split;
	}
}

export function phaseManifestPath(
	basePath: string,
	phase: InstalledVsixProofPhase,
): string {
	const suffix = phase === "quarantine-default" ? "quarantine" : "legacy";
	return basePath.endsWith(".json")
		? `${basePath.slice(0, -5)}-${suffix}.json`
		: `${basePath}-${suffix}.json`;
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

/**
 * Quarantine phase: pristine defaults — no escape hatch, no explicit registry
 * paths. The zero-config lane registry defaults (lane-records-only bridges)
 * still apply, so LaneRef records may surface; stale rows must not.
 */
async function writeDefaultUserSettings(userDataDir: string): Promise<void> {
	const settingsDir = path.join(userDataDir, "User");
	await mkdir(settingsDir, { recursive: true });
	await writeFile(path.join(settingsDir, "settings.json"), "{}\n");
}

/** Legacy phase: explicit diagnostics escape hatch + fixture registry. */
async function writeLegacyUserSettings(
	userDataDir: string,
	taskRegistryPath: string,
): Promise<void> {
	const settingsDir = path.join(userDataDir, "User");
	await mkdir(settingsDir, { recursive: true });
	await writeFile(
		path.join(settingsDir, "settings.json"),
		JSON.stringify(
			{
				"commandCentral.legacyLauncherTasks.enabled": true,
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

/**
 * Every real registry the installed extension could read on this machine:
 * the zero-config default lane registries plus the legacy home-dir launcher
 * location (legacy escape hatch only). Used to sweep for stale ids that must
 * never surface as launcher data.
 */
function globalLaneAndLauncherRegistryPaths(): string[] {
	return [
		...expandedDefaultLaneRegistryPaths(os.homedir()),
		path.join(os.homedir(), ".ghostty-launcher", "tasks.json"),
	];
}

async function readManifestSummary(manifestPath: string): Promise<{
	phase: string;
	installedVersion: string;
	taskCount: number;
	roots: string[];
	mode: string;
	actionsPassed: number;
	actionsSkipped: number;
	launcherRegistry: LauncherRegistryProofSnapshot;
	forbiddenHits: LauncherTaskIdHit[];
	expectedPresence: Record<string, boolean>;
}> {
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		proof_phase: string;
		installed_version: string;
		mode: string;
		tree_snapshot: { taskCount: number; roots: Array<{ label: string }> };
		actions: Array<{ status: string }>;
		launcher_registry_snapshot: LauncherRegistryProofSnapshot;
		forbidden_launcher_task_id_hits: LauncherTaskIdHit[];
		expected_task_id_presence: Record<string, boolean>;
	};
	return {
		phase: manifest.proof_phase,
		installedVersion: manifest.installed_version,
		taskCount: manifest.tree_snapshot.taskCount,
		roots: manifest.tree_snapshot.roots.map((root) => root.label),
		mode: manifest.mode,
		actionsPassed: manifest.actions.filter(
			(action) => action.status === "passed",
		).length,
		actionsSkipped: manifest.actions.filter(
			(action) => action.status === "skipped",
		).length,
		launcherRegistry: manifest.launcher_registry_snapshot,
		forbiddenHits: manifest.forbidden_launcher_task_id_hits,
		expectedPresence: manifest.expected_task_id_presence,
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
	const expectedIdentityKind =
		args.expectedIdentityKind ??
		(process.env["COMMAND_CENTRAL_EXPECTED_VSIX_IDENTITY_KIND"] as
			| ExpectedVsixIdentityKind
			| undefined) ??
		(expectedVsixSha256 ? "temporary-proof-artifact" : "");
	const requestedVersion = process.env["VSCODE_VERSION"];
	// Deliberately /tmp, NOT os.tmpdir(): macOS caps AF_UNIX socket paths at
	// 103 bytes, and VS Code binds `<user-data-dir>/1.12-main.sock`. Under
	// the per-user `/var/folders/…/T/` tmpdir plus this proof's phase-named
	// user-data dirs the socket path overflows and Code aborts with
	// `listen EINVAL` before the extension host starts.
	const tempRoot = await mkdtemp("/tmp/cc-proof-");
	const workspaceDir = path.join(tempRoot, "workspace");
	const extensionsDir = path.join(tempRoot, "extensions");
	const suiteOutdir = path.join(tempRoot, "suite");
	const harnessExtensionDir = path.join(tempRoot, "harness-extension");
	const fixtureRegistryPath = path.join(tempRoot, "fixture", "tasks.json");
	const defaultManifestPath = path.join(
		repoRoot,
		"logs",
		`installed-vsix-agent-status-proof-${Date.now()}.json`,
	);
	const baseManifestPath =
		process.env["COMMAND_CENTRAL_PROOF_MANIFEST"] ?? defaultManifestPath;

	try {
		await mkdir(suiteOutdir, { recursive: true });
		await mkdir(extensionsDir, { recursive: true });
		await mkdir(path.dirname(baseManifestPath), { recursive: true });
		await mkdir(path.dirname(fixtureRegistryPath), { recursive: true });
		await createTestWorkspace(workspaceDir);
		await createHarnessExtension(harnessExtensionDir);

		const sentinel = buildSentinelFixtureRegistry(new Date().toISOString());
		await writeFile(
			fixtureRegistryPath,
			JSON.stringify(sentinel.registry, null, 2),
		);
		// Hermetic by default: the legacy phase reads the generated sentinel
		// fixture. Pointing at a real registry (e.g. for a live dogfood proof)
		// now requires the explicit env override.
		const registryPath =
			process.env["COMMAND_CENTRAL_TASK_REGISTRY_PATH"] ?? fixtureRegistryPath;
		const legacyRegistryIds = readRegistryTaskIdsSafe(registryPath);
		// Under default settings the extension legitimately ingests LaneRef
		// records (project_ref.id) from the zero-config lane registries, so the
		// forbidden sweep targets only stale launcher-era ids.
		const realRegistrySplits = globalLaneAndLauncherRegistryPaths().map(
			(registry) => readRegistryTaskIdSplitSafe(registry),
		);
		const realLaneBackedIds = new Set(
			realRegistrySplits.flatMap((split) => split.laneBacked),
		);
		const realStaleIds = [
			...new Set(realRegistrySplits.flatMap((split) => split.stale)),
		].filter((id) => !realLaneBackedIds.has(id));
		// Ids in the registry deliberately injected for the legacy phase are
		// expected there, never forbidden.
		const quarantineForbiddenIds = [
			...new Set([...realStaleIds, ...sentinel.taskIds]),
		];
		const legacyForbiddenIds = realStaleIds.filter(
			(id) => !legacyRegistryIds.includes(id),
		);
		const legacyExpectedIds =
			registryPath === fixtureRegistryPath ? sentinel.taskIds : [];
		if (realStaleIds.length === 0) {
			console.log(
				"note: no stale launcher-era ids found in real registries — quarantine id sweep will be vacuous on this machine.",
			);
		}

		const extensionTestsPath = await buildProofSuite(suiteOutdir);
		const vscodeExecutablePath = requestedVersion
			? await downloadAndUnzipVSCode(requestedVersion)
			: await downloadAndUnzipVSCode();
		await installVsix({ vsixPath, extensionsDir });

		const phases: InstalledVsixProofPhase[] =
			args.phase === "both"
				? ["quarantine-default", "legacy-fixture"]
				: [args.phase];

		const summaries: Array<
			Awaited<ReturnType<typeof readManifestSummary>> & {
				manifestPath: string;
				durationMs: number;
			}
		> = [];
		for (const phase of phases) {
			const userDataDir = path.join(tempRoot, `user-data-${phase}`);
			if (phase === "quarantine-default") {
				await writeDefaultUserSettings(userDataDir);
			} else {
				await writeLegacyUserSettings(userDataDir, registryPath);
			}
			const manifestPath = phaseManifestPath(baseManifestPath, phase);
			const phaseMode = phase === "quarantine-default" ? "passive" : args.mode;
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
					COMMAND_CENTRAL_EXPECTED_VSIX_IDENTITY_KIND: expectedIdentityKind,
					COMMAND_CENTRAL_EXPECTED_VSIX_SHA256: expectedVsixSha256,
					COMMAND_CENTRAL_EXPECTED_TASK_IDS: JSON.stringify(
						phase === "legacy-fixture" ? legacyExpectedIds : [],
					),
					COMMAND_CENTRAL_FORBIDDEN_TASK_IDS: JSON.stringify(
						phase === "quarantine-default"
							? quarantineForbiddenIds
							: legacyForbiddenIds,
					),
					COMMAND_CENTRAL_PROOF_COMMIT: gitCommit(repoRoot),
					COMMAND_CENTRAL_PROOF_MANIFEST: manifestPath,
					COMMAND_CENTRAL_PROOF_MODE: phaseMode,
					COMMAND_CENTRAL_PROOF_PHASE: phase,
					COMMAND_CENTRAL_REPO_ROOT: repoRoot,
					COMMAND_CENTRAL_REQUIRED_TASK_ID:
						phase === "legacy-fixture"
							? (process.env["COMMAND_CENTRAL_REQUIRED_TASK_ID"] ?? "")
							: "",
					COMMAND_CENTRAL_TASK_REGISTRY_PATH: registryPath,
					COMMAND_CENTRAL_TEST_MODE: "1",
					COMMAND_CENTRAL_VSIX_PROOF_PATH: vsixPath,
					COMMAND_CENTRAL_VSIX_SHA256: vsixSha256,
					// Never let an operator shell's TASKS_FILE leak into the proof —
					// the resolver honors it unconditionally.
					TASKS_FILE: "",
				},
			});
			summaries.push({
				...(await readManifestSummary(manifestPath)),
				manifestPath,
				durationMs: performance.now() - start,
			});
		}

		console.log("");
		console.log("installed-vsix-agent-status-proof-ok");
		for (const summary of summaries) {
			const registrySummary = summary.launcherRegistry.agentStatus;
			console.log("");
			console.log(`phase: ${summary.phase}`);
			console.log(`version: ${summary.installedVersion}`);
			console.log(`task count: ${summary.taskCount}`);
			console.log(
				`launcher registry: ${registrySummary.launcherTaskCount} task(s) from [${registrySummary.resolvedFilePaths.join(", ") || "none"}]`,
			);
			console.log(`forbidden launcher hits: ${summary.forbiddenHits.length}`);
			console.log(
				`expected ids visible: ${Object.values(summary.expectedPresence).filter(Boolean).length}/${Object.keys(summary.expectedPresence).length}`,
			);
			console.log(`symphony view roots: ${summary.roots.join(" | ")}`);
			console.log(`mode: ${summary.mode}`);
			console.log(
				`actions: ${summary.actionsPassed} passed / ${summary.actionsSkipped} skipped`,
			);
			console.log(`manifest: ${summary.manifestPath}`);
			console.log(`duration: ${formatDuration(summary.durationMs)}`);
		}
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
