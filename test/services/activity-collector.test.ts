/**
 * ActivityCollector Tests
 *
 * Tests git log output parsing, agent detection heuristics,
 * event merging/sorting, empty repo, and malformed output handling.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// ── Mock data ────────────────────────────────────────────────────────

const SEP = "\x00";

/** Build a fake git log header line */
function gitLogLine(
	sha: string,
	date: string,
	subject: string,
	body: string,
	authorName: string,
	authorEmail: string,
): string {
	return [sha, date, subject, body, authorName, authorEmail].join(SEP);
}

/** Build a complete commit block with optional numstat */
function commitBlock(
	sha: string,
	date: string,
	subject: string,
	body: string,
	authorName: string,
	authorEmail: string,
	numstat: string[] = [],
): string {
	const header = gitLogLine(sha, date, subject, body, authorName, authorEmail);
	if (numstat.length === 0) return header;
	return [header, ...numstat].join("\n");
}

const AGENT_SHA = "a".repeat(40);
const HUMAN_SHA = "b".repeat(40);
const SECOND_SHA = "c".repeat(40);

const AGENT_COMMIT = commitBlock(
	AGENT_SHA,
	"2026-03-15T10:00:00+00:00",
	"feat: add timeline view",
	"Co-Authored-By: Claude Opus 4 <noreply@anthropic.com>",
	"Test User",
	"test@example.com",
	["10\t2\tsrc/timeline.ts", "5\t1\tsrc/types.ts"],
);

const HUMAN_COMMIT = commitBlock(
	HUMAN_SHA,
	"2026-03-15T09:00:00+00:00",
	"docs: update readme",
	"",
	"Human Dev",
	"human@example.com",
	["3\t1\tREADME.md"],
);

const AGENT_DIRECT_COMMIT = commitBlock(
	SECOND_SHA,
	"2026-03-15T08:00:00+00:00",
	"fix: resolve test flake",
	"",
	"Claude Agent",
	"noreply@anthropic.com",
	["1\t1\ttest/fix.ts"],
);

// ── Top-level exec mock ──────────────────────────────────────────────

type ExecCallback = (
	err: Error | null,
	result: { stdout: string; stderr: string } | null,
) => void;

let execHandler: (cmd: string, opts: unknown, cb: ExecCallback) => void = (
	_cmd,
	_opts,
	cb,
) => {
	cb(null, { stdout: "", stderr: "" });
};

const execMock = mock((cmd: string, opts: unknown, cb: ExecCallback) => {
	execHandler(cmd, opts, cb);
});

mock.module("node:child_process", () => ({
	exec: execMock,
}));

// ── Setup ────────────────────────────────────────────────────────────

setupVSCodeMock();

import { ActivityCollector } from "../../src/services/activity-collector.js";

describe("ActivityCollector", () => {
	beforeEach(() => {
		execMock.mockClear();
		execHandler = (_cmd, _opts, cb) => {
			cb(null, { stdout: "", stderr: "" });
		};
	});

	// ── Git log parsing ──────────────────────────────────────────────

	describe("git log parsing", () => {
		test("parses agent commit with co-author trailer", () => {
			const collector = new ActivityCollector();
			const events = collector.parseGitOutput(AGENT_COMMIT, "/mock/project");

			expect(events).toHaveLength(1);
			expect(events[0]?.action.type).toBe("commit");
			if (events[0]?.action.type === "commit") {
				expect(events[0].action.sha).toBe(AGENT_SHA);
				expect(events[0].action.message).toBe("feat: add timeline view");
				expect(events[0].action.filesChanged).toBe(2);
				expect(events[0].action.insertions).toBe(15);
				expect(events[0].action.deletions).toBe(3);
			}
			expect(events[0]?.agent.name).toBe("Claude Opus 4");
			expect(events[0]?.project.name).toBe("project");
		});

		test("parses agent commit where author is the agent directly", () => {
			const collector = new ActivityCollector();
			const events = collector.parseGitOutput(
				AGENT_DIRECT_COMMIT,
				"/mock/repo",
			);

			expect(events).toHaveLength(1);
			expect(events[0]?.agent.name).toBe("Claude Agent");
		});

		test("filters out human-only commits", () => {
			const collector = new ActivityCollector();
			const events = collector.parseGitOutput(HUMAN_COMMIT, "/mock/repo");

			expect(events).toHaveLength(0);
		});

		test("parses numstat correctly with zero values", () => {
			const zeroStatCommit = commitBlock(
				AGENT_SHA,
				"2026-03-15T10:00:00+00:00",
				"chore: empty file",
				"Co-Authored-By: Claude <noreply@anthropic.com>",
				"User",
				"user@test.com",
				["0\t0\tempty.ts"],
			);

			const collector = new ActivityCollector();
			const events = collector.parseGitOutput(zeroStatCommit, "/mock/repo");

			expect(events).toHaveLength(1);
			if (events[0]?.action.type === "commit") {
				expect(events[0].action.filesChanged).toBe(1);
				expect(events[0].action.insertions).toBe(0);
				expect(events[0].action.deletions).toBe(0);
			}
		});
	});

	// ── Agent detection heuristics ───────────────────────────────────

	describe("agent detection heuristics", () => {
		test("noreply@anthropic.com in co-author = agent", () => {
			const commit = commitBlock(
				AGENT_SHA,
				"2026-03-15T10:00:00+00:00",
				"feat: test",
				"Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>",
				"Human",
				"human@gmail.com",
			);

			const collector = new ActivityCollector();
			const events = collector.parseGitOutput(commit, "/mock/repo");

			expect(events).toHaveLength(1);
			expect(events[0]?.agent.name).toBe("Claude Opus 4.6 (1M context)");
		});

		test("normal email = human (no agent detected)", () => {
			const commit = commitBlock(
				HUMAN_SHA,
				"2026-03-15T09:00:00+00:00",
				"fix: typo",
				"",
				"Regular Dev",
				"dev@company.com",
			);

			const collector = new ActivityCollector();
			const events = collector.parseGitOutput(commit, "/mock/repo");

			expect(events).toHaveLength(0);
		});

		test("claude@agent.local in author = agent", () => {
			const commit = commitBlock(
				AGENT_SHA,
				"2026-03-15T10:00:00+00:00",
				"refactor: clean up",
				"",
				"Claude Local",
				"claude@agent.local",
			);

			const collector = new ActivityCollector();
			const events = collector.parseGitOutput(commit, "/mock/repo");

			expect(events).toHaveLength(1);
			expect(events[0]?.agent.name).toBe("Claude Local");
		});
	});

	// ── Event merging and sorting ────────────────────────────────────

	describe("event merging and sorting", () => {
		test("merges events from multiple workspaces sorted by timestamp desc", async () => {
			const olderCommit = commitBlock(
				"d".repeat(40),
				"2026-03-14T10:00:00+00:00",
				"feat: older",
				"Co-Authored-By: Claude <noreply@anthropic.com>",
				"User",
				"user@test.com",
			);

			const newerCommit = commitBlock(
				"e".repeat(40),
				"2026-03-15T12:00:00+00:00",
				"feat: newer",
				"Co-Authored-By: Claude <noreply@anthropic.com>",
				"User",
				"user@test.com",
			);

			const responses = [olderCommit, newerCommit];
			let callIdx = 0;
			const customExec = async (
				_cmd: string,
				_opts?: Record<string, unknown>,
			) => {
				const stdout = responses[callIdx] ?? "";
				callIdx++;
				return { stdout, stderr: "" };
			};

			const collector = new ActivityCollector(customExec);
			const events = await collector.collectEvents(
				["/workspace/a", "/workspace/b"],
				7,
			);

			expect(events).toHaveLength(2);
			// Newest first
			expect(
				events[0]?.action.type === "commit" && events[0].action.message,
			).toBe("feat: newer");
			expect(
				events[1]?.action.type === "commit" && events[1].action.message,
			).toBe("feat: older");
		});

		test("sets project name from directory basename", () => {
			const collector = new ActivityCollector();
			const events = collector.parseGitOutput(
				AGENT_COMMIT,
				"/home/user/projects/my-cool-app",
			);

			expect(events[0]?.project.name).toBe("my-cool-app");
			expect(events[0]?.project.dir).toBe("/home/user/projects/my-cool-app");
		});
	});

	// ── Empty repo ───────────────────────────────────────────────────

	describe("empty repo handling", () => {
		test("returns empty array when git log returns empty output", async () => {
			execHandler = (_cmd, _opts, cb) => {
				cb(null, { stdout: "", stderr: "" });
			};

			const collector = new ActivityCollector();
			const events = await collector.collectEvents(["/empty/repo"], 7);

			expect(events).toEqual([]);
		});

		test("returns empty array when no workspace folders provided", async () => {
			const collector = new ActivityCollector();
			const events = await collector.collectEvents([], 7);

			expect(events).toEqual([]);
		});
	});

	// ── Malformed git output ─────────────────────────────────────────

	describe("malformed git output handling", () => {
		test("returns empty array when git command fails", async () => {
			execHandler = (_cmd, _opts, cb) => {
				cb(new Error("not a git repository"), null);
			};

			const collector = new ActivityCollector();
			const events = await collector.collectEvents(["/not/a/git/repo"], 7);

			expect(events).toEqual([]);
		});

		test("skips commit blocks with insufficient fields", () => {
			// Only 3 fields instead of 6
			const malformed = `${"f".repeat(40)}${SEP}2026-03-15T10:00:00+00:00${SEP}partial`;

			const collector = new ActivityCollector();
			const events = collector.parseGitOutput(malformed, "/mock/repo");

			expect(events).toEqual([]);
		});

		test("handles whitespace-only output gracefully", () => {
			const collector = new ActivityCollector();
			const events = collector.parseGitOutput("   \n\n  \n", "/mock/repo");

			expect(events).toEqual([]);
		});

		test("handles mixed valid and invalid commits", () => {
			const mixed = [
				AGENT_COMMIT,
				`${"f".repeat(40)}${SEP}bad`, // malformed
				HUMAN_COMMIT, // human (filtered)
			].join("\n");

			const collector = new ActivityCollector();
			const events = collector.parseGitOutput(mixed, "/mock/repo");

			// Only the valid agent commit should survive
			expect(events).toHaveLength(1);
			expect(
				events[0]?.action.type === "commit" && events[0].action.message,
			).toBe("feat: add timeline view");
		});
	});
});
