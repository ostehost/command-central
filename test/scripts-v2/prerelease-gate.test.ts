import { describe, expect, test } from "bun:test";
import {
	extractFlagsFromHelp,
	extractSessionFlagsFromTerminalManager,
	validateLauncherContract,
} from "../../scripts-v2/prerelease-gate.ts";

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
			validateLauncherContract(validTerminalManagerSource, validHelp),
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
		);
		expect(issues.some((issue) => issue.includes("--session-id"))).toBe(true);
	});

	test("fails when TerminalManager regresses to tmux-session", () => {
		const regressedSource = `
this.execLauncher(launcher, ["--tmux-session", workspaceRoot]);
`;
		const issues = validateLauncherContract(regressedSource, validHelp);
		expect(issues.some((issue) => issue.includes("--tmux-session"))).toBe(true);
	});
});
