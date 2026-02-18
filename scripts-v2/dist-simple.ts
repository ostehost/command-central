#!/usr/bin/env bun
/**
 * ENHANCED DISTRIBUTION SCRIPT (v6)
 * 
 * Version-aware distribution with convenient version bumping
 * 
 * Features:
 * - Respects package.json version as source of truth
 * - Optional version bumping via flags (wraps npm version)
 * - Smart detection of existing releases
 * - Manages VSIX archive based on config
 * 
 * Usage:
 *   bun dist                # Build current version
 *   bun dist --patch        # Bump patch version and build
 *   bun dist --minor        # Bump minor version and build
 *   bun dist --major        # Bump major version and build
 *   bun dist --prerelease   # Create prerelease version
 *   bun dist --preid=beta   # Create beta prerelease
 *   bun dist --dry-run      # Preview changes without building
 *   bun dist --no-install   # Skip VS Code installation
 *   bun dist --help         # Show help
 */

import { spawn } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Configuration
const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, "dist");
const RELEASES_DIR = path.join(ROOT, "releases");
const PACKAGE_JSON = path.join(ROOT, "package.json");

// Parse command line arguments
const args = process.argv.slice(2);
const flags = {
	patch: args.includes("--patch"),
	minor: args.includes("--minor"),
	major: args.includes("--major"),
	prerelease: args.includes("--prerelease"),
	dryRun: args.includes("--dry-run"),
	noInstall: args.includes("--no-install"),
	help: args.includes("--help"),
	preid: (() => {
		const preidArg = args.find(arg => arg.startsWith("--preid="));
		return preidArg ? preidArg.split("=")[1] : undefined;
	})()
};

// Show help if requested
if (flags.help) {
	console.log(`
VS Code Extension Distribution Script

Usage: bun dist [options]

Options:
  --patch          Increment patch version (0.0.1 → 0.0.2)
  --minor          Increment minor version (0.0.1 → 0.1.0)
  --major          Increment major version (0.0.1 → 1.0.0)
  --prerelease     Create prerelease version
  --preid=<id>     Prerelease identifier (alpha, beta, rc)
  --dry-run        Preview changes without building
  --no-install     Skip VS Code installation
  --help           Show this help

Examples:
  bun dist                    # Build current version
  bun dist --patch            # Bump patch and build
  bun dist --minor            # Bump minor and build
  bun dist --prerelease       # Create prerelease (e.g., 0.0.1-0)
  bun dist --preid=beta       # Create beta prerelease (e.g., 0.0.1-beta.0)
  bun dist --dry-run --patch  # Preview patch bump without building

Note: Version bumping uses npm version under the hood.
      The version in package.json is always the source of truth.
`);
	process.exit(0);
}

async function main() {
	const startTime = Date.now();
	
	try {
		// 1. Determine version bump type if any
		const versionBumpType = flags.major ? "major" 
			: flags.minor ? "minor"
			: flags.patch ? "patch"
			: flags.prerelease ? "prerelease"
			: null;
		
		// 2. Handle dry run mode
		if (flags.dryRun) {
			console.log("🔸 DRY RUN MODE - No changes will be made\n");
			const pkg = await validateProject();
			const currentVersion = pkg.version;
			
			if (versionBumpType) {
				console.log("What would happen:");
				console.log(`  1. Run: npm version ${versionBumpType}${flags.preid ? ` --preid=${flags.preid}` : ""} --no-git-tag-version`);
				console.log(`  2. Build development VSIX`);
				console.log(`  3. Build production VSIX if new version`);
				console.log(`  4. Install to VS Code${flags.noInstall ? " (skipped with --no-install)" : ""}`);
			} else {
				console.log(`Would build version ${currentVersion}`);
			}
			return;
		}
		
		// 3. Bump version if requested
		if (versionBumpType) {
			console.log(`📝 Bumping version (${versionBumpType})...`);
			const versionCmd = ["npm", "version", versionBumpType, "--no-git-tag-version"];
			if (flags.preid) {
				versionCmd.push(`--preid=${flags.preid}`);
			}
			
			const versionProc = spawn(versionCmd, {
				stdout: "pipe",
				stderr: "pipe",
			});
			
			const versionOutput = await new Response(versionProc.stdout).text();
			await versionProc.exited;
			
			if (versionProc.exitCode !== 0) {
				const errorOutput = await new Response(versionProc.stderr).text();
				throw new Error(`Version bump failed: ${errorOutput}`);
			}
			
			const newVersion = versionOutput.trim();
			console.log(`   ✓ Version bumped to ${newVersion}`);
		}
		
		// 4. Validate and get current configuration
		console.log("\n🔍 Checking project status...");
		const pkg = await validateProject();
		const currentVersion = pkg.version;
		const maxReleases = pkg.distConfig?.maxReleases ?? 3;
		
		console.log(`   📌 Current version: ${currentVersion}`);
		console.log(`   📁 Releases directory: ${RELEASES_DIR}`);
		console.log(`   🗄️  Max releases to keep: ${maxReleases}`);
		
		// 5. Check if this version already exists
		await fs.mkdir(RELEASES_DIR, { recursive: true });
		const prodVsixName = `${pkg.name}-${currentVersion}.vsix`;
		const prodVsixPath = path.join(RELEASES_DIR, prodVsixName);
		const versionExists = await fileExists(prodVsixPath);
		
		// 6. Handle existing vs new version
		if (versionExists) {
			console.log(`\n✅ Version ${currentVersion} already released`);
			console.log("   → Skipping production build");
			console.log("   → Building development version only");
			console.log("\n💡 To create a new release:");
			console.log("   • Run: bun dist --patch  (or --minor, --major)");
			console.log("   • Or manually: npm version patch && bun dist");
		} else {
			console.log(`\n🆕 New version ${currentVersion} detected`);
			console.log("   → Will build both dev and production versions");
		}
		
		// 7. Always clean dist directory for fresh builds
		await cleanDist();
		
		// 8. Always build development version for local testing
		console.log("\n📦 Building development version...");
		console.log("   → Including source maps");
		console.log("   → No minification");
		const devStart = Date.now();
		const devSize = await buildExtension(false);
		const devTime = Date.now() - devStart;
		const devVsix = `${pkg.name}-dev.vsix`;
		await createVSIX(devVsix);
		const devVsixSize = await getFileSize(devVsix);
		console.log(`   ✓ Built in ${(devTime / 1000).toFixed(1)}s`);
		console.log(`   ✓ Bundle size: ${formatSize(devSize)}`);
		console.log(`   ✓ VSIX size: ${formatSize(devVsixSize)}`);
		
		// 9. Build production version only if needed
		if (!versionExists) {
			console.log("\n📦 Building production version...");
			console.log("   → External source maps");
			console.log("   → Minified output");
			await cleanDist(); // Clean between builds
			const prodStart = Date.now();
			const prodSize = await buildExtension(true);
			const prodTime = Date.now() - prodStart;
			await createVSIX(prodVsixName);
			const prodVsixSize = await getFileSize(prodVsixName);
			console.log(`   ✓ Built in ${(prodTime / 1000).toFixed(1)}s`);
			console.log(`   ✓ Bundle size: ${formatSize(prodSize)} (${getPercentReduction(devSize, prodSize)}% smaller)`);
			console.log(`   ✓ VSIX size: ${formatSize(prodVsixSize)} (${getPercentReduction(devVsixSize, prodVsixSize)}% smaller)`);
			
			// Move production VSIX to releases
			await fs.rename(prodVsixName, prodVsixPath);
			console.log(`\n📁 Moved production VSIX to releases/`);
			
			// Clean up old releases
			await cleanupOldReleases(maxReleases);
		}
		
		// 10. Install production version to VS Code (unless --no-install)
		if (!flags.noInstall) {
			console.log("\n🚀 Installing production build to VS Code...");
			// Install the production VSIX (either existing or newly built)
			await installVSIX(prodVsixPath);
			console.log("   ✓ Installed successfully");
		} else {
			console.log("\n⏭️  Skipping VS Code installation (--no-install flag)");
		}
		
		// 11. Clean up dev VSIX
		await fs.unlink(devVsix);
		
		// 12. Summary
		const elapsed = Date.now() - startTime;
		console.log("\n" + "═".repeat(60));
		console.log("✨ Distribution complete!\n");
		
		if (versionExists) {
			console.log(`📊 Using existing release: v${currentVersion}`);
			if (!flags.noInstall) {
				console.log("✅ Production version installed to VS Code");
				console.log("\n⚠️  REQUIRED: Run 'Developer: Reload Window' to activate");
				console.log("   → Press Cmd+Shift+P → type 'reload window'");
			}
			console.log(`\n📦 Production VSIX: releases/${prodVsixName}`);
			console.log(`   → Share: code --install-extension releases/${prodVsixName}`);
		} else {
			console.log(`📊 Created new release: v${currentVersion}`);
			if (!flags.noInstall) {
				console.log("✅ Production version installed to VS Code");
				console.log("\n⚠️  REQUIRED: Run 'Developer: Reload Window' to activate");
				console.log("   → Press Cmd+Shift+P → type 'reload window'");
			}
			console.log(`\n📦 Production VSIX saved: releases/${prodVsixName}`);
			const prodVsixSize = await getFileSize(prodVsixPath);
			console.log(`   → Size: ${formatSize(prodVsixSize)}`);
			console.log(`   → Share: code --install-extension releases/${prodVsixName}`);
		}
		
		// Show releases inventory
		const releases = await getReleases();
		if (releases.length > 0) {
			console.log("\n📚 Available releases:");
			for (const release of releases) {
				const size = await getFileSize(path.join(RELEASES_DIR, release));
				const version = release.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/)?.[1] || "unknown";
				const marker = version === currentVersion ? " ← current" : "";
				console.log(`   • v${version}: ${formatSize(size)}${marker}`);
			}
		}
		
		console.log("\n" + "═".repeat(60));
		console.log(`⚡ Done in ${(elapsed / 1000).toFixed(1)}s`);
		
	} catch (error) {
		console.error("\n❌ Error:", (error as Error).message);
		process.exit(1);
	}
}

async function validateProject() {
	try {
		const content = await fs.readFile(PACKAGE_JSON, "utf-8");
		const pkg = JSON.parse(content);
		
		if (!pkg.name) throw new Error("Missing 'name' in package.json");
		if (!pkg.version) throw new Error("Missing 'version' in package.json");
		if (!pkg.engines?.vscode) throw new Error("Missing 'engines.vscode' in package.json");
		if (!pkg.main) throw new Error("Missing 'main' in package.json");
		
		// Check if source exists
		const srcPath = "./src/extension.ts";
		try {
			await fs.access(srcPath);
		} catch {
			throw new Error(`Entry point not found: ${srcPath}`);
		}
		
		console.log(`   ✓ ${pkg.name} v${pkg.version}`);
		return pkg;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error("package.json not found");
		}
		throw error;
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function cleanDist() {
	try {
		await fs.rm(DIST_DIR, { recursive: true, force: true });
	} catch {
		// Directory doesn't exist, that's fine
	}
	await fs.mkdir(DIST_DIR, { recursive: true });
}

async function buildExtension(production: boolean): Promise<number> {
	const result = await Bun.build({
		entrypoints: ["./src/extension.ts"],
		outdir: "./dist",
		format: "esm",
		target: "node",
		external: ["vscode", "@vscode/sqlite3"],
		minify: production,
		sourcemap: production ? "external" : "inline",
	});
	
	if (!result.success) {
		throw new Error(`Build failed: ${result.logs.join("\n")}`);
	}
	
	// Return size of main output
	const mainOutput = result.outputs.find((o) => o.path.endsWith("extension.js"));
	return mainOutput?.size || 0;
}

async function createVSIX(vsixName: string): Promise<void> {
	const proc = spawn(
		[
			"bunx",
			"@vscode/vsce",
			"package",
			"--out",
			vsixName,
			"--no-dependencies",
			"--allow-star-activation",
			"--allow-missing-repository",
			"--skip-license",
		],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	
	const output = await new Response(proc.stdout).text();
	const errorOutput = await new Response(proc.stderr).text();
	await proc.exited;
	
	if (proc.exitCode !== 0) {
		throw new Error(`VSCE failed: ${errorOutput || output}`);
	}
	
	// Verify file exists
	try {
		await fs.access(vsixName);
	} catch {
		throw new Error("VSIX file was not created");
	}
}

async function installVSIX(vsixPath: string) {
	const proc = spawn(["code", "--install-extension", vsixPath], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const output = await new Response(proc.stdout).text();
	const errorOutput = await new Response(proc.stderr).text();
	await proc.exited;

	if (proc.exitCode !== 0) {
		throw new Error(`Installation failed: ${errorOutput || output}`);
	}
}

async function cleanupOldReleases(maxReleases: number) {
	try {
		const files = await fs.readdir(RELEASES_DIR);
		const vsixFiles = files
			.filter(f => f.endsWith(".vsix"))
			.sort((a, b) => {
				// Extract version numbers for proper semantic sorting
				const versionA = a.match(/(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?/);
				const versionB = b.match(/(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?/);

				if (!versionA || !versionB) return a.localeCompare(b);

				// Compare major.minor.patch
				const majorDiff = parseInt(versionB[1]) - parseInt(versionA[1]);
				if (majorDiff !== 0) return majorDiff;

				const minorDiff = parseInt(versionB[2]) - parseInt(versionA[2]);
				if (minorDiff !== 0) return minorDiff;

				const patchDiff = parseInt(versionB[3]) - parseInt(versionA[3]);
				if (patchDiff !== 0) return patchDiff;

				// If versions are equal, sort by full string (handles prereleases)
				return b.localeCompare(a);
			}); // Now properly sorted newest first

		if (vsixFiles.length > maxReleases) {
			const toDelete = vsixFiles.slice(maxReleases);
			console.log(`\n🧹 Cleaning up old releases (keeping last ${maxReleases})...`);

			for (const file of toDelete) {
				const filePath = path.join(RELEASES_DIR, file);
				await fs.unlink(filePath);
				console.log(`   × Removed: ${file}`);
			}
		}
	} catch (error) {
		// Releases directory might not exist yet, that's fine
	}
}

async function getReleases(): Promise<string[]> {
	try {
		const files = await fs.readdir(RELEASES_DIR);
		return files
			.filter(f => f.endsWith(".vsix"))
			.sort((a, b) => {
				// Extract version numbers for proper semantic sorting
				const versionA = a.match(/(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?/);
				const versionB = b.match(/(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?/);

				if (!versionA || !versionB) return a.localeCompare(b);

				// Compare major.minor.patch
				const majorDiff = parseInt(versionB[1]) - parseInt(versionA[1]);
				if (majorDiff !== 0) return majorDiff;

				const minorDiff = parseInt(versionB[2]) - parseInt(versionA[2]);
				if (minorDiff !== 0) return minorDiff;

				const patchDiff = parseInt(versionB[3]) - parseInt(versionA[3]);
				if (patchDiff !== 0) return patchDiff;

				// If versions are equal, sort by full string (handles prereleases)
				return b.localeCompare(a);
			}); // Properly sorted newest first
	} catch {
		return [];
	}
}

async function getFileSize(filePath: string): Promise<number> {
	try {
		const stats = await fs.stat(filePath);
		return stats.size;
	} catch {
		return 0;
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getPercentReduction(original: number, reduced: number): number {
	if (original === 0) return 0;
	return Math.round((1 - reduced / original) * 100);
}

// Run it!
main();