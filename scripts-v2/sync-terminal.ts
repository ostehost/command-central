#!/usr/bin/env bun
/**
 * Syncs the Command Central terminal app from the Ghostty fork.
 * Run: bun run scripts-v2/sync-terminal.ts
 *
 * The ghostty-fork repo is the canonical source for the terminal app.
 * This script:
 * 1. Copies the app bundle (excluding Sparkle.framework)
 * 2. Applies Command Central branding to Info.plist
 * 3. Renames the binary from ghostty to CommandCentral
 * 4. Re-signs the app with ad-hoc signature
 *
 * The resulting app is git-ignored (50MB binary), only the version file is committed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const SOURCE_REPO =
	process.env.TERMINAL_SOURCE ||
	path.join(process.env.HOME!, "ghostty-fork");
const SOURCE_APP = path.join(SOURCE_REPO, "zig-out", "Ghostty.app");
const VERSION_FILE_SOURCE = path.join(SOURCE_REPO, "build.zig.zon");
const DEST_APP = "resources/app/CommandCentral.app";
const VERSION_FILE = "resources/app/.terminal-version";

// Branding configuration
// Note: CFBundleExecutable must remain "ghostty" - binary name is hardcoded internally
const BRANDING = {
	CFBundleDisplayName: "Command Central",
	CFBundleName: "Command Central",
	CFBundleIdentifier: "com.commandcentral.terminal",
} as const;

// Components to exclude (saves ~3 MB)
const EXCLUDE_PATTERNS = ["Frameworks/Sparkle.framework"];

/**
 * Extract version from build.zig.zon
 * Format: .version = "1.3.0-dev",
 */
async function getVersion(): Promise<string> {
	try {
		const content = await fs.promises.readFile(VERSION_FILE_SOURCE, "utf-8");
		const match = content.match(/\.version\s*=\s*"([^"]+)"/);
		return match?.[1] || "unknown";
	} catch {
		return "unknown";
	}
}

/**
 * Get current synced version
 */
async function getCurrentVersion(): Promise<string> {
	try {
		return (await fs.promises.readFile(VERSION_FILE, "utf-8")).trim();
	} catch {
		return "none";
	}
}

/**
 * Sync app bundle using cp -R (more reliable in Bun shell)
 */
async function syncAppBundle(): Promise<void> {
	const { $ } = await import("bun");

	// Ensure destination directory exists
	const destDir = path.dirname(DEST_APP);
	if (!fs.existsSync(destDir)) {
		await fs.promises.mkdir(destDir, { recursive: true });
	}

	// Remove existing app if present
	if (fs.existsSync(DEST_APP)) {
		await fs.promises.rm(DEST_APP, { recursive: true, force: true });
	}

	// Copy the app bundle
	await $`cp -R ${SOURCE_APP}/ ${DEST_APP}/`;

	// Remove excluded components
	for (const pattern of EXCLUDE_PATTERNS) {
		const excludePath = path.join(DEST_APP, "Contents", pattern);
		if (fs.existsSync(excludePath)) {
			await fs.promises.rm(excludePath, { recursive: true, force: true });
		}
	}
}

/**
 * Apply Command Central branding to Info.plist
 */
async function applyBranding(): Promise<void> {
	const { $ } = await import("bun");
	const plistPath = path.join(DEST_APP, "Contents", "Info.plist");

	// Update each branding key using PlistBuddy
	for (const [key, value] of Object.entries(BRANDING)) {
		await $`/usr/libexec/PlistBuddy -c "Set :${key} ${value}" ${plistPath}`.quiet();
	}
}

/**
 * Note: Binary renaming disabled - Ghostty binary has its name hardcoded internally
 * The app bundle is renamed (CommandCentral.app) but the binary stays "ghostty"
 */

/**
 * Re-sign the app with ad-hoc signature
 * Required after modifying Info.plist and renaming binary
 */
async function resignApp(): Promise<void> {
	const { $ } = await import("bun");

	// Ad-hoc signing (no identity needed)
	// --force: replace existing signature
	// --deep: sign nested code (frameworks, helpers)
	await $`codesign --force --deep --sign - ${DEST_APP}`.quiet();
}

/**
 * Check if app bundles differ
 * Uses version comparison (quick check) and binary modification time
 */
async function appBundlesDiffer(sourceVersion: string, currentVersion: string): Promise<boolean> {
	// Quick check: if dest doesn't exist, definitely differs
	if (!fs.existsSync(DEST_APP)) {
		return true;
	}

	// Version mismatch means definitely out of sync
	if (sourceVersion !== currentVersion) {
		return true;
	}

	// Same version - check if source binary is newer than dest binary
	try {
		const sourceBinaryPath = path.join(SOURCE_APP, "Contents", "MacOS", "ghostty");
		const destBinaryPath = path.join(DEST_APP, "Contents", "MacOS", "ghostty");

		const sourceStats = await fs.promises.stat(sourceBinaryPath);
		const destStats = await fs.promises.stat(destBinaryPath).catch(() => ({ mtime: new Date(0) }));

		// If source is newer than dest, needs sync
		return sourceStats.mtime > destStats.mtime;
	} catch {
		return true;
	}
}

async function main() {
	const args = process.argv.slice(2);
	const isCheck = args.includes("--check");
	const isVerbose = args.includes("--verbose") || args.includes("-v");
	const isHelp = args.includes("--help") || args.includes("-h");

	if (isHelp) {
		console.log(`
Usage: bun run scripts-v2/sync-terminal.ts [OPTIONS]

Syncs the Command Central terminal app from the Ghostty fork.

Options:
  --check     Check if sync is needed (exits 1 if out of sync)
  --verbose   Show detailed information
  --help      Show this help message

Environment:
  TERMINAL_SOURCE   Override source repo path (default: ~/ghostty-fork)

Examples:
  bun run scripts-v2/sync-terminal.ts           # Sync terminal app
  bun run scripts-v2/sync-terminal.ts --check   # Check if out of sync
  just sync-terminal                             # Via justfile
`);
		process.exit(0);
	}

	// Check source exists
	if (!fs.existsSync(SOURCE_APP)) {
		console.error(`Source not found: ${SOURCE_APP}`);
		console.error(
			"\nThe terminal source app is expected at ~/ghostty-fork/zig-out/Ghostty.app",
		);
		console.error("Set TERMINAL_SOURCE environment variable to override.");
		process.exit(1);
	}

	const sourceVersion = await getVersion();
	const currentVersion = await getCurrentVersion();

	console.log(`Source version:  ${sourceVersion} (${SOURCE_REPO})`);
	console.log(`Bundled version: ${currentVersion}`);

	// Check if sync is needed
	const differs = await appBundlesDiffer(sourceVersion, currentVersion);

	if (!differs) {
		console.log("\n✅ Already in sync");
		return;
	}

	// Show what differs
	console.log("\n⚠️  App bundles differ:");
	if (sourceVersion !== currentVersion) {
		console.log(`   Version: ${currentVersion} → ${sourceVersion}`);
	}
	if (differs) {
		console.log("   Binary or resources changed");
	}

	if (isVerbose) {
		const { $ } = await import("bun");
		// Show size comparison
		const sourceSize = await $`du -sh ${SOURCE_APP}`.text().catch(() => "unknown");
		const destSize = fs.existsSync(DEST_APP)
			? await $`du -sh ${DEST_APP}`.text().catch(() => "unknown")
			: "not present";
		console.log(`\nSource size: ${sourceSize.trim()}`);
		console.log(`Dest size:   ${destSize.trim()}`);
	}

	if (isCheck) {
		console.log("\n❌ Sync needed. Run 'just sync-terminal' to update.");
		process.exit(1);
	}

	// Perform the sync
	console.log("\n🔄 Syncing app bundle...");
	await syncAppBundle();

	console.log("🏷️  Applying branding...");
	await applyBranding();

	console.log("🔐 Re-signing app...");
	await resignApp();

	// Update version file
	await fs.promises.writeFile(VERSION_FILE, sourceVersion + "\n");

	console.log(`\n✅ Synced to version ${sourceVersion}`);
	console.log(`   ${DEST_APP}`);
	console.log(`   ${VERSION_FILE}`);
	console.log("\n💡 App bundle is git-ignored. Only version file is tracked.");
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
