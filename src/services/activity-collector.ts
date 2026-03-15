/**
 * Activity Collector — Parses git log to extract agent activity events
 *
 * Scans workspace folders for commits with agent co-author trailers
 * and produces a unified, chronologically sorted event stream.
 */

import { exec } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { ActivityEvent } from "./activity-event-types.js";

const execAsync = promisify(exec);

/** Email patterns that identify agent-authored commits */
const AGENT_EMAIL_PATTERNS = [
	"noreply@anthropic.com",
	"claude@agent.local",
	"oste@agent.local",
];

/** Null byte separator used in git log format */
const SEP = "\x00";

/** Git log format: hash, ISO date, subject, body, author name, author email */
const GIT_LOG_FORMAT = `${"%H"}${SEP}${"%aI"}${SEP}${"%s"}${SEP}${"%b"}${SEP}${"%an"}${SEP}${"%ae"}`;

interface CoAuthor {
	name: string;
	email: string;
}

export class ActivityCollector {
	/**
	 * Collect agent activity events from all workspace folders
	 */
	async collectEvents(
		workspaceFolders: string[],
		lookbackDays: number,
	): Promise<ActivityEvent[]> {
		const allEvents: ActivityEvent[] = [];

		for (const dir of workspaceFolders) {
			const events = await this.parseGitLog(dir, lookbackDays);
			allEvents.push(...events);
		}

		allEvents.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
		return allEvents;
	}

	/**
	 * Parse git log for a single directory and extract agent commit events
	 */
	private async parseGitLog(
		dir: string,
		lookbackDays: number,
	): Promise<ActivityEvent[]> {
		const sinceArg = `${lookbackDays} days ago`;
		const cmd = `git log --all --format="${GIT_LOG_FORMAT}" --numstat --since="${sinceArg}"`;

		let stdout: string;
		try {
			const result = await execAsync(cmd, {
				cwd: dir,
				maxBuffer: 10 * 1024 * 1024,
			});
			stdout = result.stdout;
		} catch {
			return [];
		}

		if (!stdout.trim()) {
			return [];
		}

		return this.parseGitOutput(stdout, dir);
	}

	/**
	 * Parse raw git log output into activity events
	 */
	private parseGitOutput(stdout: string, dir: string): ActivityEvent[] {
		const events: ActivityEvent[] = [];
		const projectName = basename(dir);

		// Split into commit blocks: each starts with a SHA line (40 hex chars before first SEP)
		const commits = this.splitCommits(stdout);

		for (const commitBlock of commits) {
			const event = this.parseCommitBlock(commitBlock, projectName, dir);
			if (event) {
				events.push(event);
			}
		}

		return events;
	}

	/**
	 * Split raw git log output into individual commit blocks
	 */
	private splitCommits(stdout: string): string[] {
		const lines = stdout.split("\n");
		const commits: string[] = [];
		let current: string[] = [];

		for (const line of lines) {
			// A new commit block starts with a line containing our SEP character
			// and the first field is a 40-char hex SHA
			if (line.includes(SEP)) {
				const sha = line.split(SEP)[0];
				if (/^[0-9a-f]{40}$/i.test(sha)) {
					if (current.length > 0) {
						commits.push(current.join("\n"));
					}
					current = [line];
					continue;
				}
			}
			current.push(line);
		}

		if (current.length > 0) {
			commits.push(current.join("\n"));
		}

		return commits;
	}

	/**
	 * Parse a single commit block into an ActivityEvent (if it's an agent commit)
	 */
	private parseCommitBlock(
		block: string,
		projectName: string,
		dir: string,
	): ActivityEvent | null {
		const lines = block.split("\n");
		const headerLine = lines[0];
		const parts = headerLine.split(SEP);

		if (parts.length < 6) {
			return null;
		}

		const [sha, dateStr, subject, body, authorName, authorEmail] = parts;
		const coAuthors = this.parseCoAuthors(body);

		if (!this.isAgentCommit(authorEmail, coAuthors)) {
			return null;
		}

		// Parse numstat lines for file change counts
		const numstatLines = lines.slice(1).filter((l) => /^\d+\t\d+\t/.test(l));
		let insertions = 0;
		let deletions = 0;
		for (const line of numstatLines) {
			const [ins, del] = line.split("\t");
			insertions += Number.parseInt(ins, 10) || 0;
			deletions += Number.parseInt(del, 10) || 0;
		}

		// Determine agent name from co-author or author
		const agentCoAuthor = coAuthors.find((ca) =>
			AGENT_EMAIL_PATTERNS.some((pattern) =>
				ca.email.toLowerCase().includes(pattern),
			),
		);
		const agentName = agentCoAuthor ? agentCoAuthor.name : authorName;

		return {
			id: sha,
			timestamp: new Date(dateStr),
			agent: { name: agentName },
			action: {
				type: "commit",
				sha,
				message: subject,
				filesChanged: numstatLines.length,
				insertions,
				deletions,
			},
			project: { name: projectName, dir },
		};
	}

	/**
	 * Extract Co-Authored-By trailers from commit body
	 */
	private parseCoAuthors(body: string): CoAuthor[] {
		const coAuthors: CoAuthor[] = [];
		const pattern = /Co-Authored-By:\s*(.+?)\s*<([^>]+)>/gi;
		let match: RegExpExecArray | null;

		while ((match = pattern.exec(body)) !== null) {
			coAuthors.push({ name: match[1].trim(), email: match[2].trim() });
		}

		return coAuthors;
	}

	/**
	 * Determine if a commit was made by or with an agent
	 */
	private isAgentCommit(authorEmail: string, coAuthors: CoAuthor[]): boolean {
		const emailLower = authorEmail.toLowerCase();

		// Check if the author is an agent
		if (AGENT_EMAIL_PATTERNS.some((pattern) => emailLower.includes(pattern))) {
			return true;
		}

		// Check if any co-author is an agent
		return coAuthors.some((ca) =>
			AGENT_EMAIL_PATTERNS.some((pattern) =>
				ca.email.toLowerCase().includes(pattern),
			),
		);
	}
}
