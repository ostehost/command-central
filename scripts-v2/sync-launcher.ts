#!/usr/bin/env bun
/**
 * Syncs the launcher script from the external development repo.
 * Run: bun run scripts-v2/sync-launcher.ts
 *
 * The ghostty-launcher repo is the canonical source for the launcher script.
 * This script copies the latest version to the extension's resources/bin directory
 * for bundling with the VSIX package.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const SOURCE_REPO =
	process.env.LAUNCHER_SOURCE ||
	path.join(process.env.HOME!, "projects", "ghostty-launcher");
const SOURCE_SCRIPT = path.join(SOURCE_REPO, "launcher");
const DEST_SCRIPT = "resources/bin/ghostty-launcher";
const VERSION_FILE = "resources/bin/.launcher-version";

// Helper scripts that the launcher and extension invoke at runtime.
// Mirrored from upstream `scripts/` into `resources/bin/scripts/` so end-users
// who don't have the ghostty-launcher source repo still get a working bundle.
// `TerminalManager.resolveLauncherHelperScriptPath()` looks for these adjacent
// to the launcher binary (`resources/bin/scripts/<name>`).
const SOURCE_SCRIPTS_DIR = path.join(SOURCE_REPO, "scripts");
const DEST_SCRIPTS_DIR = "resources/bin/scripts";
const HELPER_TOP_LEVEL_FILES = ["oste-steer.sh", "routing-policy.json"];

async function copyExecutable(src: string, dest: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(dest), { recursive: true });
	await fs.promises.copyFile(src, dest);
	if (src.endsWith(".sh")) {
		await fs.promises.chmod(dest, 0o755);
	}
}

interface HelperSyncResult {
	copied: string[];
	skipped: string[];
}

interface HelperCheckResult {
	outOfSync: string[];
	skipped: string[];
}

async function filesMatch(src: string, dest: string): Promise<boolean> {
	if (!fs.existsSync(src) || !fs.existsSync(dest)) return false;
	const [sourceContent, destContent] = await Promise.all([
		fs.promises.readFile(src),
		fs.promises.readFile(dest),
	]);
	return Buffer.compare(sourceContent, destContent) === 0;
}

async function checkHelpers(): Promise<HelperCheckResult> {
	const outOfSync: string[] = [];
	const skipped: string[] = [];

	if (!fs.existsSync(SOURCE_SCRIPTS_DIR)) {
		return { outOfSync, skipped };
	}

	for (const name of HELPER_TOP_LEVEL_FILES) {
		const src = path.join(SOURCE_SCRIPTS_DIR, name);
		const dest = path.join(DEST_SCRIPTS_DIR, name);
		if (!fs.existsSync(src)) {
			skipped.push(name);
			continue;
		}
		if (!(await filesMatch(src, dest))) outOfSync.push(name);
	}

	const libSrc = path.join(SOURCE_SCRIPTS_DIR, "lib");
	const libDest = path.join(DEST_SCRIPTS_DIR, "lib");
	const expectedLibEntries = new Set<string>();
	if (fs.existsSync(libSrc)) {
		for (const entry of await fs.promises.readdir(libSrc)) {
			if (!entry.endsWith(".sh") && !entry.endsWith(".py")) continue;
			expectedLibEntries.add(entry);
			if (!(await filesMatch(path.join(libSrc, entry), path.join(libDest, entry)))) {
				outOfSync.push(`lib/${entry}`);
			}
		}
	}
	if (fs.existsSync(libDest)) {
		for (const entry of await fs.promises.readdir(libDest)) {
			if (!entry.endsWith(".sh") && !entry.endsWith(".py")) continue;
			if (!expectedLibEntries.has(entry)) outOfSync.push(`lib/${entry}`);
		}
	}

	return { outOfSync, skipped };
}

async function syncHelpers(): Promise<HelperSyncResult> {
	const copied: string[] = [];
	const skipped: string[] = [];

	if (!fs.existsSync(SOURCE_SCRIPTS_DIR)) {
		return { copied, skipped };
	}

	for (const name of HELPER_TOP_LEVEL_FILES) {
		const src = path.join(SOURCE_SCRIPTS_DIR, name);
		const dest = path.join(DEST_SCRIPTS_DIR, name);
		if (!fs.existsSync(src)) {
			skipped.push(name);
			continue;
		}
		await copyExecutable(src, dest);
		copied.push(name);
	}

	const libSrc = path.join(SOURCE_SCRIPTS_DIR, "lib");
	if (fs.existsSync(libSrc)) {
		const libDest = path.join(DEST_SCRIPTS_DIR, "lib");
		// Clean stale .sh files in destination lib (handles upstream removals)
		// without nuking unrelated content the user may have added.
		if (fs.existsSync(libDest)) {
			for (const entry of await fs.promises.readdir(libDest)) {
				if (entry.endsWith(".sh") || entry.endsWith(".py")) {
					await fs.promises.unlink(path.join(libDest, entry));
				}
			}
		}
		for (const entry of await fs.promises.readdir(libSrc)) {
			if (!entry.endsWith(".sh") && !entry.endsWith(".py")) continue;
			await copyExecutable(
				path.join(libSrc, entry),
				path.join(libDest, entry),
			);
			copied.push(`lib/${entry}`);
		}
	}

	return { copied, skipped };
}

async function getVersion(scriptPath: string): Promise<string> {
	const content = await fs.promises.readFile(scriptPath, "utf-8");
	const match = content.match(/VERSION="([^"]+)"/);
	return match?.[1] || "unknown";
}

async function main() {
	const args = process.argv.slice(2);
	const isCheck = args.includes("--check");
	const isVerbose = args.includes("--verbose") || args.includes("-v");
	const isHelp = args.includes("--help") || args.includes("-h");

	if (isHelp) {
		console.log(`
Usage: bun run scripts-v2/sync-launcher.ts [OPTIONS]

Syncs the launcher script from the external development repo.

Options:
  --check     Check if sync is needed (exits 1 if out of sync)
  --verbose   Show detailed diff information
  --help      Show this help message

Environment:
  LAUNCHER_SOURCE   Override source repo path (default: ~/projects/ghostty-launcher)

Examples:
  bun run scripts-v2/sync-launcher.ts           # Sync launcher
  bun run scripts-v2/sync-launcher.ts --check   # Check if out of sync
  just sync-launcher                             # Via justfile
`);
		process.exit(0);
	}

	// Check source exists
	if (!fs.existsSync(SOURCE_SCRIPT)) {
		console.error(`Source not found: ${SOURCE_SCRIPT}`);
		console.error(
			"\nThe launcher source repo is expected at ~/projects/ghostty-launcher",
		);
		console.error("Set LAUNCHER_SOURCE environment variable to override.");
		process.exit(1);
	}

	const sourceVersion = await getVersion(SOURCE_SCRIPT);
	const currentVersion = fs.existsSync(VERSION_FILE)
		? (await fs.promises.readFile(VERSION_FILE, "utf-8")).trim()
		: "none";

	console.log(`Source version:  ${sourceVersion} (${SOURCE_REPO})`);
	console.log(`Bundled version: ${currentVersion}`);

	// Compare content, not just version
	const sourceContent = await fs.promises.readFile(SOURCE_SCRIPT);
	const destContent = fs.existsSync(DEST_SCRIPT)
		? await fs.promises.readFile(DEST_SCRIPT)
		: Buffer.from("");

	const isInSync = Buffer.compare(sourceContent, destContent) === 0;

	if (isInSync) {
		console.log("\n✅ Launcher binary already in sync");
		if (isCheck) {
			const helperResult = await checkHelpers();
			if (helperResult.outOfSync.length > 0) {
				console.log("\n❌ Helper sync needed:");
				for (const helper of helperResult.outOfSync) {
					console.log(`   • ${DEST_SCRIPTS_DIR}/${helper}`);
				}
				console.log("\nRun 'just sync-launcher' to update bundled helpers.");
				process.exit(1);
			}
			console.log("✅ Launcher helpers already in sync");
			return;
		}
		const helperResult = await syncHelpers();
		if (helperResult.copied.length > 0) {
			console.log(
				`   Refreshed ${helperResult.copied.length} helper file${helperResult.copied.length === 1 ? "" : "s"} in ${DEST_SCRIPTS_DIR}/`,
			);
		}
		return;
	}

	// Files differ
	const sourceLines = sourceContent.toString().split("\n").length;
	const destLines = destContent.toString().split("\n").length;
	const lineDiff = sourceLines - destLines;

	console.log("\n⚠️  Files differ:");
	console.log(`   Source: ${sourceLines} lines`);
	console.log(`   Bundled: ${destLines} lines`);
	console.log(`   Difference: ${lineDiff > 0 ? "+" : ""}${lineDiff} lines`);

	if (isVerbose) {
		// Show a summary of changes using diff
		const { $ } = await import("bun");
		try {
			const result = await $`diff -u ${DEST_SCRIPT} ${SOURCE_SCRIPT} | head -50`
				.text()
				.catch(() => "");
			if (result) {
				console.log("\nDiff preview (first 50 lines):");
				console.log(result);
			}
		} catch {
			// Diff returns non-zero when files differ, which is expected
		}
	}

	if (isCheck) {
		console.log("\n❌ Sync needed. Run 'just sync-launcher' to update.");
		process.exit(1);
	}

	// Perform the sync
	console.log("\n🔄 Syncing...");

	// Ensure destination directory exists
	const destDir = path.dirname(DEST_SCRIPT);
	if (!fs.existsSync(destDir)) {
		await fs.promises.mkdir(destDir, { recursive: true });
	}

	// Copy file
	await fs.promises.copyFile(SOURCE_SCRIPT, DEST_SCRIPT);

	// Update version file
	await fs.promises.writeFile(VERSION_FILE, sourceVersion + "\n");

	// Ensure executable
	await fs.promises.chmod(DEST_SCRIPT, 0o755);

	console.log(`✅ Synced to version ${sourceVersion}`);
	console.log(`   ${DEST_SCRIPT}`);
	console.log(`   ${VERSION_FILE}`);

	// Sync helper scripts so the bundled launcher works without the upstream repo.
	const helperResult = await syncHelpers();
	if (helperResult.copied.length > 0) {
		console.log(
			`   ${DEST_SCRIPTS_DIR}/ (${helperResult.copied.length} helper file${helperResult.copied.length === 1 ? "" : "s"})`,
		);
	}
	if (helperResult.skipped.length > 0) {
		console.log(
			`   ⚠️  Skipped (not present upstream): ${helperResult.skipped.join(", ")}`,
		);
	}

	console.log("\n💡 Run 'git diff' to review changes before committing.");
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
