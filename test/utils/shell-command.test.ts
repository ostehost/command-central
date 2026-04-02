import { describe, expect, test } from "bun:test";
import {
	buildOsteSpawnCommand,
	joinShellArgs,
	shellQuote,
} from "../../src/utils/shell-command.js";

describe("shell command utilities", () => {
	test("quotes empty argument", () => {
		expect(shellQuote("")).toBe("''");
	});

	test("quotes argument with single quote safely", () => {
		expect(shellQuote("a'b")).toBe("'a'\"'\"'b'");
	});

	test("joins shell args with quoting", () => {
		expect(joinShellArgs(["echo", 'hello "world"', "with spaces"])).toBe(
			"'echo' 'hello \"world\"' 'with spaces'",
		);
	});
});

describe("buildOsteSpawnCommand", () => {
	test("quotes space and double-quote characters in project/prompt values", () => {
		const command = buildOsteSpawnCommand({
			projectDir: '/Users/test/Project "Alpha" Name',
			promptFile: '/tmp/prompt "draft" file.md',
			taskId: 'cc-Project "Alpha" Name-abc123',
			role: "developer",
		});

		expect(command).toBe(
			"'oste-spawn.sh' '/Users/test/Project \"Alpha\" Name' '/tmp/prompt \"draft\" file.md' '--task-id' 'cc-Project \"Alpha\" Name-abc123' '--role' 'developer'",
		);
	});

	test("omits role and backend when not provided", () => {
		const command = buildOsteSpawnCommand({
			projectDir: "/Users/test/project",
			promptFile: "/tmp/task.md",
			taskId: "cc-task-1",
		});

		expect(command).toBe(
			"'oste-spawn.sh' '/Users/test/project' '/tmp/task.md' '--task-id' 'cc-task-1'",
		);
	});

	test("includes backend only when explicitly provided", () => {
		const command = buildOsteSpawnCommand({
			projectDir: "/Users/test/project",
			promptFile: "/tmp/task.md",
			taskId: "cc-task-2",
			backend: "gemini",
		});

		expect(command).toContain("'--agent' 'gemini'");
	});
});
