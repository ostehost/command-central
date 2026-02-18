/**
 * Beautiful console output with spinners and colors
 * Provides a delightful developer experience
 */

// ANSI color codes for terminal output
const colors = {
	reset: "\x1b[0m",
	bright: "\x1b[1m",
	dim: "\x1b[2m",
	
	// Foreground colors
	black: "\x1b[30m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
	gray: "\x1b[90m",
	
	// Background colors
	bgRed: "\x1b[41m",
	bgGreen: "\x1b[42m",
	bgYellow: "\x1b[43m",
	bgBlue: "\x1b[44m",
} as const;

// Unicode symbols for better visual feedback
const symbols = {
	success: "✅",
	error: "❌",
	warning: "⚠️",
	info: "ℹ️",
	debug: "🐛",
	rocket: "🚀",
	package: "📦",
	clock: "⏱️",
	fire: "🔥",
	sparkles: "✨",
	checkmark: "✓",
	cross: "✗",
	arrow: "→",
	bullet: "•",
} as const;

// Spinner frames for loading animation
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Logger {
	private spinnerInterval?: Timer;
	private spinnerFrame = 0;
	private spinnerMessage = "";
	private startTime?: number;
	private isVerbose: boolean;

	constructor(verbose = false) {
		this.isVerbose = verbose;
	}

	/**
	 * Start a spinner with a message
	 */
	startSpinner(message: string): void {
		this.spinnerMessage = message;
		this.startTime = Date.now();
		this.spinnerFrame = 0;

		// Clear any existing spinner
		this.stopSpinner(false);

		// Start the animation
		this.spinnerInterval = setInterval(() => {
			process.stdout.write(
				`\r${colors.cyan}${spinnerFrames[this.spinnerFrame]}${colors.reset} ${message}`,
			);
			this.spinnerFrame = (this.spinnerFrame + 1) % spinnerFrames.length;
		}, 80);
	}

	/**
	 * Stop the spinner and show final message
	 */
	stopSpinner(success: boolean, message?: string): void {
		if (this.spinnerInterval) {
			clearInterval(this.spinnerInterval);
			this.spinnerInterval = undefined;

			// Clear the spinner line
			process.stdout.write("\r\x1b[K");

			// Show final message with duration
			const duration = this.startTime ? Date.now() - this.startTime : 0;
			const finalMessage = message || this.spinnerMessage;
			const symbol = success ? symbols.success : symbols.error;
			const color = success ? colors.green : colors.red;
			const durationStr = duration > 0 ? ` ${colors.gray}(${duration}ms)${colors.reset}` : "";

			console.log(`${symbol} ${color}${finalMessage}${colors.reset}${durationStr}`);
		}
	}

	/**
	 * Log an info message
	 */
	info(message: string): void {
		console.log(`${symbols.info} ${colors.blue}${message}${colors.reset}`);
	}

	/**
	 * Log a success message
	 */
	success(message: string): void {
		console.log(`${symbols.success} ${colors.green}${message}${colors.reset}`);
	}

	/**
	 * Log an error message
	 */
	error(message: string, error?: Error): void {
		console.error(`${symbols.error} ${colors.red}${message}${colors.reset}`);
		if (error && this.isVerbose) {
			console.error(`${colors.gray}${error.stack}${colors.reset}`);
		}
	}

	/**
	 * Log a warning message
	 */
	warn(message: string): void {
		console.warn(`${symbols.warning} ${colors.yellow}${message}${colors.reset}`);
	}

	/**
	 * Log a debug message (only in verbose mode)
	 */
	debug(message: string): void {
		if (this.isVerbose) {
			console.log(`${symbols.debug} ${colors.gray}${message}${colors.reset}`);
		}
	}

	/**
	 * Display data in a table format
	 */
	table(data: Record<string, unknown>): void {
		const maxKeyLength = Math.max(...Object.keys(data).map((k) => k.length));
		
		console.log(`${colors.gray}${"─".repeat(50)}${colors.reset}`);
		for (const [key, value] of Object.entries(data)) {
			const paddedKey = key.padEnd(maxKeyLength);
			let displayValue = String(value);
			
			// Color code certain values
			if (typeof value === "boolean") {
				displayValue = value 
					? `${colors.green}${symbols.checkmark} Yes${colors.reset}`
					: `${colors.red}${symbols.cross} No${colors.reset}`;
			} else if (typeof value === "number") {
				displayValue = `${colors.cyan}${value}${colors.reset}`;
			}
			
			console.log(`  ${colors.bright}${paddedKey}${colors.reset} : ${displayValue}`);
		}
		console.log(`${colors.gray}${"─".repeat(50)}${colors.reset}`);
	}

	/**
	 * Display a section header
	 */
	section(title: string): void {
		console.log("");
		console.log(`${colors.bright}${colors.cyan}━━━ ${title} ━━━${colors.reset}`);
		console.log("");
	}

	/**
	 * Display a list of items
	 */
	list(items: string[]): void {
		for (const item of items) {
			console.log(`  ${colors.gray}${symbols.bullet}${colors.reset} ${item}`);
		}
	}

	/**
	 * Show a progress update
	 */
	progress(current: number, total: number, message: string): void {
		const percentage = Math.round((current / total) * 100);
		const barLength = 20;
		const filled = Math.round((current / total) * barLength);
		const bar = "█".repeat(filled) + "░".repeat(barLength - filled);
		
		process.stdout.write(
			`\r${colors.cyan}[${bar}]${colors.reset} ${percentage}% - ${message}`,
		);
		
		if (current === total) {
			console.log(""); // New line when complete
		}
	}

	/**
	 * Clear the current line
	 */
	clearLine(): void {
		process.stdout.write("\r\x1b[K");
	}

	/**
	 * Display performance timing
	 */
	timing(operation: string, duration: number): void {
		const color = duration < 1000 ? colors.green : duration < 5000 ? colors.yellow : colors.red;
		console.log(`${symbols.clock} ${operation}: ${color}${duration}ms${colors.reset}`);
	}

	/**
	 * Display a box with content
	 */
	box(content: string[], title?: string): void {
		const maxLength = Math.max(...content.map((line) => line.length), title?.length || 0);
		const boxWidth = maxLength + 4;
		
		// Top border
		if (title) {
			const titlePadding = Math.floor((boxWidth - title.length - 2) / 2);
			console.log(`╭${"─".repeat(titlePadding)}${colors.bright} ${title} ${colors.reset}${"─".repeat(boxWidth - titlePadding - title.length - 2)}╮`);
		} else {
			console.log(`╭${"─".repeat(boxWidth)}╮`);
		}
		
		// Content
		for (const line of content) {
			const padding = " ".repeat(boxWidth - line.length - 2);
			console.log(`│ ${line}${padding} │`);
		}
		
		// Bottom border
		console.log(`╰${"─".repeat(boxWidth)}╯`);
	}

	/**
	 * Create a divider line
	 */
	divider(char = "─"): void {
		console.log(`${colors.gray}${char.repeat(50)}${colors.reset}`);
	}

	/**
	 * Format file size for display
	 */
	formatSize(bytes: number): string {
		const units = ["B", "KB", "MB", "GB"];
		let size = bytes;
		let unitIndex = 0;
		
		while (size > 1024 && unitIndex < units.length - 1) {
			size /= 1024;
			unitIndex++;
		}
		
		return `${size.toFixed(2)} ${units[unitIndex]}`;
	}

	/**
	 * Format duration for display
	 */
	formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
	}
}