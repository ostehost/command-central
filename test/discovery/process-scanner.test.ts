/**
 * ProcessScanner tests
 *
 * Validates detection of running supported agent CLIs via ps/lsof.
 * All system calls are mocked via constructor injection — no real processes are inspected.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ProcessScanner } from "../../src/discovery/process-scanner.js";

// Create a mock that matches the execFileAsync signature
const mockExecFile = mock(
	(_cmd: string, _args?: readonly string[], _opts?: Record<string, unknown>) =>
		Promise.resolve({ stdout: "", stderr: "" }) as Promise<{
			stdout: string;
			stderr: string;
		}>,
);

describe("ProcessScanner", () => {
	let scanner: ProcessScanner;

	beforeEach(() => {
		mockExecFile.mockClear();
		mockExecFile.mockImplementation(
			() =>
				Promise.resolve({ stdout: "", stderr: "" }) as Promise<{
					stdout: string;
					stderr: string;
				}>,
		);
		// Inject the mock executor directly — no module mocking needed
		scanner = new ProcessScanner(
			mockExecFile as unknown as (typeof scanner)["execFileAsync"],
		);
	});

	// ── parsePsOutput ────────────────────────────────────────────────

	describe("parsePsOutput", () => {
		test("parses supported agent CLI processes from ps output", () => {
			const psOutput = [
				"  PID   STARTED                       COMMAND",
				"12345 Mon Jan  6 14:03:22 2025 /usr/local/bin/claude --model opus --print hello",
				"12346 Mon Jan  6 14:05:00 2025 /usr/bin/node /path/to/claude-code/cli.js --session-id abc123",
				"12347 Mon Jan  6 14:05:30 2025 /opt/homebrew/bin/codex --model gpt-5 --print hello",
				"12348 Mon Jan  6 14:06:10 2025 node /tmp/node_modules/@google/gemini-cli/dist/index.js --model gemini-2.5-pro --prompt hi",
			].join("\n");

			const results = scanner.parsePsOutput(psOutput);
			expect(results).toHaveLength(4);
			expect(results[0]?.pid).toBe(12345);
			expect(results[0]?.command).toContain("claude");
			expect(results[1]?.pid).toBe(12346);
			expect(results[2]?.pid).toBe(12347);
			expect(results[3]?.pid).toBe(12348);
		});

		test("filters out non-agent processes", () => {
			const psOutput = [
				"  PID   STARTED                       COMMAND",
				"11111 Mon Jan  6 14:00:00 2025 /usr/bin/vim test.ts",
				"22222 Mon Jan  6 14:01:00 2025 /usr/bin/node server.js",
				"33333 Mon Jan  6 14:02:00 2025 grep claude",
			].join("\n");

			const results = scanner.parsePsOutput(psOutput);
			expect(results).toHaveLength(0);
		});

		test("detects npx/pnpm dlx invocations for codex and gemini", () => {
			const psOutput = [
				"  PID   STARTED                       COMMAND",
				"55551 Mon Jan  6 14:07:10 2025 npx @openai/codex --model gpt-5 --print hello",
				"55552 Mon Jan  6 14:07:40 2025 pnpm dlx @google/gemini-cli --model gemini-2.5-pro --prompt hi",
			].join("\n");

			const results = scanner.parsePsOutput(psOutput);
			expect(results).toHaveLength(2);
			expect(results[0]?.pid).toBe(55551);
			expect(results[1]?.pid).toBe(55552);
		});

		test("filters out non-agent processes with codex/gemini in path", () => {
			const psOutput = [
				"  PID   STARTED                       COMMAND",
				"44441 Mon Jan  6 14:00:00 2025 /usr/bin/node /projects/codex/server.js",
				"44442 Mon Jan  6 14:00:00 2025 /usr/bin/python /srv/gemini/app.py",
				"44443 Mon Jan  6 14:00:00 2025 /usr/bin/node /tmp/gemini-cli-helper/index.js",
			].join("\n");

			const results = scanner.parsePsOutput(psOutput);
			expect(results).toHaveLength(0);
		});

		test("ignores near-miss codex/gemini path segments that are not CLI invocations", () => {
			const psOutput = [
				"  PID   STARTED                       COMMAND",
				"44451 Mon Jan  6 14:00:00 2025 /usr/bin/node /workspace/services/codex/runner.js --task build",
				"44452 Mon Jan  6 14:00:00 2025 /usr/bin/node /workspace/tools/gemini/sync.js --env prod",
				"44453 Mon Jan  6 14:00:00 2025 /usr/bin/node /tmp/node_modules/@acme/codex-cli/dist/index.js --help",
				"44454 Mon Jan  6 14:00:00 2025 /usr/bin/node /tmp/node_modules/@google/gemini-cli-helper/dist/index.js --version",
			].join("\n");

			const results = scanner.parsePsOutput(psOutput);
			expect(results).toHaveLength(0);
		});

		test("filters out electron helpers and renderers", () => {
			const psOutput = [
				"  PID   STARTED                       COMMAND",
				"44444 Mon Jan  6 14:00:00 2025 /Applications/Claude.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)",
				"55555 Mon Jan  6 14:00:00 2025 /path/to/electron --type=gpu-process",
			].join("\n");

			const results = scanner.parsePsOutput(psOutput);
			expect(results).toHaveLength(0);
		});

		test("filters terminal notification helpers even when they mention codex or claude", () => {
			const psOutput = [
				"  PID   STARTED                       COMMAND",
				"60001 Mon Jan  6 14:00:00 2025 /opt/homebrew/bin/terminal-notifier -title Command\\ Central -message 'codex finished cleanly'",
				"60002 Mon Jan  6 14:00:01 2025 /usr/bin/osascript -e 'display notification \"claude completed\"'",
				"60003 Mon Jan  6 14:00:03 2025 /opt/homebrew/bin/codex --model gpt-5 --print hello",
			].join("\n");

			const results = scanner.parsePsOutput(psOutput);
			expect(results).toHaveLength(1);
			expect(results[0]?.pid).toBe(60003);

			const diagnostics = scanner.getLastDiagnostics();
			expect(diagnostics.agentLikeCandidateCount).toBe(2);
			expect(diagnostics.filtered).toHaveLength(1);
			expect(
				diagnostics.filtered.every(
					(entry) => entry.reason === "excluded-binary",
				),
			).toBe(true);
		});

		test("filters shell wrapper processes even when command text mentions an agent CLI", () => {
			const psOutput = [
				"  PID   STARTED                       COMMAND",
				"60011 Mon Jan  6 14:00:00 2025 /bin/zsh /tmp/node_modules/@openai/codex/dist/cli.js --resume sess-1",
				"60012 Mon Jan  6 14:00:01 2025 /opt/homebrew/bin/codex --model gpt-5 --print hello",
			].join("\n");

			const results = scanner.parsePsOutput(psOutput);
			expect(results).toHaveLength(1);
			expect(results[0]?.pid).toBe(60012);

			const diagnostics = scanner.getLastDiagnostics();
			expect(
				diagnostics.filtered.some(
					(entry) => entry.pid === 60011 && entry.reason === "shell-process",
				),
			).toBe(true);
		});

		test("returns empty array for empty ps output", () => {
			expect(scanner.parsePsOutput("")).toHaveLength(0);
		});

		test("skips header line", () => {
			const psOutput = "  PID   STARTED                       COMMAND\n";
			expect(scanner.parsePsOutput(psOutput)).toHaveLength(0);
		});

		test("handles malformed lines gracefully", () => {
			const psOutput = [
				"not a valid line",
				"  PID   STARTED                       COMMAND",
				"abc notapid",
				"",
			].join("\n");

			expect(scanner.parsePsOutput(psOutput)).toHaveLength(0);
		});
	});

	// ── parseClaudeArgs ──────────────────────────────────────────────

	describe("parseClaudeArgs", () => {
		test("extracts model from --model flag", () => {
			const result = scanner.parseClaudeArgs(
				"/usr/local/bin/claude --model opus --print hello",
			);
			expect(result.model).toBe("opus");
		});

		test("extracts codex and gemini backend hints from command", () => {
			const codexResult = scanner.parseClaudeArgs(
				"/opt/homebrew/bin/codex --model gpt-5 --print hello",
			);
			expect(codexResult.agent_backend).toBe("codex");
			expect(codexResult.cli_name).toBe("codex");
			expect(codexResult.model).toBe("gpt-5");

			const geminiResult = scanner.parseClaudeArgs(
				"node /tmp/node_modules/@google/gemini-cli/dist/index.js --model gemini-2.5-pro --prompt hi",
			);
			expect(geminiResult.agent_backend).toBe("gemini");
			expect(geminiResult.cli_name).toBe("gemini");
			expect(geminiResult.model).toBe("gemini-2.5-pro");
		});

		test("extracts model from short -m flag", () => {
			const result = scanner.parseClaudeArgs("/usr/local/bin/codex -m gpt-5");
			expect(result.model).toBe("gpt-5");
		});

		test("extracts sessionId from --session-id flag", () => {
			const result = scanner.parseClaudeArgs(
				"claude --session-id abc-123 --print test",
			);
			expect(result.sessionId).toBe("abc-123");
		});

		test("extracts sessionId from --session_id flag (underscore)", () => {
			const result = scanner.parseClaudeArgs(
				"claude --session_id def-456 --print test",
			);
			expect(result.sessionId).toBe("def-456");
		});

		test("extracts sessionId from --resume flag as fallback", () => {
			const result = scanner.parseClaudeArgs(
				"claude --resume sess-789 --print test",
			);
			expect(result.sessionId).toBe("sess-789");
		});

		test("prefers --session-id over --resume", () => {
			const result = scanner.parseClaudeArgs(
				"claude --session-id primary --resume fallback",
			);
			expect(result.sessionId).toBe("primary");
		});

		test("supports equals-form args for model and sessionId", () => {
			const result = scanner.parseClaudeArgs(
				"claude --model=opus --session-id=sess-eq",
			);
			expect(result.model).toBe("opus");
			expect(result.sessionId).toBe("sess-eq");
		});

		test("returns empty object when no flags present", () => {
			const result = scanner.parseClaudeArgs(
				"/usr/local/bin/claude --print hello",
			);
			expect(result.model).toBeUndefined();
			expect(result.sessionId).toBeUndefined();
		});
	});

	// ── getProcessCwd ────────────────────────────────────────────────

	describe("getProcessCwd", () => {
		test("resolves cwd from lsof output", async () => {
			mockExecFile.mockImplementation(
				(cmd: unknown, _args: unknown, _opts: unknown) => {
					if (cmd === "lsof") {
						return Promise.resolve({
							stdout: "p12345\nfcwd\nn/home/user/project\n",
							stderr: "",
						});
					}
					return Promise.resolve({ stdout: "", stderr: "" });
				},
			);

			const cwd = await scanner.getProcessCwd(12345);
			expect(cwd).toBe("/home/user/project");
		});

		test("returns null when lsof fails", async () => {
			mockExecFile.mockImplementation(() =>
				Promise.reject(new Error("lsof: command not found")),
			);

			const cwd = await scanner.getProcessCwd(99999);
			expect(cwd).toBeNull();
		});

		test("returns null when lsof output has no n-prefixed lines", async () => {
			mockExecFile.mockImplementation(() =>
				Promise.resolve({ stdout: "p12345\nfcwd\n", stderr: "" }),
			);

			const cwd = await scanner.getProcessCwd(12345);
			expect(cwd).toBeNull();
		});
	});

	// ── scan (integration) ───────────────────────────────────────────

	describe("scan", () => {
		test("returns discovered agents from ps + lsof", async () => {
			mockExecFile.mockImplementation(
				(cmd: unknown, _args: unknown, _opts: unknown) => {
					if (cmd === "ps") {
						return Promise.resolve({
							stdout: [
								"  PID   STARTED                       COMMAND",
								"12345 Mon Jan  6 14:03:22 2025 /usr/local/bin/claude --model opus --print hello",
							].join("\n"),
							stderr: "",
						});
					}
					if (cmd === "lsof") {
						return Promise.resolve({
							stdout: "p12345\nfcwd\nn/home/user/project\n",
							stderr: "",
						});
					}
					return Promise.resolve({ stdout: "", stderr: "" });
				},
			);

			const agents = await scanner.scan();
			expect(agents).toHaveLength(1);
			expect(agents[0]?.pid).toBe(12345);
			expect(agents[0]?.projectDir).toBe("/home/user/project");
			expect(agents[0]?.model).toBe("opus");
			expect(agents[0]?.source).toBe("process");
		});

		test("returns empty array when ps output is empty", async () => {
			mockExecFile.mockImplementation(() =>
				Promise.resolve({ stdout: "", stderr: "" }),
			);

			const agents = await scanner.scan();
			expect(agents).toHaveLength(0);
		});

		test("skips agents whose cwd cannot be resolved", async () => {
			mockExecFile.mockImplementation(
				(cmd: unknown, _args: unknown, _opts: unknown) => {
					if (cmd === "ps") {
						return Promise.resolve({
							stdout: [
								"  PID   STARTED                       COMMAND",
								"12345 Mon Jan  6 14:03:22 2025 /usr/local/bin/claude --print hello",
							].join("\n"),
							stderr: "",
						});
					}
					// lsof fails
					return Promise.reject(new Error("no such process"));
				},
			);

			const agents = await scanner.scan();
			expect(agents).toHaveLength(0);
		});

		test("populates worktree info when resolver detects a linked worktree", async () => {
			const mockResolveWorktree = mock(async () => ({
				mainRepoDir: "/home/user/project",
				worktreeDir: "/home/user/project-feature-auth",
				branch: "feature/auth",
				isLinkedWorktree: true,
			}));
			scanner = new ProcessScanner(
				mockExecFile as unknown as (typeof scanner)["execFileAsync"],
				mockResolveWorktree,
			);

			mockExecFile.mockImplementation(
				(cmd: unknown, _args: unknown, _opts: unknown) => {
					if (cmd === "ps") {
						return Promise.resolve({
							stdout: [
								"  PID   STARTED                       COMMAND",
								"12345 Mon Jan  6 14:03:22 2025 /usr/local/bin/claude --print hello",
							].join("\n"),
							stderr: "",
						});
					}
					if (cmd === "lsof") {
						return Promise.resolve({
							stdout: "p12345\nfcwd\nn/home/user/project-feature-auth\n",
							stderr: "",
						});
					}
					return Promise.resolve({ stdout: "", stderr: "" });
				},
			);

			const agents = await scanner.scan();
			expect(agents).toHaveLength(1);
			expect(agents[0]?.worktree?.isLinkedWorktree).toBe(true);
			expect(agents[0]?.worktree?.branch).toBe("feature/auth");
			expect(mockResolveWorktree).toHaveBeenCalledWith(
				"/home/user/project-feature-auth",
			);
		});
	});
});
