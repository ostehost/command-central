/**
 * fresh_slate_reset.sh — manifest/checksum receipt before mutation.
 *
 * The fresh-slate reset must preserve a manifest.json receipt (path +
 * sha256 + size for every file it is about to move) inside the backup
 * directory BEFORE any file is moved, so a reset can always be audited
 * and rolled back against ground truth.
 *
 * Spawns the canonical script from .claude/skills/ against a sandboxed
 * --home/--pending-dir, so no real Agent Status state is touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type * as _fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Use the preload-cached real fs — other test files mock node:fs globally.
const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof _fs;

const SCRIPT_PATH = path.resolve(
	import.meta.dir,
	"../../.claude/skills/command-central-vscode-extension/scripts/fresh_slate_reset.sh",
);

interface ManifestFile {
	path: string;
	sha256: string;
	size: number;
}

interface Manifest {
	script: string;
	version: string;
	created_at: string;
	backup_dir: string;
	files: ManifestFile[];
}

function sha256(contents: string): string {
	return createHash("sha256").update(contents).digest("hex");
}

let sandbox: string;
let home: string;
let pendingDir: string;
let tasksFile: string;
let reviewedFile: string;

const FIXTURES = {
	tasks: '{"version":2,"tasks":{"t1":{"id":"t1","status":"completed"}}}',
	reviewed: '{"version":1,"reviewed":["t1"]}',
	pending: '{"task_id":"t1"}',
};

beforeEach(() => {
	sandbox = realFs.mkdtempSync(path.join(os.tmpdir(), "fresh-slate-test-"));
	home = path.join(sandbox, "home");
	pendingDir = path.join(sandbox, "pending");
	tasksFile = path.join(home, ".config", "ghostty-launcher", "tasks.json");
	reviewedFile = path.join(
		home,
		".config",
		"command-central",
		"reviewed-tasks.json",
	);

	realFs.mkdirSync(path.dirname(tasksFile), { recursive: true });
	realFs.mkdirSync(path.dirname(reviewedFile), { recursive: true });
	realFs.mkdirSync(pendingDir, { recursive: true });
	realFs.writeFileSync(tasksFile, FIXTURES.tasks, "utf-8");
	realFs.writeFileSync(reviewedFile, FIXTURES.reviewed, "utf-8");
	realFs.writeFileSync(path.join(pendingDir, "t1.json"), FIXTURES.pending);
});

afterEach(() => {
	realFs.rmSync(sandbox, { recursive: true, force: true });
});

function runReset(args: string[]): {
	exitCode: number;
	stdout: string;
	stderr: string;
} {
	const result = Bun.spawnSync(
		[
			"bash",
			SCRIPT_PATH,
			"--home",
			home,
			"--workspace",
			sandbox,
			"--pending-dir",
			pendingDir,
			"--backup-root",
			path.join(sandbox, "backups"),
			...args,
		],
		{ env: { ...process.env, TASKS_FILE: "" } },
	);
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

describe("fresh_slate_reset.sh manifest receipt", () => {
	test("apply writes manifest.json with sha256 receipts for every moved file", () => {
		const result = runReset(["--apply", "--json"]);
		expect(result.exitCode).toBe(0);

		const output = JSON.parse(result.stdout) as {
			backup_dir: string;
			manifest: string;
			moved_count: number;
		};
		expect(output.manifest).toBe(path.join(output.backup_dir, "manifest.json"));
		expect(realFs.existsSync(output.manifest)).toBe(true);

		const manifest = JSON.parse(
			realFs.readFileSync(output.manifest, "utf-8"),
		) as Manifest;
		expect(manifest.script).toBe("fresh_slate_reset.sh");
		expect(manifest.backup_dir).toBe(output.backup_dir);
		expect(manifest.files).toHaveLength(3);

		const byPath = new Map(manifest.files.map((f) => [f.path, f]));
		expect(byPath.get(tasksFile)?.sha256).toBe(sha256(FIXTURES.tasks));
		expect(byPath.get(tasksFile)?.size).toBe(FIXTURES.tasks.length);
		expect(byPath.get(reviewedFile)?.sha256).toBe(sha256(FIXTURES.reviewed));
		expect(byPath.get(path.join(pendingDir, "t1.json"))?.sha256).toBe(
			sha256(FIXTURES.pending),
		);
	});

	test("manifest checksums match the backed-up file contents (receipt is ground truth)", () => {
		const result = runReset(["--apply", "--json"]);
		expect(result.exitCode).toBe(0);

		const output = JSON.parse(result.stdout) as { backup_dir: string };
		const backedUpTasks = realFs.readFileSync(
			path.join(output.backup_dir, "tasks.json"),
			"utf-8",
		);
		const backedUpReviewed = realFs.readFileSync(
			path.join(output.backup_dir, "reviewed-tasks.json"),
			"utf-8",
		);
		const backedUpPending = realFs.readFileSync(
			path.join(output.backup_dir, "pending-review", "t1.json"),
			"utf-8",
		);

		const manifest = JSON.parse(
			realFs.readFileSync(
				path.join(output.backup_dir, "manifest.json"),
				"utf-8",
			),
		) as Manifest;
		const shas = new Set(manifest.files.map((f) => f.sha256));
		expect(shas.has(sha256(backedUpTasks))).toBe(true);
		expect(shas.has(sha256(backedUpReviewed))).toBe(true);
		expect(shas.has(sha256(backedUpPending))).toBe(true);
	});

	test("apply recreates empty scaffolds after backing up", () => {
		const result = runReset(["--apply", "--json"]);
		expect(result.exitCode).toBe(0);

		expect(JSON.parse(realFs.readFileSync(tasksFile, "utf-8"))).toEqual({
			version: 2,
			tasks: {},
		});
		expect(JSON.parse(realFs.readFileSync(reviewedFile, "utf-8"))).toEqual({
			version: 1,
			reviewed: [],
		});
		expect(
			realFs.readdirSync(pendingDir).filter((f) => f.endsWith(".json")),
		).toHaveLength(0);
	});

	test("dry-run writes no manifest and moves nothing", () => {
		const result = runReset(["--dry-run", "--json"]);
		expect(result.exitCode).toBe(0);

		expect(realFs.existsSync(path.join(sandbox, "backups"))).toBe(false);
		expect(realFs.readFileSync(tasksFile, "utf-8")).toBe(FIXTURES.tasks);
		expect(realFs.readFileSync(reviewedFile, "utf-8")).toBe(FIXTURES.reviewed);
	});

	test("refuses --apply while running tasks exist (no manifest, no mutation)", () => {
		realFs.writeFileSync(
			tasksFile,
			'{"version":2,"tasks":{"t1":{"id":"t1","status":"running"}}}',
			"utf-8",
		);
		const result = runReset(["--apply", "--json"]);
		expect(result.exitCode).toBe(1);
		expect(realFs.existsSync(path.join(sandbox, "backups"))).toBe(false);
		expect(JSON.parse(result.stdout).error).toBe("running_tasks_detected");
	});
});
