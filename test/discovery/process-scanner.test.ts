/**
 * ProcessScanner tests
 *
 * Validates detection of running Claude Code instances via ps/lsof.
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
		test("parses Claude Code processes from ps output", () => {
			const psOutput = [
				"  PID   STARTED                       COMMAND",
				"12345 Mon Jan  6 14:03:22 2025 /usr/local/bin/claude --model opus --print hello",
				"12346 Mon Jan  6 14:05:00 2025 /usr/bin/node /path/to/claude-code/cli.js --session-id abc123",
			].join("\n");

			const results = scanner.parsePsOutput(psOutput);
			expect(results).toHaveLength(2);
			expect(results[0]?.pid).toBe(12345);
			expect(results[0]?.command).toContain("claude");
			expect(results[1]?.pid).toBe(12346);
		});

		test("filters out non-Claude processes", () => {
			const psOutput = [
				"  PID   STARTED                       COMMAND",
				"11111 Mon Jan  6 14:00:00 2025 /usr/bin/vim test.ts",
				"22222 Mon Jan  6 14:01:00 2025 /usr/bin/node server.js",
				"33333 Mon Jan  6 14:02:00 2025 grep claude",
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
	});
});
