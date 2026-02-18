/**
 * VS Code Extension Development Host launcher
 * Manages launching and reloading VS Code for extension testing
 */

import { spawn, type Subprocess } from "bun";
import * as path from "node:path";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";

export interface LaunchOptions {
	extensionPath?: string;
	disableExtensions?: boolean;
	inspectPort?: number;
	newWindow?: boolean;
	verbose?: boolean;
	workspacePath?: string;
	additionalArgs?: string[];
}

export interface LaunchResult {
	process: Subprocess;
	command: string;
	args: string[];
}

/**
 * Launch VS Code Extension Development Host
 */
export async function launchExtensionHost(
	options: LaunchOptions = {},
): Promise<LaunchResult> {
	const logger = new Logger(options.verbose);
	const config = await loadConfig();

	// Build command arguments
	const extensionPath = options.extensionPath || config.paths.root;
	const args: string[] = [
		`--extensionDevelopmentPath=${extensionPath}`,
	];

	// Add optional flags
	if (options.disableExtensions) {
		args.push("--disable-extensions");
	}

	if (options.inspectPort) {
		args.push(`--inspect-extensions=${options.inspectPort}`);
	}

	if (options.newWindow !== false) {
		args.push("--new-window");
	}

	if (options.workspacePath) {
		args.push(options.workspacePath);
	}

	// Add any additional arguments
	if (options.additionalArgs) {
		args.push(...options.additionalArgs);
	}

	// Determine VS Code command based on platform
	const command = getVSCodeCommand();

	logger.section("Launching Extension Host");
	logger.table({
		"Extension Path": extensionPath,
		"Debug Port": options.inspectPort || "None",
		"Disable Extensions": options.disableExtensions || false,
		"Command": `${command} ${args.join(" ")}`,
	});

	try {
		// Launch VS Code
		const process = spawn([command, ...args], {
			stdout: "inherit",
			stderr: "inherit",
			stdin: "inherit",
		});

		logger.success("VS Code Extension Host launched");
		logger.box([
			"Extension Development Host is running!",
			"",
			"• Your extension is loaded and ready",
			"• Make changes to your code",
			"• Use the reload command to test changes",
			"",
			`Reload: ${getReloadCommand()}`,
		], "Ready");

		return {
			process,
			command,
			args,
		};
	} catch (error) {
		logger.error("Failed to launch Extension Host", error as Error);
		throw error;
	}
}

/**
 * Get the VS Code command for the current platform
 */
export function getVSCodeCommand(): string {
	const platform = process.platform;
	
	// Check for VS Code Insiders first
	const insidersCommand = platform === "win32" ? "code-insiders.cmd" : "code-insiders";
	const standardCommand = platform === "win32" ? "code.cmd" : "code";
	
	// Try to detect which one is available
	// For now, we'll default to standard VS Code
	return standardCommand;
}

/**
 * Get the reload command for the current platform
 */
export function getReloadCommand(): string {
	const platform = process.platform;
	if (platform === "darwin") {
		return "Cmd+R or Developer: Reload Window";
	} else {
		return "Ctrl+R or Developer: Reload Window";
	}
}

/**
 * Show development tips
 */
export function showDevelopmentTips(logger: Logger): void {
	logger.section("Development Tips");
	logger.list([
		"Use the Command Palette (Cmd+Shift+P) to test your commands",
		"Open DevTools with: Help → Toggle Developer Tools",
		"Check the Extension Host log in the Output panel",
		"Use console.log() for debugging (visible in DevTools)",
		"Set breakpoints in VS Code for debugging",
	]);
}

/**
 * Wait for process to exit or user interrupt
 */
export async function waitForExit(
	subprocess: Subprocess,
	logger: Logger,
): Promise<void> {
	// Handle Ctrl+C on the main process
	process.on("SIGINT", () => {
		logger.info("Shutting down Extension Host...");
		subprocess.kill();
		process.exit(0);
	});

	// Wait for subprocess to exit
	const exitCode = await subprocess.exited;
	
	if (exitCode !== 0) {
		logger.error(`Extension Host exited with code ${exitCode}`);
	} else {
		logger.info("Extension Host closed");
	}
}

/**
 * Check if VS Code is installed and accessible
 */
export async function checkVSCodeInstallation(): Promise<{
	installed: boolean;
	version?: string;
	error?: string;
}> {
	const logger = new Logger();

	try {
		const command = getVSCodeCommand();
		const proc = spawn([command, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const output = await new Response(proc.stdout).text();
		await proc.exited;

		if (proc.exitCode === 0) {
			const lines = output.split("\n");
			const version = lines[0]?.trim();
			return {
				installed: true,
				version,
			};
		} else {
			return {
				installed: false,
				error: "VS Code command failed",
			};
		}
	} catch (error) {
		return {
			installed: false,
			error: (error as Error).message,
		};
	}
}

/**
 * Open a file in VS Code
 */
export async function openInVSCode(
	filePath: string,
	line?: number,
	column?: number,
): Promise<void> {
	const command = getVSCodeCommand();
	const args: string[] = [];

	if (line && column) {
		args.push("--goto", `${filePath}:${line}:${column}`);
	} else if (line) {
		args.push("--goto", `${filePath}:${line}`);
	} else {
		args.push(filePath);
	}

	const proc = spawn([command, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});

	await proc.exited;
}

/**
 * Create a launch configuration object
 */
export function createLaunchConfig(options: LaunchOptions): Record<string, unknown> {
	return {
		type: "extensionHost",
		request: "launch",
		name: "Run Extension",
		args: options.additionalArgs || [],
		outFiles: ["${workspaceFolder}/dist/**/*.js"],
		preLaunchTask: "compile",
		env: {
			NODE_ENV: "development",
		},
	};
}