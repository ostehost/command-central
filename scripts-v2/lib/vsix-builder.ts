/**
 * VSIX packaging and installation utilities
 * Handles creation, verification, and installation of VS Code extensions
 */

import { spawn } from "bun";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { loadConfig, resolveVSIXPath, getPackageMetadata } from "./config.js";
import { Logger } from "./logger.js";

export interface VSIXOptions {
	mode: "development" | "production";
	outputName?: string;
	skipValidation?: boolean;
	includeSourceMap?: boolean;
	verbose?: boolean;
}

export interface VSIXInfo {
	path: string;
	size: number;
	name: string;
	version: string;
	files: number;
}

/**
 * Create a VSIX package
 */
export async function createVSIX(options: VSIXOptions): Promise<string> {
	const logger = new Logger(options.verbose);
	const config = await loadConfig();
	const metadata = await getPackageMetadata();

	// Determine output path
	const outputPath = options.outputName 
		? path.join(config.vsix.outputDir, options.outputName)
		: await resolveVSIXPath(
			options.mode === "development" 
				? "{name}-dev-{timestamp}.vsix"
				: "{name}-{version}.vsix"
		);

	logger.startSpinner("Creating VSIX package...");

	try {
		// Ensure output directory exists
		await fs.mkdir(path.dirname(outputPath), { recursive: true });

		// Build vsce command
		const args = [
			"@vscode/vsce",
			"package",
			"--out",
			outputPath,
			"--no-dependencies", // Don't include node_modules
		];

		if (options.skipValidation) {
			args.push("--skip-license");
			args.push("--allow-star-activation");
			args.push("--allow-missing-repository");
		}

		// Run vsce
		const proc = spawn(["bunx", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const output = await new Response(proc.stdout).text();
		const errorOutput = await new Response(proc.stderr).text();
		
		await proc.exited;

		if (proc.exitCode !== 0) {
			logger.stopSpinner(false, "VSIX creation failed");
			logger.error("VSCE output:", new Error(errorOutput || output));
			throw new Error(`VSIX creation failed: ${errorOutput || output}`);
		}

		// Verify the VSIX was created
		try {
			await fs.access(outputPath);
		} catch {
			throw new Error(`VSIX file was not created at ${outputPath}`);
		}

		// Get VSIX info
		const stats = await fs.stat(outputPath);
		logger.stopSpinner(true, `VSIX created (${logger.formatSize(stats.size)})`);

		// Clean up source maps if not needed
		if (!options.includeSourceMap && options.mode === "production") {
			await removeSourceMaps();
		}

		return outputPath;
	} catch (error) {
		logger.stopSpinner(false, "Failed to create VSIX");
		throw error;
	}
}

/**
 * Install a VSIX to VS Code
 */
export async function installVSIX(vsixPath: string, force = true): Promise<void> {
	const logger = new Logger();

	logger.startSpinner("Installing VSIX to VS Code...");

	try {
		// Check if VSIX exists
		await fs.access(vsixPath);

		// Build command
		const args = ["--install-extension", vsixPath];
		if (force) {
			args.push("--force");
		}

		// Run VS Code install command
		const proc = spawn(["code", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const output = await new Response(proc.stdout).text();
		const errorOutput = await new Response(proc.stderr).text();
		
		await proc.exited;

		if (proc.exitCode !== 0) {
			logger.stopSpinner(false, "Installation failed");
			throw new Error(`Installation failed: ${errorOutput || output}`);
		}

		logger.stopSpinner(true, "VSIX installed successfully");
		
		// Show reload instructions
		logger.box([
			"Extension installed! To use it:",
			"",
			"1. Reload VS Code window:",
			"   • Press Cmd+R (Mac) / Ctrl+R (Windows/Linux)",
			"   • Or run: Developer: Reload Window",
			"",
			"2. The extension will activate automatically",
		], "Next Steps");

	} catch (error) {
		logger.stopSpinner(false, "Installation failed");
		throw error;
	}
}

/**
 * Verify VSIX contents
 */
export async function verifyVSIX(vsixPath: string): Promise<VSIXInfo> {
	const logger = new Logger();

	try {
		// Check file exists
		const stats = await fs.stat(vsixPath);
		
		// List contents using unzip
		const proc = spawn(["unzip", "-l", vsixPath], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const output = await new Response(proc.stdout).text();
		await proc.exited;

		if (proc.exitCode !== 0) {
			throw new Error("Failed to read VSIX contents");
		}

		// Parse the output to count files
		const lines = output.split("\n");
		const fileLines = lines.filter(line => 
			line.includes("extension.js") || 
			line.includes("package.json") ||
			line.includes("README.md")
		);

		// Extract metadata from filename
		const filename = path.basename(vsixPath);
		const nameMatch = filename.match(/^(.+?)-(\d+\.\d+\.\d+.*?)\.vsix$/);
		const name = nameMatch ? nameMatch[1] : "unknown";
		const version = nameMatch ? nameMatch[2] : "0.0.0";

		return {
			path: vsixPath,
			size: stats.size,
			name,
			version,
			files: fileLines.length,
		};
	} catch (error) {
		logger.error("Failed to verify VSIX", error as Error);
		throw error;
	}
}

/**
 * Clean up temporary VSIX files
 */
export async function cleanupVSIX(keepProduction = true): Promise<void> {
	const logger = new Logger();
	const config = await loadConfig();

	try {
		const files = await fs.readdir(config.vsix.outputDir);
		const vsixFiles = files.filter(f => f.endsWith(".vsix"));
		
		let removed = 0;
		for (const file of vsixFiles) {
			// Keep production builds if requested
			if (keepProduction && !file.includes("-dev-")) {
				continue;
			}

			const filePath = path.join(config.vsix.outputDir, file);
			await fs.unlink(filePath);
			removed++;
			logger.debug(`Removed ${file}`);
		}

		if (removed > 0) {
			logger.success(`Cleaned up ${removed} VSIX file(s)`);
		}
	} catch (error) {
		logger.error("Failed to cleanup VSIX files", error as Error);
	}
}

/**
 * Remove source map files from dist
 */
async function removeSourceMaps(): Promise<void> {
	const config = await loadConfig();
	
	try {
		const files = await fs.readdir(config.paths.dist);
		const mapFiles = files.filter(f => f.endsWith(".map"));
		
		for (const file of mapFiles) {
			await fs.unlink(path.join(config.paths.dist, file));
		}
	} catch {
		// Ignore errors, source maps might not exist
	}
}

/**
 * Get the reload command for the current platform
 */
export function getReloadCommand(): string {
	const platform = process.platform;
	if (platform === "darwin") {
		return "Cmd+R";
	} else if (platform === "win32") {
		return "Ctrl+R";
	} else {
		return "Ctrl+R";
	}
}

/**
 * Show VSIX information
 */
export function displayVSIXInfo(info: VSIXInfo, logger: Logger): void {
	logger.section("VSIX Package Info");
	logger.table({
		"Package": info.name,
		"Version": info.version,
		"Size": logger.formatSize(info.size),
		"Files": info.files,
		"Location": info.path,
	});
}