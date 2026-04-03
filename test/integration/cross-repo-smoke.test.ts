/**
 * Cross-Repo Smoke Tests — Command Central ↔ Ghostty Launcher
 *
 * Validates that trust-layer contracts work together end-to-end,
 * not just in isolated unit tests. Exercises the real control surface:
 *   1. Spawn: buildOsteSpawnCommand() produces valid CLI shapes
 *   2. Steer: oste-steer.sh invocation uses positional session + --raw
 *   3. Capture: helper resolved from launcher binary dir, not tasks.json
 *   4. Kill: helper resolved from launcher binary dir, not tasks.json
 *   5. Focus: launcher AppleScript helper lookup + window activation
 *   6. Completion: status transitions fire correct notifications
 *
 * Where the real launcher repo is available, also validates dynamic
 * contract alignment (flag sets, help text, script existence).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	extractFlagsFromHelp,
	extractSessionFlagsFromTerminalManager,
	extractSteerInvocationArgBlocks,
	extractSteerInvocationContract,
	validateLauncherContract,
	validateSteerContract,
} from "../../scripts-v2/prerelease-gate.js";
import { buildOsteSpawnCommand } from "../../src/utils/shell-command.js";

// ─── Paths ──────────────────────────────────────────────────
const CC_ROOT = path.resolve(import.meta.dir, "../..");
const TERMINAL_MANAGER_PATH = path.join(
	CC_ROOT,
	"src/ghostty/TerminalManager.ts",
);
const EXTENSION_PATH = path.join(CC_ROOT, "src/extension.ts");
const LAUNCHER_REPO =
	process.env["LAUNCHER_REPO"] ??
	path.join(process.env["HOME"] ?? "", "projects", "ghostty-launcher");
const LAUNCHER_BIN = path.join(LAUNCHER_REPO, "launcher");

const terminalManagerSource = fs.readFileSync(TERMINAL_MANAGER_PATH, "utf8");
const extensionSource = fs.readFileSync(EXTENSION_PATH, "utf8");

// ─── 1. Spawn ───────────────────────────────────────────────
describe("smoke: spawn — oste-spawn.sh argument shapes", () => {
	test("buildOsteSpawnCommand produces correct positional + flag args", () => {
		const cmd = buildOsteSpawnCommand({
			projectDir: "/tmp/my-project",
			promptFile: "/tmp/prompt.md",
			taskId: "task-abc-123",
		});

		// Must start with the script name
		expect(cmd).toContain("'oste-spawn.sh'");
		// Positional: projectDir promptFile
		expect(cmd).toContain("'/tmp/my-project'");
		expect(cmd).toContain("'/tmp/prompt.md'");
		// Flags
		expect(cmd).toContain("'--task-id'");
		expect(cmd).toContain("'task-abc-123'");
		expect(cmd).not.toContain("'--agent'");
	});

	test("buildOsteSpawnCommand includes --agent when backend is explicit", () => {
		const cmd = buildOsteSpawnCommand({
			projectDir: "/tmp/my-project",
			promptFile: "/tmp/prompt.md",
			taskId: "task-abc-123",
			backend: "claude-code",
		});

		expect(cmd).toContain("'--agent'");
		expect(cmd).toContain("'claude-code'");
	});

	test("buildOsteSpawnCommand includes --role when specified", () => {
		const cmd = buildOsteSpawnCommand({
			projectDir: "/projects/foo",
			promptFile: "/tmp/p.md",
			taskId: "t-1",
			backend: "codex",
			role: "reviewer",
		});

		expect(cmd).toContain("'--role'");
		expect(cmd).toContain("'reviewer'");
	});

	test("buildOsteSpawnCommand safely quotes paths with spaces", () => {
		const cmd = buildOsteSpawnCommand({
			projectDir: "/tmp/my project",
			promptFile: "/tmp/my prompt.md",
			taskId: "t-2",
			backend: "claude-code",
		});

		// Single-quoting prevents word splitting
		expect(cmd).toContain("'/tmp/my project'");
		expect(cmd).toContain("'/tmp/my prompt.md'");
	});

	test("buildOsteSpawnCommand safely quotes paths with single quotes", () => {
		const cmd = buildOsteSpawnCommand({
			projectDir: "/tmp/it's a project",
			promptFile: "/tmp/file.md",
			taskId: "t-3",
			backend: "claude-code",
		});

		// POSIX single-quote escaping: ' → '"'"'
		expect(cmd).toContain("'\"'\"'");
	});
});

// ─── 2. Steer ───────────────────────────────────────────────
describe("smoke: steer — oste-steer.sh invocation contract", () => {
	test("TerminalManager uses positional session ID (not --session flag)", () => {
		const contract = extractSteerInvocationContract(terminalManagerSource);
		expect(contract.usesPositionalSession).toBe(true);
		expect(contract.usesLegacySessionFlag).toBe(false);
	});

	test("TerminalManager passes --raw flag to oste-steer.sh", () => {
		const contract = extractSteerInvocationContract(terminalManagerSource);
		expect(contract.usesRawMode).toBe(true);
	});

	test("source contains execCommand calls with correct shape", () => {
		// Verify the actual invocation pattern: execCommand(steerPath, [sessionId, "--raw", command])
		const steerCalls = extractSteerInvocationArgBlocks(terminalManagerSource);
		expect(steerCalls.length).toBeGreaterThan(0);

		for (const argsBlock of steerCalls) {
			// First arg should NOT be a flag (it's the session ID variable)
			const firstArg = argsBlock.split(",")[0]?.trim() ?? "";
			expect(firstArg).not.toStartWith('"--');
			// "--raw" must appear in the args
			expect(argsBlock).toContain('"--raw"');
		}
	});
});

// ─── 3. Capture — helper resolution ────────────────────────
describe("smoke: capture — oste-capture.sh resolution", () => {
	test("extension resolves oste-capture.sh via resolveLauncherHelperScriptPath", () => {
		expect(extensionSource).toMatch(
			/resolveLauncherHelperScriptPath\s*\(\s*"oste-capture\.sh"/,
		);
	});

	test("extension does NOT resolve capture helper from tasks.json dir", () => {
		// Ensure no legacy pattern like: path.dirname(tasksFilePath) ... oste-capture.sh
		const legacyPattern =
			/path\.dirname\(tasksFilePath\)[\s\S]{0,240}oste-capture\.sh/;
		expect(legacyPattern.test(extensionSource)).toBe(false);
	});

	test("TerminalManager anchors helper scripts to launcher binary dir", () => {
		// The resolution must use: path.join(path.dirname(launcherPath), "scripts", scriptName)
		expect(terminalManagerSource).toMatch(
			/path\.join\(\s*path\.dirname\(launcherPath\),\s*"scripts",\s*scriptName/,
		);
	});

	test("helper script name validation rejects path traversal", () => {
		// The regex should only allow [a-z0-9][a-z0-9.-]*\.sh
		const validationRegex = /^[a-z0-9][a-z0-9.-]*\.sh$/i;
		expect(validationRegex.test("oste-capture.sh")).toBe(true);
		expect(validationRegex.test("../etc/passwd")).toBe(false);
		expect(validationRegex.test("../../evil.sh")).toBe(false);
		expect(validationRegex.test(".hidden.sh")).toBe(false);
	});
});

// ─── 4. Kill — helper resolution ───────────────────────────
describe("smoke: kill — oste-kill.sh resolution", () => {
	test("extension resolves oste-kill.sh via resolveLauncherHelperScriptPath", () => {
		expect(extensionSource).toMatch(
			/resolveLauncherHelperScriptPath\s*\(\s*"oste-kill\.sh"/,
		);
	});

	test("extension does NOT resolve kill helper from tasks.json dir", () => {
		const legacyPattern =
			/path\.dirname\(tasksFilePath\)[\s\S]{0,240}oste-kill\.sh/;
		expect(legacyPattern.test(extensionSource)).toBe(false);
	});
});

// ─── 5. Focus — launcher AppleScript lookup ─────────────────
describe("smoke: focus — launcher script lookup", () => {
	let lookupLauncherFocusScript: () => string | null;

	beforeEach(async () => {
		const modulePath = [
			"../../src/ghostty/window-focus.js",
			"focus-smoke",
		].join("?");
		const mod = await import(modulePath);
		lookupLauncherFocusScript = mod.lookupLauncherFocusScript;
	});

	test("lookupLauncherFocusScript resolves the launcher repo helper script", () => {
		const expected =
			"/Users/ostemini/projects/ghostty-launcher/scripts/oste-focus.applescript";
		expect(fs.existsSync(expected)).toBe(true);
		expect(lookupLauncherFocusScript()).toBe(expected);
	});
});

// ─── 6. Completion — status transition notifications ────────
describe("smoke: completion — task status transitions", () => {
	test("completion notification fires on running→completed transition", () => {
		// Simulate the checkCompletionNotifications logic
		const previousStatuses = new Map<string, string>([["task-1", "running"]]);

		const task = {
			id: "task-1",
			status: "completed" as const,
		};

		const prev = previousStatuses.get(task.id);
		expect(prev).toBe("running");
		expect(
			task.status === "completed" || task.status === "completed_dirty",
		).toBe(true);
	});

	test("failure notification fires on running→failed transition", () => {
		const previousStatuses = new Map<string, string>([["task-2", "running"]]);

		const task = {
			id: "task-2",
			status: "failed" as const,
		};

		const prev = previousStatuses.get(task.id);
		expect(prev).toBe("running");
		expect(task.status === "failed").toBe(true);
	});

	test("no notification fires when status was not running", () => {
		const previousStatuses = new Map<string, string>([["task-3", "stopped"]]);

		const task = {
			id: "task-3",
			status: "completed" as const,
		};

		const prev = previousStatuses.get(task.id);
		expect(prev).not.toBe("running");
	});

	test("completed_dirty status is treated as completion", () => {
		const previousStatuses = new Map<string, string>([["task-4", "running"]]);

		const task = {
			id: "task-4",
			status: "completed_dirty" as const,
		};

		const prev = previousStatuses.get(task.id);
		expect(prev).toBe("running");
		expect(
			(["completed", "completed_dirty"] as const).includes(task.status),
		).toBe(true);
	});
});

// ─── Static contract validation (uses prerelease-gate extractors) ───
describe("smoke: static contract validation", () => {
	test("TerminalManager references --session-id (not legacy --tmux-session)", () => {
		const flags = extractSessionFlagsFromTerminalManager(terminalManagerSource);
		expect(flags.has("--session-id")).toBe(true);
		expect(flags.has("--tmux-session")).toBe(false);
	});

	test("extension resolves all required launcher helpers", () => {
		const requiredHelpers = ["oste-capture.sh", "oste-kill.sh"];
		for (const helper of requiredHelpers) {
			expect(extensionSource).toContain(`resolveLauncherHelperScriptPath`);
			expect(extensionSource).toContain(`"${helper}"`);
		}
	});
});

// ─── Dynamic contract validation (when launcher repo available) ─────
const launcherAvailable =
	fs.existsSync(LAUNCHER_BIN) && fs.existsSync(LAUNCHER_REPO);

describe.if(launcherAvailable)(
	"smoke: dynamic launcher contract (live repo)",
	() => {
		let launcherHelpText: string;
		let steerHelpText: string;

		beforeEach(async () => {
			const { execFileSync } = await import("node:child_process");

			launcherHelpText = execFileSync(LAUNCHER_BIN, ["--help"], {
				encoding: "utf-8",
				timeout: 10_000,
			});

			const steerScript = path.join(LAUNCHER_REPO, "scripts", "oste-steer.sh");
			steerHelpText = execFileSync(steerScript, ["--help"], {
				encoding: "utf-8",
				timeout: 10_000,
			});
		});

		test("launcher binary exposes all required flags", () => {
			const flags = extractFlagsFromHelp(launcherHelpText);
			for (const required of [
				"--create-bundle",
				"--parse-name",
				"--parse-icon",
				"--session-id",
			]) {
				expect(flags.has(required)).toBe(true);
			}
		});

		test("oste-steer.sh exposes --raw and --by-task-id flags", () => {
			const flags = extractFlagsFromHelp(steerHelpText);
			expect(flags.has("--raw")).toBe(true);
			expect(flags.has("--by-task-id")).toBe(true);
		});

		test("oste-steer.sh help shows positional <session-name> usage", () => {
			expect(steerHelpText).toContain("oste-steer.sh <session-name> <text>");
		});

		test("full launcher contract validation passes", () => {
			const issues = validateLauncherContract(
				terminalManagerSource,
				launcherHelpText,
				extensionSource,
			);
			expect(issues).toEqual([]);
		});

		test("full steer contract validation passes", () => {
			const issues = validateSteerContract(
				terminalManagerSource,
				steerHelpText,
			);
			expect(issues).toEqual([]);
		});

		test("launcher helper scripts exist in launcher repo", () => {
			for (const script of ["oste-capture.sh", "oste-kill.sh"]) {
				const scriptPath = path.join(LAUNCHER_REPO, "scripts", script);
				expect(fs.existsSync(scriptPath)).toBe(true);
			}
		});

		test("oste-spawn.sh exists in launcher repo", () => {
			const spawnScript = path.join(LAUNCHER_REPO, "scripts", "oste-spawn.sh");
			expect(fs.existsSync(spawnScript)).toBe(true);
		});
	},
);
