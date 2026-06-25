import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	evaluateDaemonSmoke,
	evaluatePushTarget,
	evaluateRepoParity,
	extractFlagsFromHelp,
	extractSessionFlagsFromTerminalManager,
	extractSteerInvocationContract,
	normalizeGitHubRemote,
	runDaemonSmokeCheck,
	runGate,
	runNodeReadinessCheck,
	runPushTargetCheck,
	validateLauncherContract,
	validateSteerContract,
} from "../../scripts-v2/prerelease-gate.ts";

function makeTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeExecutable(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
	fs.chmodSync(filePath, 0o755);
}

function initGitRepo(repo: string): void {
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd: repo,
	});
	fs.writeFileSync(path.join(repo, "README.md"), "test\n", "utf8");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["commit", "-q", "-m", "test: initial"], { cwd: repo });
}

function createGateFixture(): {
	root: string;
	commandCentralRepo: string;
	ghosttyLauncherRepo: string;
	launcherBinary: string;
	outputDir: string;
} {
	const root = makeTempDir("cc-prerelease-gate-");
	const commandCentralRepo = path.join(root, "command-central");
	const ghosttyLauncherRepo = path.join(root, "ghostty-launcher");
	const launcherBinary = path.join(ghosttyLauncherRepo, "launcher");
	const outputDir = path.join(root, "reports");

	fs.mkdirSync(path.join(commandCentralRepo, "src", "ghostty"), {
		recursive: true,
	});
	fs.mkdirSync(path.join(ghosttyLauncherRepo, "scripts"), { recursive: true });
	fs.writeFileSync(
		path.join(commandCentralRepo, "src", "extension.ts"),
		`
const capture = await terminalManager.resolveLauncherHelperScriptPath("oste-capture.sh");
const kill = await terminalManager.resolveLauncherHelperScriptPath("oste-kill.sh");
`,
		"utf8",
	);
	fs.writeFileSync(
		path.join(commandCentralRepo, "src", "ghostty", "TerminalManager.ts"),
		`
this.execLauncher(launcher, ["--create-bundle", workspaceRoot]);
this.execLauncher(launcher, ["--parse-name", workspaceRoot]);
this.execLauncher(launcher, ["--parse-icon", workspaceRoot]);
this.execLauncher(launcher, ["--session-id", workspaceRoot]);
// rc.31: extension delegates to launcher --send for all command delivery.
// Direct oste-steer.sh invocation is forbidden — the gate enforces this.
await this.execCommand(launcher, [
	"--send",
	projectDir,
	"--command",
	command,
]);
async resolveLauncherHelperScriptPath(scriptName: string): Promise<string> {
	const launcherPath = await this.resolvedLauncherPath();
	return path.join(path.dirname(launcherPath), "scripts", scriptName);
}
`,
		"utf8",
	);
	writeExecutable(
		launcherBinary,
		`#!/bin/bash
case "$1" in
  --help)
    echo "Options: --parse-icon DIR --parse-name DIR --create-bundle DIR --session-id DIR"
    ;;
  --parse-name|--parse-icon|--session-id)
    echo "ok"
    ;;
  *)
    echo "unexpected launcher args: $*" >&2
    exit 2
    ;;
esac
`,
	);
	writeExecutable(
		path.join(ghosttyLauncherRepo, "scripts", "oste-steer.sh"),
		`#!/bin/bash
if [[ "$1" == "--help" ]]; then
  cat <<'EOF'
Usage:
  oste-steer.sh <session-name> <text>
  oste-steer.sh <session-name> --ctrl-c
  oste-steer.sh --by-task-id <id> <text>

Options:
  --ctrl-c
  --no-enter
  --raw
  --by-task-id
  --help
EOF
  exit 0
fi
exit 0
`,
	);
	initGitRepo(commandCentralRepo);
	initGitRepo(ghosttyLauncherRepo);

	return {
		root,
		commandCentralRepo,
		ghosttyLauncherRepo,
		launcherBinary,
		outputDir,
	};
}

function createFakeOpenClawBin(root: string, statusJson: string): string {
	const binDir = path.join(root, "bin");
	const openClawBinary = path.join(binDir, "openclaw");
	writeExecutable(
		openClawBinary,
		`#!/bin/bash
if [[ "$1" == "--version" ]]; then
  echo "openclaw 2026.5.5 (test-build)"
  exit 0
fi
if [[ "$1" == "nodes" && "$2" == "status" && "$3" == "--json" ]]; then
  cat <<'JSON'
${statusJson}
JSON
  exit 0
fi
echo "unexpected openclaw invocation: $*" >&2
exit 9
`,
	);
	return openClawBinary;
}

function createReadinessGate(root: string): string {
	const gatePath = path.join(root, "openclaw-node-readiness-gate.mjs");
	writeExecutable(
		gatePath,
		`#!/usr/bin/env node
import { readFileSync } from "node:fs";
const inputIndex = process.argv.indexOf("--input");
const versionIndex = process.argv.indexOf("--expected-version");
const status = JSON.parse(readFileSync(process.argv[inputIndex + 1], "utf8"));
const expected = process.argv[versionIndex + 1];
const node = status.nodes?.find((candidate) => candidate.displayName === "Mike MacBook Pro");
const issues = [];
if (!node) issues.push("required_node_missing");
if (node && node.connected !== true) issues.push("required_node_disconnected");
if (node && node.version !== expected) issues.push(\`required_node_version_\${node.connected ? "mismatch" : "stale"}:\${node.version}:expected_\${expected}\`);
for (const command of ["system.run", "system.run.prepare", "system.which"]) {
  if (node && !node.commands?.includes(command)) issues.push(\`required_node_missing_command:\${command}\`);
}
console.log(JSON.stringify({ ok: issues.length === 0, issues }, null, 2));
process.exit(issues.length === 0 ? 0 : 2);
`,
	);
	return gatePath;
}

describe("extractFlagsFromHelp", () => {
	test("extracts launcher CLI flags from help text", () => {
		const help = `
Ghostty Launcher
Options:
  --parse-icon DIR
  --parse-name DIR
  --create-bundle DIR
  --session-id DIR
`;
		const flags = extractFlagsFromHelp(help);
		expect(flags.has("--parse-icon")).toBe(true);
		expect(flags.has("--parse-name")).toBe(true);
		expect(flags.has("--create-bundle")).toBe(true);
		expect(flags.has("--session-id")).toBe(true);
	});
});

describe("extractSessionFlagsFromTerminalManager", () => {
	test("detects session-id usage", () => {
		const source = `this.execLauncher(launcher, ["--session-id", workspaceRoot]);`;
		const flags = extractSessionFlagsFromTerminalManager(source);
		expect(flags.has("--session-id")).toBe(true);
		expect(flags.has("--tmux-session")).toBe(false);
	});

	test("detects legacy tmux-session usage", () => {
		const source = `this.execLauncher(launcher, ["--tmux-session", workspaceRoot]);`;
		const flags = extractSessionFlagsFromTerminalManager(source);
		expect(flags.has("--tmux-session")).toBe(true);
	});
});

describe("validateLauncherContract", () => {
	const validTerminalManagerSource = `
this.execLauncher(launcher, ["--create-bundle", workspaceRoot]);
this.execLauncher(launcher, ["--parse-name", workspaceRoot]);
this.execLauncher(launcher, ["--parse-icon", workspaceRoot]);
this.execLauncher(launcher, ["--session-id", workspaceRoot]);
async resolveLauncherHelperScriptPath(scriptName: string): Promise<string> {
	const launcherPath = await this.resolvedLauncherPath();
	return path.join(path.dirname(launcherPath), "scripts", scriptName);
}
`;
	const validExtensionSource = `
const capture = await terminalManager.resolveLauncherHelperScriptPath("oste-capture.sh");
const kill = await terminalManager.resolveLauncherHelperScriptPath("oste-kill.sh");
`;

	const validHelp = `
Options:
  --parse-icon DIR
  --parse-name DIR
  --create-bundle DIR
  --session-id DIR
`;

	test("returns no issues when contract is aligned", () => {
		expect(
			validateLauncherContract(
				validTerminalManagerSource,
				validHelp,
				validExtensionSource,
			),
		).toEqual([]);
	});

	test("fails when launcher help is missing session-id", () => {
		const helpMissingSession = `
Options:
  --parse-icon DIR
  --parse-name DIR
  --create-bundle DIR
`;
		const issues = validateLauncherContract(
			validTerminalManagerSource,
			helpMissingSession,
			validExtensionSource,
		);
		expect(issues.some((issue) => issue.includes("--session-id"))).toBe(true);
	});

	test("fails when TerminalManager regresses to tmux-session", () => {
		const regressedSource = `
this.execLauncher(launcher, ["--tmux-session", workspaceRoot]);
`;
		const issues = validateLauncherContract(
			regressedSource,
			validHelp,
			validExtensionSource,
		);
		expect(issues.some((issue) => issue.includes("--tmux-session"))).toBe(true);
	});

	test("fails when extension still resolves helpers from tasks.json directory", () => {
		const legacyExtensionSource = `
const scriptPath = path.join(path.dirname(tasksFilePath), "oste-capture.sh");
`;
		const issues = validateLauncherContract(
			validTerminalManagerSource,
			validHelp,
			legacyExtensionSource,
		);
		expect(
			issues.some((issue) => issue.includes("relative to tasks.json")),
		).toBe(true);
	});

	test("fails when helper resolution is missing for launcher-managed actions", () => {
		const partialExtensionSource = `
const capture = await terminalManager.resolveLauncherHelperScriptPath("oste-capture.sh");
`;
		const issues = validateLauncherContract(
			validTerminalManagerSource,
			validHelp,
			partialExtensionSource,
		);
		expect(issues.some((issue) => issue.includes("oste-kill.sh"))).toBe(true);
	});

	test("accepts multiline helper resolution calls from extension formatting", () => {
		const multilineExtensionSource = `
const capture =
	await terminalManager.resolveLauncherHelperScriptPath(
		"oste-capture.sh",
	);
const kill =
	await terminalManager.resolveLauncherHelperScriptPath(
		"oste-kill.sh",
	);
`;
		expect(
			validateLauncherContract(
				validTerminalManagerSource,
				validHelp,
				multilineExtensionSource,
			),
		).toEqual([]);
	});
});

describe("extractSteerInvocationContract", () => {
	test("detects positional session steering with raw mode", () => {
		const source = `
this.execCommand("oste-steer.sh", [
	info.tmuxSession,
	"--raw",
	command,
]);
`;
		expect(extractSteerInvocationContract(source)).toEqual({
			usesLegacySessionFlag: false,
			usesRawMode: true,
			usesPositionalSession: true,
		});
	});

	test("detects unsupported --session steering", () => {
		const source = `
this.execCommand("oste-steer.sh", [
	"--session",
	info.tmuxSession,
	"--raw",
	command,
]);
`;
		expect(extractSteerInvocationContract(source)).toEqual({
			usesLegacySessionFlag: true,
			usesRawMode: true,
			usesPositionalSession: false,
		});
	});
});

describe("validateSteerContract (rc.31 contract: delegation)", () => {
	// rc.31 inverted the contract: the extension MUST delegate to `launcher
	// --send <dir> --command <cmd>` and MUST NOT shell out to oste-steer.sh
	// directly. oste-steer.sh's own --help surface is still checked because
	// the launcher's --send tmux dispatch invokes it internally.
	const validTerminalManagerSource = `
const launcher = await this.resolvedLauncherPath();
await this.execCommand(launcher, [
	"--send",
	projectDir,
	"--command",
	command,
]);
`;

	const validSteerHelp = `
Usage:
  oste-steer.sh <session-name> <text>
  oste-steer.sh <session-name> --ctrl-c
  oste-steer.sh --by-task-id <id> <text>

Options:
  --ctrl-c
  --no-enter
  --raw
  --help
`;

	test("returns no issues when extension delegates via launcher --send", () => {
		expect(
			validateSteerContract(validTerminalManagerSource, validSteerHelp),
		).toEqual([]);
	});

	test("fails when oste-steer help is missing required flags", () => {
		const issues = validateSteerContract(
			validTerminalManagerSource,
			"Usage:\n  oste-steer.sh <session-name> <text>\n",
		);
		expect(issues.some((issue) => issue.includes("--raw"))).toBe(true);
		expect(issues.some((issue) => issue.includes("--by-task-id"))).toBe(true);
	});

	test("fails when Command Central source regresses to direct oste-steer.sh call", () => {
		const regressedSource = `
this.execCommand("oste-steer.sh", [
	info.tmuxSession,
	"--raw",
	command,
]);
${validTerminalManagerSource}
`;
		const issues = validateSteerContract(regressedSource, validSteerHelp);
		// A direct oste-steer.sh call sets usesRawMode + usesPositionalSession
		// to true; the new gate flags both as regressions.
		expect(issues.some((issue) => issue.includes("--raw"))).toBe(true);
		expect(issues.some((issue) => issue.includes("positional"))).toBe(true);
	});

	test("fails when launcher --send invocation is missing", () => {
		const sourceWithoutSend = `
this.execCommand(launcher, ["--parse-name", projectDir]);
`;
		const issues = validateSteerContract(sourceWithoutSend, validSteerHelp);
		expect(issues.some((issue) => issue.includes("--send"))).toBe(true);
		expect(issues.some((issue) => issue.includes("--command"))).toBe(true);
	});
});

describe("node readiness prerelease check", () => {
	const readyStatus = JSON.stringify({
		nodes: [
			{
				nodeId: "node-1",
				displayName: "Mike MacBook Pro",
				paired: true,
				connected: true,
				version: "2026.5.5",
				commands: ["system.run", "system.run.prepare", "system.which"],
			},
		],
	});

	const staleStatus = JSON.stringify({
		nodes: [
			{
				nodeId: "node-1",
				displayName: "Mike MacBook Pro",
				paired: true,
				connected: false,
				version: "2026.4.2",
				commands: ["system.run", "system.run.prepare", "system.which"],
			},
		],
	});

	test("default gate behavior skips node readiness", async () => {
		const fixture = createGateFixture();
		try {
			const report = await runGate({
				commandCentralRepo: fixture.commandCentralRepo,
				ghosttyLauncherRepo: fixture.ghosttyLauncherRepo,
				launcherBinary: fixture.launcherBinary,
				outputDir: fixture.outputDir,
				skipCcValidation: true,
				skipLauncherValidation: true,
				requireNodeReadiness: false,
				nodeReadinessGate: path.join(fixture.root, "missing-gate.mjs"),
				openClawBinary: "openclaw",
			});

			expect(report.success).toBe(true);
			expect(
				report.checks.some((check) => check.name === "openclaw node readiness"),
			).toBe(false);
		} finally {
			fs.rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("opt-in stale disconnected node fails before prerelease success", async () => {
		const fixture = createGateFixture();
		try {
			const openClawBinary = createFakeOpenClawBin(fixture.root, staleStatus);
			const readinessGate = createReadinessGate(fixture.root);

			let thrown: unknown;
			try {
				await runGate({
					commandCentralRepo: fixture.commandCentralRepo,
					ghosttyLauncherRepo: fixture.ghosttyLauncherRepo,
					launcherBinary: fixture.launcherBinary,
					outputDir: fixture.outputDir,
					skipCcValidation: true,
					skipLauncherValidation: true,
					requireNodeReadiness: true,
					nodeReadinessGate: readinessGate,
					openClawBinary,
				});
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeTruthy();
			const checks =
				(
					thrown as {
						checks?: Array<{ name: string; status: string; output?: string }>;
					}
				).checks ?? [];
			const readiness = checks.find(
				(check) => check.name === "openclaw node readiness",
			);
			expect(readiness?.status).toBe("failed");
			expect(readiness?.output).toContain("required_node_disconnected");
			expect(readiness?.output).toContain(
				"required_node_version_stale:2026.4.2:expected_2026.5.5",
			);
			expect(checks.map((check) => check.name)).toEqual([
				"openclaw node readiness",
			]);
		} finally {
			fs.rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("opt-in connected current node passes as a prerelease check", async () => {
		const fixture = createGateFixture();
		try {
			const openClawBinary = createFakeOpenClawBin(fixture.root, readyStatus);
			const readinessGate = createReadinessGate(fixture.root);

			const report = await runGate({
				commandCentralRepo: fixture.commandCentralRepo,
				ghosttyLauncherRepo: fixture.ghosttyLauncherRepo,
				launcherBinary: fixture.launcherBinary,
				outputDir: fixture.outputDir,
				skipCcValidation: true,
				skipLauncherValidation: true,
				requireNodeReadiness: true,
				nodeReadinessGate: readinessGate,
				openClawBinary,
			});

			const readiness = report.checks.find(
				(check) => check.name === "openclaw node readiness",
			);
			expect(report.success).toBe(true);
			expect(readiness?.status).toBe("passed");
			expect(readiness?.output).toContain('"ok": true');
		} finally {
			fs.rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("missing readiness gate is a clear failed check", async () => {
		const fixture = createGateFixture();
		try {
			const check = await runNodeReadinessCheck({
				commandCentralRepo: fixture.commandCentralRepo,
				ghosttyLauncherRepo: fixture.ghosttyLauncherRepo,
				launcherBinary: fixture.launcherBinary,
				outputDir: fixture.outputDir,
				skipCcValidation: true,
				skipLauncherValidation: true,
				requireNodeReadiness: true,
				nodeReadinessGate: path.join(fixture.root, "missing-gate.mjs"),
				openClawBinary: "openclaw",
				expectedOpenClawVersion: "2026.5.5",
			});

			expect(check.status).toBe("failed");
			expect(check.error).toContain("Node readiness gate not found");
		} finally {
			fs.rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("missing openclaw is a clear failed check", async () => {
		const fixture = createGateFixture();
		try {
			const readinessGate = createReadinessGate(fixture.root);

			const check = await runNodeReadinessCheck({
				commandCentralRepo: fixture.commandCentralRepo,
				ghosttyLauncherRepo: fixture.ghosttyLauncherRepo,
				launcherBinary: fixture.launcherBinary,
				outputDir: fixture.outputDir,
				skipCcValidation: true,
				skipLauncherValidation: true,
				requireNodeReadiness: true,
				nodeReadinessGate: readinessGate,
				openClawBinary: path.join(fixture.root, "missing-openclaw"),
			});

			expect(check.status).toBe("failed");
			expect(check.error).toContain(
				"Failed to resolve expected OpenClaw version",
			);
		} finally {
			fs.rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("evaluateDaemonSmoke (CCREL-05 daemon smoke)", () => {
	test("passes when daemon is running with a socket", () => {
		const out = JSON.stringify({ running: true, socket: "/tmp/openclaw.sock" });
		expect(evaluateDaemonSmoke(out)).toEqual({ ok: true, issues: [] });
	});

	test("passes when daemon reports state=running with a pid", () => {
		const out = JSON.stringify({ state: "running", pid: 4242 });
		expect(evaluateDaemonSmoke(out)).toEqual({ ok: true, issues: [] });
	});

	test("passes for current openclaw daemon status shape", () => {
		const out = JSON.stringify({
			service: { runtime: { status: "running", state: "active", pid: 4242 } },
			gateway: { probeUrl: "ws://127.0.0.1:18789" },
		});
		expect(evaluateDaemonSmoke(out)).toEqual({ ok: true, issues: [] });
	});

	test("fails when daemon is not running", () => {
		const out = JSON.stringify({
			running: false,
			socket: "/tmp/openclaw.sock",
		});
		const result = evaluateDaemonSmoke(out);
		expect(result.ok).toBe(false);
		expect(result.issues.some((i) => i.includes("running state"))).toBe(true);
	});

	test("fails when there is no live endpoint", () => {
		const out = JSON.stringify({ running: true });
		const result = evaluateDaemonSmoke(out);
		expect(result.ok).toBe(false);
		expect(result.issues.some((i) => i.includes("live endpoint"))).toBe(true);
	});

	test("non-JSON output is a clean issue, not a throw", () => {
		const result = evaluateDaemonSmoke("daemon: connection refused");
		expect(result.ok).toBe(false);
		expect(result.issues.some((i) => i.includes("not valid JSON"))).toBe(true);
	});
});

describe("evaluateRepoParity (CCREL-05 hub repo parity)", () => {
	test("passes for a clean repo at origin/main (0 behind / 0 ahead)", () => {
		expect(
			evaluateRepoParity({
				repo: "config",
				porcelain: "",
				aheadBehind: "0\t0",
			}),
		).toEqual({ repo: "config", ok: true, issues: [] });
	});

	test("fails when the tree is dirty", () => {
		const result = evaluateRepoParity({
			repo: "command-central",
			porcelain: " M src/extension.ts\n",
			aheadBehind: "0\t0",
		});
		expect(result.ok).toBe(false);
		expect(result.issues.some((i) => i.includes("uncommitted"))).toBe(true);
	});

	test("fails when ahead of origin/main", () => {
		const result = evaluateRepoParity({
			repo: "config",
			porcelain: "",
			aheadBehind: "0\t3",
		});
		expect(result.ok).toBe(false);
		expect(result.issues.some((i) => i.includes("ahead"))).toBe(true);
	});

	test("fails when behind origin/main", () => {
		const result = evaluateRepoParity({
			repo: "ghostty-launcher",
			porcelain: "",
			aheadBehind: "2\t0",
		});
		expect(result.ok).toBe(false);
		expect(result.issues.some((i) => i.includes("behind"))).toBe(true);
	});
});

describe("runDaemonSmokeCheck (CCREL-05 gate runner)", () => {
	// Reuses createGateFixture + writeExecutable already in this file.
	test("a dead daemon is a failed check", async () => {
		const fixture = createGateFixture();
		try {
			const binDir = path.join(fixture.root, "bin");
			const openClawBinary = path.join(binDir, "openclaw");
			writeExecutable(
				openClawBinary,
				`#!/bin/bash
if [[ "$1" == "daemon" && "$2" == "status" && "$3" == "--json" ]]; then
  echo '{"running": false}'
  exit 0
fi
exit 9
`,
			);
			const check = await runDaemonSmokeCheck({
				commandCentralRepo: fixture.commandCentralRepo,
				ghosttyLauncherRepo: fixture.ghosttyLauncherRepo,
				launcherBinary: fixture.launcherBinary,
				outputDir: fixture.outputDir,
				skipCcValidation: true,
				skipLauncherValidation: true,
				requireNodeReadiness: false,
				nodeReadinessGate: path.join(fixture.root, "missing-gate.mjs"),
				openClawBinary,
				requireDaemonSmoke: true,
			});
			expect(check.status).toBe("failed");
			expect(check.error).toContain("running state");
		} finally {
			fs.rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("normalizeGitHubRemote (CCSTD-05 split identity)", () => {
	test("normalizes https, ssh, scp-like, trailing .git/slash, and case", () => {
		const slug = "ostehost/command-central";
		expect(
			normalizeGitHubRemote("https://github.com/ostehost/command-central"),
		).toBe(slug);
		expect(
			normalizeGitHubRemote("https://github.com/ostehost/command-central.git"),
		).toBe(slug);
		expect(
			normalizeGitHubRemote("https://github.com/ostehost/command-central/"),
		).toBe(slug);
		expect(
			normalizeGitHubRemote("git@github.com:ostehost/command-central.git"),
		).toBe(slug);
		expect(
			normalizeGitHubRemote(
				"ssh://git@github.com/ostehost/command-central.git",
			),
		).toBe(slug);
		expect(
			normalizeGitHubRemote("https://github.com/OsteHost/Command-Central"),
		).toBe(slug);
	});

	test("returns empty for unrecognizable remotes", () => {
		expect(normalizeGitHubRemote("")).toBe("");
		expect(normalizeGitHubRemote("not a url")).toBe("");
		expect(
			normalizeGitHubRemote("https://gitlab.com/ostehost/command-central"),
		).toBe("");
		expect(
			normalizeGitHubRemote("https://evilgithub.com/ostehost/command-central"),
		).toBe("");
	});
});

describe("evaluatePushTarget (CCSTD-05 push-target guardrail)", () => {
	test("passes when the remote matches package.json across url shapes", () => {
		const result = evaluatePushTarget({
			remote: "origin",
			remoteUrl: "git@github.com:ostehost/command-central.git",
			packageRepoUrl: "https://github.com/ostehost/command-central",
		});
		expect(result.ok).toBe(true);
		expect(result.issues).toEqual([]);
		expect(result.remoteSlug).toBe("ostehost/command-central");
		expect(result.expectedSlug).toBe("ostehost/command-central");
	});

	// Regression: before CCSTD-05 there was NO push-target check at all, so a
	// command-central checkout whose `origin` pointed at the ghostty-launcher
	// repo (the split-identity hazard) would tag/push to the wrong repo silently.
	test("refuses when origin points at the sibling split-identity repo", () => {
		const result = evaluatePushTarget({
			remote: "origin",
			remoteUrl: "https://github.com/ostehost/ghostty-launcher.git",
			packageRepoUrl: "https://github.com/ostehost/command-central",
		});
		expect(result.ok).toBe(false);
		expect(result.remoteSlug).toBe("ostehost/ghostty-launcher");
		expect(result.expectedSlug).toBe("ostehost/command-central");
		expect(result.issues.some((i) => i.includes("refusing to tag/push"))).toBe(
			true,
		);
	});

	test("refuses a fork remote even with the same repo name", () => {
		const result = evaluatePushTarget({
			remote: "origin",
			remoteUrl: "https://github.com/someforker/command-central.git",
			packageRepoUrl: "https://github.com/ostehost/command-central",
		});
		expect(result.ok).toBe(false);
		expect(
			result.issues.some((i) => i.includes("someforker/command-central")),
		).toBe(true);
	});

	test("fails clearly when the remote url is unparseable", () => {
		const result = evaluatePushTarget({
			remote: "origin",
			remoteUrl: "/some/local/path.git",
			packageRepoUrl: "https://github.com/ostehost/command-central",
		});
		expect(result.ok).toBe(false);
		expect(result.issues.some((i) => i.includes("could not parse"))).toBe(true);
	});
});

describe("runPushTargetCheck (CCSTD-05 gate runner)", () => {
	function writePackageRepo(repo: string, url: string): void {
		fs.writeFileSync(
			path.join(repo, "package.json"),
			`${JSON.stringify(
				{ name: "command-central", repository: { type: "git", url } },
				null,
				"\t",
			)}\n`,
			"utf8",
		);
		execFileSync("git", ["add", "package.json"], { cwd: repo });
		execFileSync("git", ["commit", "-q", "-m", "test: package.json"], {
			cwd: repo,
		});
	}

	test("a remote pointing at the sibling repo is a failed check", async () => {
		const fixture = createGateFixture();
		try {
			writePackageRepo(
				fixture.commandCentralRepo,
				"https://github.com/ostehost/command-central",
			);
			execFileSync(
				"git",
				[
					"remote",
					"add",
					"origin",
					"https://github.com/ostehost/ghostty-launcher.git",
				],
				{ cwd: fixture.commandCentralRepo },
			);

			const check = await runPushTargetCheck({
				commandCentralRepo: fixture.commandCentralRepo,
				ghosttyLauncherRepo: fixture.ghosttyLauncherRepo,
				launcherBinary: fixture.launcherBinary,
				outputDir: fixture.outputDir,
				skipCcValidation: true,
				skipLauncherValidation: true,
				requireNodeReadiness: false,
				nodeReadinessGate: path.join(fixture.root, "missing-gate.mjs"),
				openClawBinary: "openclaw",
				requirePushTarget: true,
				pushRemote: "origin",
			});

			expect(check.status).toBe("failed");
			expect(check.error).toContain("refusing to tag/push");
		} finally {
			fs.rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("a matching remote passes the check", async () => {
		const fixture = createGateFixture();
		try {
			writePackageRepo(
				fixture.commandCentralRepo,
				"https://github.com/ostehost/command-central",
			);
			execFileSync(
				"git",
				[
					"remote",
					"add",
					"origin",
					"git@github.com:ostehost/command-central.git",
				],
				{ cwd: fixture.commandCentralRepo },
			);

			const check = await runPushTargetCheck({
				commandCentralRepo: fixture.commandCentralRepo,
				ghosttyLauncherRepo: fixture.ghosttyLauncherRepo,
				launcherBinary: fixture.launcherBinary,
				outputDir: fixture.outputDir,
				skipCcValidation: true,
				skipLauncherValidation: true,
				requireNodeReadiness: false,
				nodeReadinessGate: path.join(fixture.root, "missing-gate.mjs"),
				openClawBinary: "openclaw",
				requirePushTarget: true,
				pushRemote: "origin",
			});

			expect(check.status).toBe("passed");
		} finally {
			fs.rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("the integrated gate hard-blocks on a wrong push target", async () => {
		const fixture = createGateFixture();
		try {
			writePackageRepo(
				fixture.commandCentralRepo,
				"https://github.com/ostehost/command-central",
			);
			execFileSync(
				"git",
				[
					"remote",
					"add",
					"origin",
					"https://github.com/ostehost/ghostty-launcher.git",
				],
				{ cwd: fixture.commandCentralRepo },
			);

			let thrown: unknown;
			try {
				await runGate({
					commandCentralRepo: fixture.commandCentralRepo,
					ghosttyLauncherRepo: fixture.ghosttyLauncherRepo,
					launcherBinary: fixture.launcherBinary,
					outputDir: fixture.outputDir,
					skipCcValidation: true,
					skipLauncherValidation: true,
					requireNodeReadiness: false,
					nodeReadinessGate: path.join(fixture.root, "missing-gate.mjs"),
					openClawBinary: "openclaw",
					requirePushTarget: true,
					pushRemote: "origin",
				});
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeTruthy();
			const checks =
				(thrown as { checks?: Array<{ name: string; status: string }> })
					.checks ?? [];
			const pushTarget = checks.find(
				(check) => check.name === "release push-target identity",
			);
			expect(pushTarget?.status).toBe("failed");
		} finally {
			fs.rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
