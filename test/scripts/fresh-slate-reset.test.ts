/**
 * Integration tests for fresh_slate_reset.sh — the backup-first operator
 * reset for Agent Status state.
 *
 * Locks in the v1.3.0 contract that the reset covers ALL registry feeds the
 * tree reads — the launcher tasks.json AND the Work System lanes projection
 * (~/.config/openclaw/lanes.json). Regression: the 2026-07-04 fresh-slate
 * pass emptied tasks.json but left 454 projection lanes feeding the tree,
 * so "reset" did not actually isolate new work.
 *
 * Every run is hermetic: --home/--tasks-file/--pending-dir/--backup-root all
 * point into a mkdtemp sandbox, so the operator's live state is never read
 * or mutated.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
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
const resetScriptPath = path.join(
	repoRoot,
	".claude/skills/command-central-vscode-extension/scripts/fresh_slate_reset.sh",
);

const LANES_KIND = "work-system-lanes-projection";

interface Sandbox {
	home: string;
	tasksFile: string;
	lanesFile: string;
	pendingDir: string;
	backupRoot: string;
}

function makeSandbox(options?: {
	tasks?: Record<string, unknown>;
	lanes?: Record<string, unknown> | null;
	lanesKind?: string;
}): Sandbox {
	const home = mkdtempSync(path.join(tmpdir(), "cc-fresh-slate-"));
	const tasksFile = path.join(home, ".config/ghostty-launcher/tasks.json");
	mkdirSync(path.dirname(tasksFile), { recursive: true });
	writeFileSync(
		tasksFile,
		JSON.stringify({ version: 2, tasks: options?.tasks ?? {} }),
	);

	const lanesFile = path.join(home, ".config/openclaw/lanes.json");
	if (options?.lanes !== null) {
		mkdirSync(path.dirname(lanesFile), { recursive: true });
		writeFileSync(
			lanesFile,
			JSON.stringify({
				version: 1,
				kind: options?.lanesKind ?? LANES_KIND,
				lanes: options?.lanes ?? {},
				updated_at: "2026-07-04T00:00:00Z",
			}),
		);
	}

	return {
		home,
		tasksFile,
		lanesFile,
		pendingDir: path.join(home, "pending"),
		backupRoot: path.join(home, "backups"),
	};
}

function runReset(
	sandbox: Sandbox,
	extraArgs: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(
		"bash",
		[
			resetScriptPath,
			"--json",
			"--home",
			sandbox.home,
			"--tasks-file",
			sandbox.tasksFile,
			"--pending-dir",
			sandbox.pendingDir,
			"--backup-root",
			sandbox.backupRoot,
			...extraArgs,
		],
		{ cwd: repoRoot, encoding: "utf-8", timeout: 20_000 },
	);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function readJson(filePath: string): Record<string, unknown> {
	return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

describe("fresh_slate_reset.sh — lanes projection coverage", () => {
	test("dry-run inventories the lanes projection and mutates nothing", () => {
		const sandbox = makeSandbox({
			tasks: { t1: { status: "completed" } },
			lanes: { "launcher:t1": { lane_ref: { task: "t1" } } },
		});
		try {
			const { status, stdout } = runReset(sandbox);
			expect(status).toBe(0);

			const report = JSON.parse(stdout);
			expect(report.mode).toBe("dry-run");
			expect(report.would_move.lanes_projection).toEqual({
				file: sandbox.lanesFile,
				lanes: 1,
			});
			expect(report.would_recreate.lanes_file).toBe(sandbox.lanesFile);

			// Nothing moved: both files intact with original content.
			expect(
				(readJson(sandbox.lanesFile)["lanes"] as object) ?? {},
			).toHaveProperty("launcher:t1");
			expect(readJson(sandbox.tasksFile)["tasks"]).toHaveProperty("t1");
		} finally {
			rmSync(sandbox.home, { recursive: true, force: true });
		}
	});

	test("apply archives the projection and recreates the canonical empty shape", () => {
		const sandbox = makeSandbox({
			tasks: { t1: { status: "completed" } },
			lanes: {
				"launcher:t1": { lane_ref: { task: "t1", status: "completed" } },
				"launcher:t2": { lane_ref: { task: "t2", status: "failed" } },
			},
		});
		try {
			const { status, stdout } = runReset(sandbox, ["--apply"]);
			expect(status).toBe(0);

			const report = JSON.parse(stdout);
			expect(report.mode).toBe("apply");
			expect(report.post_reset.lanes_projection).toBe(0);
			expect(report.post_reset.tasks).toBe(0);

			// Recreated scaffold is the canonical projection shape.
			const scaffold = readJson(sandbox.lanesFile);
			expect(scaffold["kind"]).toBe(LANES_KIND);
			expect(scaffold["version"]).toBe(1);
			expect(scaffold["lanes"]).toEqual({});
			expect(typeof scaffold["updated_at"]).toBe("string");

			// Original projection is preserved in the backup with its 2 lanes,
			// and the manifest records it (path + sha + size receipt).
			const backupDir = String(report.backup_dir);
			const archived = readJson(path.join(backupDir, "lanes.json"));
			expect(Object.keys(archived["lanes"] as object)).toHaveLength(2);
			const manifest = readJson(path.join(backupDir, "manifest.json"));
			const manifestPaths = (manifest["files"] as Array<{ path: string }>).map(
				(f) => f.path,
			);
			expect(manifestPaths).toContain(sandbox.lanesFile);
		} finally {
			rmSync(sandbox.home, { recursive: true, force: true });
		}
	});

	test("a lanes-path file with a different kind is never touched", () => {
		const sandbox = makeSandbox({
			tasks: {},
			lanes: { anything: {} },
			lanesKind: "some-other-openclaw-document",
		});
		try {
			const { status, stdout, stderr } = runReset(sandbox, ["--apply"]);
			expect(status).toBe(0);
			expect(stderr).toContain("leaving it untouched");

			const report = JSON.parse(stdout);
			// Untouched: original content still in place, nothing archived.
			const survivor = readJson(sandbox.lanesFile);
			expect(survivor["kind"]).toBe("some-other-openclaw-document");
			expect(survivor["lanes"]).toHaveProperty("anything");
			const backupDir = String(report.backup_dir);
			expect(existsSync(path.join(backupDir, "lanes.json"))).toBe(false);
		} finally {
			rmSync(sandbox.home, { recursive: true, force: true });
		}
	});

	test("--skip-lanes leaves the projection in place on apply", () => {
		const sandbox = makeSandbox({
			tasks: {},
			lanes: { "launcher:keep-me": {} },
		});
		try {
			const { status } = runReset(sandbox, ["--apply", "--skip-lanes"]);
			expect(status).toBe(0);
			expect(
				(readJson(sandbox.lanesFile)["lanes"] as object) ?? {},
			).toHaveProperty("launcher:keep-me");
		} finally {
			rmSync(sandbox.home, { recursive: true, force: true });
		}
	});

	test("still refuses to apply while launcher tasks are running", () => {
		const sandbox = makeSandbox({
			tasks: { live: { status: "running" } },
			lanes: {},
		});
		try {
			const { status, stdout } = runReset(sandbox, ["--apply"]);
			expect(status).toBe(1);
			expect(JSON.parse(stdout).error).toBe("running_tasks_detected");
			// Refusal is total: the lanes projection is untouched too.
			expect(readJson(sandbox.lanesFile)["kind"]).toBe(LANES_KIND);
			expect(existsSync(sandbox.backupRoot)).toBe(false);
		} finally {
			rmSync(sandbox.home, { recursive: true, force: true });
		}
	});

	test("absent lanes file: reset proceeds without inventing one", () => {
		const sandbox = makeSandbox({ tasks: {}, lanes: null });
		try {
			const { status, stdout } = runReset(sandbox, ["--apply"]);
			expect(status).toBe(0);
			expect(JSON.parse(stdout).post_reset.lanes_projection).toBe(0);
			// The reset must not create a projection the launcher never wrote.
			expect(existsSync(sandbox.lanesFile)).toBe(false);
			// Guard against stray dirs leaking into the sandbox root.
			expect(readdirSync(sandbox.home).sort()).not.toContain("lanes.json");
		} finally {
			rmSync(sandbox.home, { recursive: true, force: true });
		}
	});
});
