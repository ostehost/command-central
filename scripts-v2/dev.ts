#!/usr/bin/env bun
/**
 * Development workflow with hot reload
 * Lightning-fast development experience for VS Code extensions
 * 
 * Usage: bun run dev:v2 [options]
 * Options:
 *   --skip-validate    Skip validation checks for faster startup
 *   --no-typecheck     Skip TypeScript type checking
 *   --inspect=PORT     Set debugger port (default: 9229)
 *   --verbose          Show detailed output
 */

import { parseArgs } from "node:util";
import { compile, watchAndCompile } from "./lib/compiler.js";
import { validate } from "./lib/validator.js";
import { launchExtensionHost, showDevelopmentTips } from "./lib/launcher.js";
import { loadConfig } from "./lib/config.js";
import { Logger } from "./lib/logger.js";

// Parse command line arguments
const { values, positionals } = parseArgs({
	args: process.argv.slice(2),
	options: {
		"skip-validate": { type: "boolean", default: false },
		"no-typecheck": { type: "boolean", default: false },
		inspect: { type: "string", default: "9229" },
		verbose: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
	},
	allowPositionals: true,
});

// Show help if requested
if (values.help) {
	console.log(`
🔥 VS Code Extension Development Mode

Usage: bun run dev:v2 [options] [workspace-path]

Options:
  --skip-validate    Skip validation checks for faster startup
  --no-typecheck     Skip TypeScript type checking
  --inspect=PORT     Set debugger port (default: 9229)
  --verbose          Show detailed output
  --help             Show this help message

Arguments:
  workspace-path     Optional path to workspace folder to open

Examples:
  bun run dev:v2                    # Start with last workspace
  bun run dev:v2 .                  # Start in current directory
  bun run dev:v2 ~/myproject        # Start with specific project
  bun run dev:v2 --skip-validate    # Fast start, skip validation
  bun run dev:v2 --inspect=5858     # Use custom debug port
`);
	process.exit(0);
}

async function main() {
	const startTime = Date.now();
	const logger = new Logger(values.verbose as boolean);
	const config = await loadConfig();

	// Header
	logger.box([
		"🚀 VS Code Extension Development Mode",
		"",
		"Fast iteration with hot reload",
		"Make changes and see them instantly!",
	], "Dev Mode");

	// Show startup steps
	console.log("📋 Startup steps:");
	console.log(`   ${values["skip-validate"] ? "⊘" : "1."} Validate project${values["skip-validate"] ? " (skipped)" : ""}`);
	console.log("   2. Build extension");
	console.log("   3. Launch VS Code");
	console.log("   4. Watch for changes");
	console.log("");

	// 1. Quick validation (unless skipped)
	if (!values["skip-validate"]) {
		console.log("⏳ Step 1/4: Validating project...");
		const validationResult = await validate({
			level: "quick",
			skipTypecheck: values["no-typecheck"] as boolean,
			verbose: values.verbose as boolean,
		});

		if (!validationResult.passed) {
			logger.error("Validation failed. Fix errors or use --skip-validate to bypass.");
			process.exit(1);
		}
	}

	// 2. Initial compilation
	console.log("⏳ Step 2/4: Building extension...");
	logger.section("Building Extension");
	const compileResult = await compile({
		mode: "development",
		sourcemap: "inline",
		minify: false,
		typecheck: !(values["no-typecheck"] as boolean),
		verbose: values.verbose as boolean,
	});

	if (!compileResult.success) {
		logger.error("Build failed. Please fix compilation errors.");
		if (compileResult.errors) {
			logger.list(compileResult.errors.slice(0, 5));
		}
		process.exit(1);
	}

	logger.success(`Built in ${logger.formatDuration(compileResult.duration)}`);
	if (compileResult.bundleSize) {
		logger.info(`Bundle size: ${logger.formatSize(compileResult.bundleSize)}`);
	}

	// 3. Launch Extension Host
	console.log("⏳ Step 3/4: Launching VS Code...");
	// Get workspace path from positional arguments
	const workspacePath = positionals[0] as string | undefined;

	const launchResult = await launchExtensionHost({
		disableExtensions: config.development.disableExtensions,
		inspectPort: parseInt(values.inspect as string),
		verbose: values.verbose as boolean,
		workspacePath: workspacePath,
	});

	// 4. Show development tips
	if (values.verbose) {
		showDevelopmentTips(logger);
	}

	// 5. Start watching for changes
	console.log("✅ Step 4/4: Watching for changes...");
	logger.section("File Watcher");
	logger.info("Watching for changes in src/...");
	logger.info("💡 Tip: Save files to trigger rebuild, then press Cmd+R in VS Code");
	logger.divider();

	// Keep the process alive and watch for changes
	// The watch mode will run indefinitely until Ctrl+C
	await watchAndCompile({
		mode: "development",
		sourcemap: "inline",
		minify: false,
		typecheck: false, // Skip typecheck in watch mode for speed
		verbose: values.verbose as boolean,
		onCompile: (result) => {
			if (result.success) {
				logger.success("✨ Rebuild complete - reload VS Code to see changes");
			}
		},
	});
}

// Run the dev workflow
main().catch((error) => {
	console.error("❌ Fatal error:", error);
	process.exit(1);
});