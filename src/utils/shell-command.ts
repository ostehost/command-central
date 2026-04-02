/**
 * Utilities for safely composing POSIX shell command strings.
 */

/**
 * Quotes a single shell argument using POSIX single-quote rules.
 */
export function shellQuote(argument: string): string {
	if (argument.length === 0) {
		return "''";
	}
	return `'${argument.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Joins argv-style parts into a shell command string.
 */
export function joinShellArgs(parts: readonly string[]): string {
	return parts.map((part) => shellQuote(part)).join(" ");
}

export interface BuildOsteSpawnCommandOptions {
	projectDir: string;
	promptFile: string;
	taskId: string;
	backend?: string;
	role?: string;
}

/**
 * Builds an oste-spawn command line with safe shell quoting.
 */
export function buildOsteSpawnCommand(
	options: BuildOsteSpawnCommandOptions,
): string {
	const args = [
		"oste-spawn.sh",
		options.projectDir,
		options.promptFile,
		"--task-id",
		options.taskId,
	];

	if (options.role) {
		args.push("--role", options.role);
	}

	if (options.backend) {
		args.push("--agent", options.backend);
	}
	return joinShellArgs(args);
}
