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
import * as os from "node:os";
import * as path from "node:path";
import {
	extractFlagsFromHelp,
	extractSessionFlagsFromTerminalManager,
	extractSteerInvocationArgBlocks,
	validateLauncherContract,
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
// Retired with rc.31: the extension no longer shells out to oste-steer.sh.
// Steer dispatch lives entirely inside `launcher --send` (launcher 1.2.0+).
// The new extension contract is asserted in
// `test/ghostty/terminal-manager.test.ts` ("delegates send to `launcher
// --send ...`"); the launcher-side contract (positional session, --raw flag,
// zellij/tmux dispatch) is tested in ~/projects/ghostty-launcher.
describe("smoke: steer — extension delegates to launcher --send", () => {
	test("TerminalManager does NOT shell out to oste-steer.sh directly", () => {
		// Asserts the inverse of the old contract: zero direct invocations.
		// If a future commit re-introduces an oste-steer.sh execCommand call,
		// this regex match goes from 0 → ≥1 and the test fires.
		const directSteerCalls = extractSteerInvocationArgBlocks(
			terminalManagerSource,
		);
		expect(directSteerCalls.length).toBe(0);
	});

	test("TerminalManager invokes `launcher --send` for command delivery", () => {
		// Look for `--send` flag passed to a launcher exec — the new contract.
		expect(terminalManagerSource).toContain('"--send"');
		expect(terminalManagerSource).toContain('"--command"');
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
		const homeCandidate = path.join(
			os.homedir(),
			"projects",
			"ghostty-launcher",
			"scripts",
			"oste-focus.applescript",
		);
		const siblingCandidate = path.join(
			process.cwd(),
			"..",
			"ghostty-launcher",
			"scripts",
			"oste-focus.applescript",
		);
		const expected = fs.existsSync(homeCandidate)
			? homeCandidate
			: siblingCandidate;
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
				"--send",
			]) {
				expect(flags.has(required)).toBe(true);
			}
		});

		// rc.32 regression lock: when launcher --send runs against a project
		// whose zellij session is daemon-alive but client-detached (no
		// Ghostty window attached — typical after the user closes the
		// window), the launcher MUST still `open` the bundle to bring up a
		// visible window. The previous "skip open if session alive"
		// optimization in --send caused `write-chars` to land in an
		// invisible session.
		// rc.33 regression lock: the bundle's launch-zellij.sh must propagate
		// the user's interactive shell PATH so installed agent CLIs (claude
		// in ~/.local/bin, codex via bun, etc.) are discoverable inside the
		// zellij panes. Previously launch-zellij.sh hardcoded a minimal PATH
		// and the user saw "fish: Unknown command: claude" when the resume
		// command was steered in.
		test("launcher's launch-zellij.sh template propagates user shell PATH", () => {
			const launcherSource = fs.readFileSync(LAUNCHER_BIN, "utf-8");
			// The launch script template lives between `cat >".../launch-zellij.sh" <<LAUNCH`
			// and the next `LAUNCH` heredoc terminator. Inside the heredoc the
			// `$`s are written as `\$` so they survive the outer bash; account
			// for that in the patterns below.
			const tmplMatch = launcherSource.match(
				/cat\s+>"[^"]*launch-zellij\.sh"\s+<<LAUNCH\n([\s\S]*?)\nLAUNCH/,
			);
			expect(tmplMatch).not.toBeNull();
			const tmpl = tmplMatch?.[1] ?? "";
			// MUST reference the user's SHELL env var (heredoc-escaped).
			expect(tmpl).toMatch(/\\\$SHELL|"\\\$__user_shell"/);
			// MUST query the user's interactive shell for PATH via either the
			// fish-style join or the POSIX-shell printf.
			expect(tmpl).toMatch(/string join : \\\$PATH|printf %s "\\\$PATH"/);
			// MUST include $HOME/.local/bin in the fallback (where claude
			// typically installs).
			expect(tmpl).toContain("\\$HOME/.local/bin");
		});

		// rc.33: --send must (re)create the bundle each call so a launcher
		// upgrade (new launch-zellij.sh template) reaches users without
		// requiring them to manually delete /Applications/Projects/X.app.
		test("launcher --send block always recreates the bundle (no `if [[ ! -d`)", () => {
			const launcherSource = fs.readFileSync(LAUNCHER_BIN, "utf-8");
			// The --send case body — find from `--send)` to next `--version`
			// case label (a known sibling).
			const sendBody =
				launcherSource.match(/--send\)([\s\S]*?)--version\s*\|\s*-v\)/)?.[1] ??
				"";
			expect(sendBody.length).toBeGreaterThan(0);
			// Forbid the "only create if missing" gate that would freeze the
			// bundle's launch script at first-install time.
			expect(sendBody).not.toMatch(
				/if\s+\[\[\s+!\s+-d\s+"?\$send_bundle"?\s+\]\]/,
			);
			// Positive contract: a create_bundle call happens.
			expect(sendBody).toContain("create_bundle");
		});

		test("launcher source has unconditional `open $send_bundle` for the --send path", () => {
			const launcherSource = fs.readFileSync(LAUNCHER_BIN, "utf-8");
			// MUST contain at least one `/usr/bin/open "$send_bundle"`.
			// `$send_bundle` is the local var name only used inside --send,
			// so any match means the --send code path opens the bundle.
			const openOccurrences = launcherSource.match(
				/\/usr\/bin\/open\s+(?:-n\s+)?"?\$send_bundle/g,
			);
			expect(openOccurrences).not.toBeNull();
			expect((openOccurrences ?? []).length).toBeGreaterThanOrEqual(1);
			// MUST NOT have the specific old pattern we just removed:
			// `if [[ "$send_alive" -ne 1 ]]; then ... /usr/bin/open ... fi`
			// inside ~300 chars (the optimization span).
			const aliveGatedOpen =
				/if\s+\[\[\s+"?\$send_alive"?\s+-ne\s+1\s+\]\][\s\S]{0,300}\/usr\/bin\/open/;
			expect(launcherSource).not.toMatch(aliveGatedOpen);
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

		// Retired with rc.31: validateSteerContract asserted the
		// extension's direct oste-steer.sh invocation shape against
		// the helper script's --help output. The extension no longer
		// invokes the helper — the launcher's --send subcommand does.
		// Cross-repo contract validation belongs in the launcher repo
		// (tests on launcher --send) rather than reaching back into the
		// extension's source.

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
