/**
 * Smart TypeScript compilation using Bun
 * Handles development and production builds with proper VS Code extension requirements
 */

import type { BuildConfig, BuildArtifact } from "bun";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { spawn } from "bun";
import { loadConfig, type ExtensionConfig } from "./config.js";
import { Logger } from "./logger.js";

export interface CompileOptions {
	entrypoint?: string;
	outdir?: string;
	mode: "development" | "production";
	sourcemap?: "inline" | "external" | false;
	minify?: boolean;
	typecheck?: boolean;
	watch?: boolean;
	onCompile?: (result: CompileResult) => void;
	verbose?: boolean;
}

export interface CompileResult {
	success: boolean;
	outputs?: BuildArtifact[];
	duration: number;
	bundleSize?: number;
	errors?: string[];
}

/**
 * Compile TypeScript to JavaScript using Bun
 */
export async function compile(options: CompileOptions): Promise<CompileResult> {
	const startTime = Date.now();
	const logger = new Logger(options.verbose);
	const config = await loadConfig();

	// Resolve paths
	const entrypoint = options.entrypoint || config.paths.entry;
	const outdir = options.outdir || config.paths.dist;

	// Determine build settings based on mode
	const isDev = options.mode === "development";
	const shouldMinify = options.minify ?? (isDev ? config.development.minify : config.production.minify);
	const shouldTypecheck = options.typecheck ?? (isDev ? config.development.typecheck : config.production.typecheck);
	const sourcemap = options.sourcemap ?? (isDev ? config.development.sourcemap : config.production.sourcemap);

	logger.debug(`Compiling ${entrypoint} → ${outdir}`);

	// Type checking (if enabled)
	if (shouldTypecheck) {
		logger.startSpinner("Type checking...");
		const typeCheckResult = await typeCheck();
		if (!typeCheckResult.success) {
			logger.stopSpinner(false, "Type checking failed");
			return {
				success: false,
				duration: Date.now() - startTime,
				errors: typeCheckResult.errors,
			};
		}
		logger.stopSpinner(true, "Type checking passed");
	}

	// Ensure output directory exists
	await fs.mkdir(outdir, { recursive: true });

	// Build configuration
	const buildConfig: BuildConfig = {
		entrypoints: [entrypoint],
		outdir,
		format: "esm",
		target: "node",
		external: ["vscode"], // Critical: Never bundle VS Code API
		sourcemap: sourcemap === "inline" ? "inline" : sourcemap === "external" ? "external" : "none",
		minify: shouldMinify,
		naming: {
			entry: "extension.js", // VS Code expects this exact name
		},
		plugins: [
			{
				name: "vscode-guard",
				setup(build) {
					// Ensure vscode module stays external
					build.onResolve({ filter: /^vscode$/ }, () => ({
						path: "vscode",
						external: true,
					}));
				},
			},
		],
	};

	// Compile
	logger.startSpinner(`Building ${isDev ? "development" : "production"} bundle...`);

	try {
		const result = await Bun.build(buildConfig);

		if (!result.success) {
			logger.stopSpinner(false, "Build failed");
			return {
				success: false,
				duration: Date.now() - startTime,
				errors: result.logs.map((log) => log.message),
			};
		}

		// Calculate bundle size
		let bundleSize = 0;
		for (const output of result.outputs) {
			const stats = await fs.stat(path.join(outdir, "extension.js"));
			bundleSize = stats.size;
		}

		logger.stopSpinner(true, `Build completed (${logger.formatSize(bundleSize)})`);

		// Add source map reference if needed
		if (sourcemap === "external") {
			await addSourceMapReference(path.join(outdir, "extension.js"));
		}

		const compileResult: CompileResult = {
			success: true,
			outputs: result.outputs,
			duration: Date.now() - startTime,
			bundleSize,
		};

		// Callback for watch mode
		if (options.onCompile) {
			options.onCompile(compileResult);
		}

		return compileResult;
	} catch (error) {
		logger.stopSpinner(false, "Build failed with error");
		logger.error("Build error", error as Error);
		return {
			success: false,
			duration: Date.now() - startTime,
			errors: [(error as Error).message],
		};
	}
}

/**
 * Run TypeScript type checking
 */
export async function typeCheck(): Promise<{ success: boolean; errors?: string[] }> {
	const logger = new Logger();

	try {
		// Run tsc with noEmit flag
		const proc = spawn(["bunx", "tsc", "--noEmit"], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const text = await new Response(proc.stdout).text();
		const errorText = await new Response(proc.stderr).text();
		
		await proc.exited;

		if (proc.exitCode !== 0) {
			const errors = (text + errorText)
				.split("\n")
				.filter((line) => line.trim())
				.filter((line) => !line.includes("npm install"));

			return { success: false, errors };
		}

		return { success: true };
	} catch (error) {
		return {
			success: false,
			errors: [`Type checking failed: ${(error as Error).message}`],
		};
	}
}

/**
 * Watch files and rebuild on changes
 */
export async function watchAndCompile(
	options: Omit<CompileOptions, "watch">,
): Promise<void> {
	const logger = new Logger(options.verbose);
	const config = await loadConfig();

	logger.section("Watch Mode");
	logger.info("Watching for changes... (Press Ctrl+C to stop)");

	// Handle Ctrl+C gracefully
	process.on("SIGINT", () => {
		logger.info("\n👋 Stopping file watcher...");
		process.exit(0);
	});

	// Initial build is already done in dev.ts, so skip it here
	
	// Watch for changes
	const watcher = fs.watch(config.paths.src, { recursive: true });

	for await (const event of watcher) {
		if (event.filename?.endsWith(".ts") || event.filename?.endsWith(".js")) {
			logger.clearLine();
			logger.info(`📝 Changed: ${event.filename}`);
			
			await compile({
				...options,
				watch: false,
				onCompile: (result) => {
					if (!result.success && result.errors) {
						logger.error("Rebuild failed");
						result.errors.slice(0, 3).forEach(err => logger.error(`  ${err}`));
					}
					if (options.onCompile) {
						options.onCompile(result);
					}
				},
			});
		}
	}
}

/**
 * Add source map reference to the output file
 */
async function addSourceMapReference(filePath: string): Promise<void> {
	const content = await fs.readFile(filePath, "utf-8");
	if (!content.includes("//# sourceMappingURL=")) {
		const mapFile = path.basename(filePath) + ".map";
		await fs.writeFile(
			filePath,
			content + `\n//# sourceMappingURL=${mapFile}`,
			"utf-8",
		);
	}
}

/**
 * Clean the output directory
 */
export async function cleanDist(): Promise<void> {
	const config = await loadConfig();
	const logger = new Logger();

	try {
		await fs.rm(config.paths.dist, { recursive: true, force: true });
		logger.success(`Cleaned ${config.paths.dist}`);
	} catch (error) {
		logger.error(`Failed to clean dist`, error as Error);
	}
}

/**
 * Get bundle information
 */
export async function getBundleInfo(): Promise<{
	size: number;
	files: string[];
	hasSourceMap: boolean;
}> {
	const config = await loadConfig();
	const distFiles = await fs.readdir(config.paths.dist);
	
	let totalSize = 0;
	const files: string[] = [];
	let hasSourceMap = false;

	for (const file of distFiles) {
		const filePath = path.join(config.paths.dist, file);
		const stats = await fs.stat(filePath);
		if (stats.isFile()) {
			files.push(file);
			totalSize += stats.size;
			if (file.endsWith(".map")) {
				hasSourceMap = true;
			}
		}
	}

	return { size: totalSize, files, hasSourceMap };
}