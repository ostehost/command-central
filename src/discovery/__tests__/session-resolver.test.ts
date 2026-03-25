import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	escapeProjectPath,
	resolveClaudeSessionId,
} from "../session-resolver.js";

describe("escapeProjectPath", () => {
	test("replaces all slashes with dashes", () => {
		expect(escapeProjectPath("/Users/ostemini/projects/command-central")).toBe(
			"-Users-ostemini-projects-command-central",
		);
	});

	test("handles root path", () => {
		expect(escapeProjectPath("/")).toBe("-");
	});

	test("handles path with no leading slash", () => {
		expect(escapeProjectPath("relative/path")).toBe("relative-path");
	});
});

describe("resolveClaudeSessionId", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-resolver-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("returns most recent session UUID for known project", async () => {
		const projectDir = "/Users/ostemini/projects/command-central";
		const escaped = "-Users-ostemini-projects-command-central";
		const sessionsDir = path.join(tmpDir, escaped);
		fs.mkdirSync(sessionsDir, { recursive: true });

		const oldFile = path.join(sessionsDir, "old-uuid-1111.jsonl");
		const newFile = path.join(sessionsDir, "new-uuid-2222.jsonl");

		fs.writeFileSync(oldFile, "");
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(oldFile, past, past);

		fs.writeFileSync(newFile, "");

		const result = await resolveClaudeSessionId(projectDir, tmpDir);
		expect(result).toBe("new-uuid-2222");
	});

	test("returns null for unknown project", async () => {
		const result = await resolveClaudeSessionId("/nonexistent/project", tmpDir);
		expect(result).toBeNull();
	});

	test("returns null for missing base directory", async () => {
		const result = await resolveClaudeSessionId(
			"/some/project",
			path.join(tmpDir, "nonexistent"),
		);
		expect(result).toBeNull();
	});

	test("returns null for empty session directory", async () => {
		const projectDir = "/Users/ostemini/projects/empty-project";
		const escaped = "-Users-ostemini-projects-empty-project";
		const sessionsDir = path.join(tmpDir, escaped);
		fs.mkdirSync(sessionsDir, { recursive: true });

		const result = await resolveClaudeSessionId(projectDir, tmpDir);
		expect(result).toBeNull();
	});

	test("ignores non-jsonl files", async () => {
		const projectDir = "/Users/ostemini/projects/mixed-project";
		const escaped = "-Users-ostemini-projects-mixed-project";
		const sessionsDir = path.join(tmpDir, escaped);
		fs.mkdirSync(sessionsDir, { recursive: true });

		fs.writeFileSync(path.join(sessionsDir, "notes.txt"), "");
		fs.writeFileSync(path.join(sessionsDir, "abc-def-123.jsonl"), "");

		const result = await resolveClaudeSessionId(projectDir, tmpDir);
		expect(result).toBe("abc-def-123");
	});
});
