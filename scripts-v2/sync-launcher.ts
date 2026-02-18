#!/usr/bin/env bun
/**
 * Syncs the launcher script from the external development repo.
 * Run: bun run scripts-v2/sync-launcher.ts
 *
 * The ghostty-dock-launcher-v1 repo is the canonical source for the launcher script.
 * This script copies the latest version to the extension's resources/bin directory
 * for bundling with the VSIX package.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const SOURCE_REPO =
	process.env.LAUNCHER_SOURCE ||
	path.join(process.env.HOME!, "ghostty-dock-launcher-v1");
const SOURCE_SCRIPT = path.join(SOURCE_REPO, "ghostty");
const DEST_SCRIPT = "resources/bin/ghostty-launcher";
const VERSION_FILE = "resources/bin/.launcher-version";

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
  LAUNCHER_SOURCE   Override source repo path (default: ~/ghostty-dock-launcher-v1)

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
			"\nThe launcher source repo is expected at ~/ghostty-dock-launcher-v1",
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
		console.log("\n✅ Already in sync");
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
	console.log("\n💡 Run 'git diff' to review changes before committing.");
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
