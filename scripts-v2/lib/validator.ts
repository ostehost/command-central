/**
 * Pre-flight validation checks
 * Ensures code quality before builds and releases
 */

import { spawn } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";

export type ValidationLevel = "quick" | "standard" | "full" | "ci";

export interface ValidationResult {
	passed: boolean;
	errors: string[];
	warnings: string[];
	duration: number;
	checks: {
		syntax: boolean;
		types: boolean;
		lint: boolean;
		format: boolean;
		tests: boolean;
		manifest: boolean;
	};
}

export interface ValidationOptions {
	level: ValidationLevel;
	skipTypecheck?: boolean;
	skipLint?: boolean;
	skipFormat?: boolean;
	skipTests?: boolean;
	verbose?: boolean;
}

/**
 * Run validation checks based on level
 */
export async function validate(options: ValidationOptions): Promise<ValidationResult> {
	const startTime = Date.now();
	const logger = new Logger(options.verbose);
	const errors: string[] = [];
	const warnings: string[] = [];
	const checks = {
		syntax: false,
		types: false,
		lint: false,
		format: false,
		tests: false,
		manifest: false,
	};

	logger.section(`Validation (${options.level})`);

	// Determine which checks to run based on level
	const runChecks = getChecksForLevel(options.level);

	// 1. Syntax check (package.json)
	if (runChecks.syntax) {
		logger.startSpinner("Checking package.json syntax...");
		const syntaxResult = await checkPackageJsonSyntax();
		checks.syntax = syntaxResult.valid;
		if (!syntaxResult.valid) {
			errors.push(...syntaxResult.errors);
			logger.stopSpinner(false, "Invalid package.json");
		} else {
			logger.stopSpinner(true, "Valid package.json");
		}
	}

	// 2. Manifest validation
	if (runChecks.manifest) {
		logger.startSpinner("Validating extension manifest...");
		const manifestResult = await checkManifest();
		checks.manifest = manifestResult.valid;
		if (!manifestResult.valid) {
			errors.push(...manifestResult.errors);
			warnings.push(...manifestResult.warnings);
			logger.stopSpinner(false, "Manifest has issues");
		} else {
			logger.stopSpinner(true, "Valid manifest");
		}
	}

	// 3. Type checking
	if (runChecks.types && !options.skipTypecheck) {
		logger.startSpinner("Type checking...");
		const typeResult = await runTypeCheck();
		checks.types = typeResult.success;
		if (!typeResult.success) {
			errors.push(...typeResult.errors);
			logger.stopSpinner(false, "Type errors found");
		} else {
			logger.stopSpinner(true, "No type errors");
		}
	}

	// 4. Linting
	if (runChecks.lint && !options.skipLint) {
		logger.startSpinner("Linting code...");
		const lintResult = await runLint();
		checks.lint = lintResult.success;
		if (!lintResult.success) {
			errors.push(...lintResult.errors);
			warnings.push(...lintResult.warnings);
			logger.stopSpinner(false, "Lint issues found");
		} else {
			logger.stopSpinner(true, "No lint issues");
		}
	}

	// 5. Format checking
	if (runChecks.format && !options.skipFormat) {
		logger.startSpinner("Checking code formatting...");
		const formatResult = await runFormatCheck();
		checks.format = formatResult.success;
		if (!formatResult.success) {
			warnings.push(...formatResult.warnings);
			logger.stopSpinner(false, "Format issues found");
		} else {
			logger.stopSpinner(true, "Code properly formatted");
		}
	}

	// 6. Tests
	if (runChecks.tests && !options.skipTests) {
		logger.startSpinner("Running tests...");
		const testResult = await runTests();
		checks.tests = testResult.success;
		if (!testResult.success) {
			errors.push(...testResult.errors);
			logger.stopSpinner(false, "Tests failed");
		} else {
			const testCount = testResult.passed || 0;
			const testLabel = testCount === 1 ? "test" : "tests";
			logger.stopSpinner(true, `${testCount} ${testLabel} passed`);
		}
	}

	// Calculate final result
	const duration = Date.now() - startTime;
	const passed = errors.length === 0;

	// Display summary
	logger.divider();
	if (passed) {
		logger.success(`✨ All validation checks passed! (${logger.formatDuration(duration)})`);
	} else {
		logger.error(`Validation failed with ${errors.length} error(s)`);
		if (errors.length > 0) {
			logger.section("Errors");
			logger.list(errors.slice(0, 10)); // Show first 10 errors
			if (errors.length > 10) {
				logger.warn(`... and ${errors.length - 10} more errors`);
			}
		}
	}

	if (warnings.length > 0 && options.verbose) {
		logger.section("Warnings");
		logger.list(warnings.slice(0, 5));
		if (warnings.length > 5) {
			logger.info(`... and ${warnings.length - 5} more warnings`);
		}
	}

	return {
		passed,
		errors,
		warnings,
		duration,
		checks,
	};
}

/**
 * Determine which checks to run based on level
 */
function getChecksForLevel(level: ValidationLevel) {
	switch (level) {
		case "quick":
			return {
				syntax: true,
				manifest: true,
				types: false,
				lint: false,
				format: false,
				tests: false,
			};
		case "standard":
			return {
				syntax: true,
				manifest: true,
				types: true,
				lint: true,
				format: false,
				tests: false,
			};
		case "full":
			return {
				syntax: true,
				manifest: true,
				types: true,
				lint: true,
				format: true,
				tests: true,
			};
		case "ci":
			return {
				syntax: true,
				manifest: true,
				types: true,
				lint: true,
				format: true,
				tests: true,
			};
		default:
			return getChecksForLevel("standard");
	}
}

/**
 * Check package.json syntax
 */
async function checkPackageJsonSyntax(): Promise<{
	valid: boolean;
	errors: string[];
}> {
	const config = await loadConfig();
	const packageJsonPath = path.join(config.paths.root, "package.json");

	try {
		const content = await fs.readFile(packageJsonPath, "utf-8");
		JSON.parse(content);
		return { valid: true, errors: [] };
	} catch (error) {
		return {
			valid: false,
			errors: [`Invalid package.json: ${(error as Error).message}`],
		};
	}
}

/**
 * Check extension manifest requirements
 */
async function checkManifest(): Promise<{
	valid: boolean;
	errors: string[];
	warnings: string[];
}> {
	const config = await loadConfig();
	const packageJsonPath = path.join(config.paths.root, "package.json");
	const errors: string[] = [];
	const warnings: string[] = [];

	try {
		const content = await fs.readFile(packageJsonPath, "utf-8");
		const manifest = JSON.parse(content);

		// Required fields
		if (!manifest.name) errors.push("Missing 'name' field");
		if (!manifest.version) errors.push("Missing 'version' field");
		if (!manifest.engines?.vscode) errors.push("Missing 'engines.vscode' field");
		if (!manifest.main && !manifest.browser) errors.push("Missing 'main' or 'browser' field");

		// Recommended fields
		if (!manifest.displayName) warnings.push("Missing 'displayName' field");
		if (!manifest.description) warnings.push("Missing 'description' field");
		if (!manifest.publisher) warnings.push("Missing 'publisher' field");
		if (!manifest.repository) warnings.push("Missing 'repository' field");
		if (!manifest.categories || manifest.categories.length === 0) {
			warnings.push("No categories specified");
		}


		return {
			valid: errors.length === 0,
			errors,
			warnings,
		};
	} catch (error) {
		return {
			valid: false,
			errors: [`Failed to read manifest: ${(error as Error).message}`],
			warnings: [],
		};
	}
}

/**
 * Run TypeScript type checking
 */
async function runTypeCheck(): Promise<{
	success: boolean;
	errors: string[];
}> {
	try {
		const proc = spawn(["bunx", "tsc", "--noEmit"], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const output = await new Response(proc.stdout).text();
		const errorOutput = await new Response(proc.stderr).text();
		
		await proc.exited;

		if (proc.exitCode !== 0) {
			const errors = (output + errorOutput)
				.split("\n")
				.filter((line) => line.trim() && !line.includes("npm install"))
				.slice(0, 20); // Limit to first 20 errors

			return { success: false, errors };
		}

		return { success: true, errors: [] };
	} catch (error) {
		return {
			success: false,
			errors: [`Type check failed: ${(error as Error).message}`],
		};
	}
}

/**
 * Run linting
 */
async function runLint(): Promise<{
	success: boolean;
	errors: string[];
	warnings: string[];
}> {
	try {
		const proc = spawn(["bunx", "@biomejs/biome", "lint", "./src", "./scripts-v2"], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const output = await new Response(proc.stdout).text();
		await proc.exited;

		// Biome exits with 0 even with warnings, check output
		const hasErrors = output.includes("error");
		const hasWarnings = output.includes("warning");

		const errors: string[] = [];
		const warnings: string[] = [];

		if (hasErrors) {
			const errorLines = output
				.split("\n")
				.filter((line) => line.includes("error"))
				.slice(0, 10);
			errors.push(...errorLines);
		}

		if (hasWarnings) {
			const warningLines = output
				.split("\n")
				.filter((line) => line.includes("warning"))
				.slice(0, 5);
			warnings.push(...warningLines);
		}

		return {
			success: !hasErrors,
			errors,
			warnings,
		};
	} catch (error) {
		return {
			success: false,
			errors: [`Lint failed: ${(error as Error).message}`],
			warnings: [],
		};
	}
}

/**
 * Check code formatting
 */
async function runFormatCheck(): Promise<{
	success: boolean;
	warnings: string[];
}> {
	try {
		const proc = spawn(["bunx", "@biomejs/biome", "format", "./src", "./scripts-v2"], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const output = await new Response(proc.stdout).text();
		await proc.exited;

		const needsFormatting = output.includes("would have been formatted");
		const warnings = needsFormatting
			? ["Some files need formatting. Run 'bun run format:fix'"]
			: [];

		return {
			success: !needsFormatting,
			warnings,
		};
	} catch (error) {
		return {
			success: false,
			warnings: [`Format check failed: ${(error as Error).message}`],
		};
	}
}

/**
 * Run tests
 */
async function runTests(): Promise<{
	success: boolean;
	errors: string[];
	passed?: number;
	failed?: number;
}> {
	try {
		// Use the partitioned test approach from package.json
		const proc = spawn(["bun", "run", "test"], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const output = await new Response(proc.stdout).text();
		const errorOutput = await new Response(proc.stderr).text();
		await proc.exited;

		// Parse test results - count all passed tests from partitioned runs
		// Combine both stdout and stderr as Bun may output to either
		const combinedOutput = output + errorOutput;
		const passMatches = combinedOutput.match(/(\d+) pass/g);
		const failMatches = combinedOutput.match(/(\d+) fail/g);
		
		let totalPassed = 0;
		let totalFailed = 0;
		
		if (passMatches) {
			totalPassed = passMatches.reduce((sum, match) => {
				const num = parseInt(match.replace(' pass', ''));
				return sum + num;
			}, 0);
		}
		
		if (failMatches) {
			totalFailed = failMatches.reduce((sum, match) => {
				const num = parseInt(match.replace(' fail', ''));
				return sum + num;
			}, 0);
		}

		if (proc.exitCode !== 0 || totalFailed > 0) {
			const errorLines = (output + errorOutput)
				.split("\n")
				.filter((line) => line.includes("error") || line.includes("fail"))
				.slice(0, 10);

			return {
				success: false,
				errors: errorLines.length > 0 ? errorLines : ["Tests failed"],
				passed: totalPassed,
				failed: totalFailed,
			};
		}

		return {
			success: true,
			errors: [],
			passed: totalPassed,
			failed: 0,
		};
	} catch (error) {
		return {
			success: false,
			errors: [`Test execution failed: ${(error as Error).message}`],
		};
	}
}