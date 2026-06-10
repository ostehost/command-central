import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isHelperLibEntry } from "../../scripts-v2/sync-launcher.ts";

const SYNC_SCRIPT = path.resolve(
	import.meta.dir,
	"../../scripts-v2/sync-launcher.ts",
);

const PROBE_CONTENT = 'on run argv\n\treturn "true|1|1|1|123|ok"\nend run\n';

function writeSourceRepo(root: string): void {
	const libDir = path.join(root, "scripts", "lib");
	fs.mkdirSync(libDir, { recursive: true });
	fs.writeFileSync(
		path.join(root, "launcher"),
		'#!/bin/bash\nVERSION="9.9.9"\n',
		{
			mode: 0o755,
		},
	);
	fs.writeFileSync(
		path.join(root, "scripts", "oste-steer.sh"),
		"#!/bin/bash\n",
		{
			mode: 0o755,
		},
	);
	fs.writeFileSync(path.join(root, "scripts", "routing-policy.json"), "{}\n");
	fs.writeFileSync(path.join(libDir, "bundle-runtime.sh"), "#!/bin/bash\n", {
		mode: 0o755,
	});
	fs.writeFileSync(path.join(libDir, "stream-formatter.py"), "print()\n");
	fs.writeFileSync(
		path.join(libDir, "window-probe.applescript"),
		PROBE_CONTENT,
	);
	fs.writeFileSync(path.join(libDir, "NOTES.txt"), "do not ship\n");
}

async function runSync(
	cwd: string,
	source: string,
	args: string[] = [],
): Promise<{ exitCode: number; stdout: string }> {
	const proc = Bun.spawn(["bun", "run", SYNC_SCRIPT, ...args], {
		cwd,
		env: { ...process.env, LAUNCHER_SOURCE: source },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;
	return { exitCode: proc.exitCode ?? -1, stdout };
}

describe("isHelperLibEntry", () => {
	test("accepts the runtime helper types the launcher executes", () => {
		expect(isHelperLibEntry("bundle-runtime.sh")).toBe(true);
		expect(isHelperLibEntry("stream-formatter.py")).toBe(true);
		expect(isHelperLibEntry("window-probe.applescript")).toBe(true);
	});

	test("rejects everything else upstream might grow", () => {
		expect(isHelperLibEntry("NOTES.txt")).toBe(false);
		expect(isHelperLibEntry("README.md")).toBe(false);
		expect(isHelperLibEntry("window-probe.applescript.bak")).toBe(false);
		expect(isHelperLibEntry("routing-policy.json")).toBe(false);
	});
});

describe("sync-launcher helper sync", () => {
	let sourceRepo: string;
	let workDir: string;

	beforeEach(() => {
		sourceRepo = fs.mkdtempSync(path.join(os.tmpdir(), "sync-launcher-src-"));
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-launcher-dest-"));
		writeSourceRepo(sourceRepo);
	});

	afterEach(() => {
		fs.rmSync(sourceRepo, { recursive: true, force: true });
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	test("sync bundles applescript lib helpers and --check flags drift", async () => {
		const libDest = path.join(workDir, "resources", "bin", "scripts", "lib");
		const probeDest = path.join(libDest, "window-probe.applescript");

		const sync = await runSync(workDir, sourceRepo);
		expect(sync.exitCode).toBe(0);
		expect(fs.readFileSync(probeDest, "utf-8")).toBe(PROBE_CONTENT);
		expect(fs.existsSync(path.join(libDest, "bundle-runtime.sh"))).toBe(true);
		expect(fs.existsSync(path.join(libDest, "stream-formatter.py"))).toBe(true);
		expect(fs.existsSync(path.join(libDest, "NOTES.txt"))).toBe(false);

		const cleanCheck = await runSync(workDir, sourceRepo, ["--check"]);
		expect(cleanCheck.exitCode).toBe(0);

		// Drift in both directions: a required probe goes missing locally and a
		// stale helper lingers after an upstream removal.
		fs.unlinkSync(probeDest);
		fs.writeFileSync(
			path.join(libDest, "zombie.applescript"),
			"on run\nend run\n",
		);

		const driftCheck = await runSync(workDir, sourceRepo, ["--check"]);
		expect(driftCheck.exitCode).toBe(1);
		expect(driftCheck.stdout).toContain("lib/window-probe.applescript");
		expect(driftCheck.stdout).toContain("lib/zombie.applescript");

		const resync = await runSync(workDir, sourceRepo);
		expect(resync.exitCode).toBe(0);
		expect(fs.readFileSync(probeDest, "utf-8")).toBe(PROBE_CONTENT);
		expect(fs.existsSync(path.join(libDest, "zombie.applescript"))).toBe(false);
	});
});
