import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const auditScriptPath = path.join(
	repoRoot,
	".claude/skills/command-central-vscode-extension/scripts/agent_status_audit.sh",
);

type AuditJson = {
	tasks: {
		total: number;
		running: number;
		by_status: Record<string, number>;
	};
	lanes_projection: {
		found: boolean;
		file: string;
		kind: string;
		lanes: number;
	};
};

/**
 * Runs the audit hermetically: a stubbed `openclaw` keeps the live OpenClaw
 * probes from dominating wall-clock (and makes the test deterministic whether
 * or not openclaw is installed), and isolated --home/--pending-dir keep it off
 * the operator's live state.
 */
function withFixture(
	tasks: unknown,
	fn: (audit: AuditJson) => void,
	options?: { lanes?: unknown },
): void {
	const dir = mkdtempSync(path.join(tmpdir(), "cc-audit-"));
	try {
		const tasksFile = path.join(dir, "tasks.json");
		writeFileSync(tasksFile, JSON.stringify({ version: 2, tasks }));

		if (options?.lanes !== undefined) {
			const lanesFile = path.join(dir, ".config/openclaw/lanes.json");
			mkdirSync(path.dirname(lanesFile), { recursive: true });
			writeFileSync(lanesFile, JSON.stringify(options.lanes));
		}

		const binDir = path.join(dir, "bin");
		mkdirSync(binDir);
		const openclawStub = path.join(binDir, "openclaw");
		writeFileSync(openclawStub, "#!/usr/bin/env bash\necho '[]'\n");
		chmodSync(openclawStub, 0o755);

		const result = spawnSync(
			"bash",
			[
				auditScriptPath,
				"--json",
				"--tasks-file",
				tasksFile,
				"--home",
				dir,
				"--pending-dir",
				path.join(dir, "pending"),
			],
			{
				cwd: repoRoot,
				encoding: "utf-8",
				timeout: 20_000,
				env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
			},
		);

		expect(result.status).toBe(0);
		fn(JSON.parse(result.stdout) as AuditJson);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("agent_status_audit by_status robustness", () => {
	test("reports a full status breakdown for well-formed rows", () => {
		withFixture(
			{
				a: { status: "running" },
				b: { status: "completed" },
				c: { status: "completed" },
				d: { status: "failed" },
			},
			(audit) => {
				expect(audit.tasks.total).toBe(4);
				expect(audit.tasks.running).toBe(1);
				expect(audit.tasks.by_status).toEqual({
					running: 1,
					completed: 2,
					failed: 1,
				});
			},
		);
	});

	test("does not collapse the breakdown when a row has null/missing status", () => {
		// Malformed launcher-era rows without a status occur in live registries.
		// A null group key used to make jq's from_entries error and silently
		// zero out the entire by_status object, hiding even the valid counts.
		withFixture(
			{
				a: { status: "running" },
				b: { status: "completed" },
				c: {}, // missing status
				d: { status: null }, // explicit null status
			},
			(audit) => {
				expect(audit.tasks.total).toBe(4);
				expect(audit.tasks.running).toBe(1);
				// The breakdown stays honest and surfaces malformed rows as "unknown".
				expect(audit.tasks.by_status).toEqual({
					running: 1,
					completed: 1,
					unknown: 2,
				});
				// Regression guard: the object is never silently empty.
				expect(Object.keys(audit.tasks.by_status).length).toBeGreaterThan(0);
			},
		);
	});
});

describe("agent_status_audit lanes projection visibility", () => {
	// Regression (2026-07-04): the audit reported all-zero while 454 projection
	// lanes still fed the tree — the second registry feed was invisible to the
	// operator tooling. The audit must surface it.
	test("reports the Work System lanes projection when present", () => {
		withFixture(
			{},
			(audit) => {
				expect(audit.lanes_projection.found).toBe(true);
				expect(audit.lanes_projection.kind).toBe(
					"work-system-lanes-projection",
				);
				expect(audit.lanes_projection.lanes).toBe(2);
			},
			{
				lanes: {
					version: 1,
					kind: "work-system-lanes-projection",
					lanes: { "launcher:a": {}, "launcher:b": {} },
					updated_at: "2026-07-04T00:00:00Z",
				},
			},
		);
	});

	test("reports absence honestly when no projection exists", () => {
		withFixture({}, (audit) => {
			expect(audit.lanes_projection.found).toBe(false);
			expect(audit.lanes_projection.lanes).toBe(0);
		});
	});
});
