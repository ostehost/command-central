/**
 * LoggerService - Centralized logging for VS Code extension
 * Provides structured logging with different levels and channels
 */

import * as vscode from "vscode";

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
}

interface LogEntry {
	timestamp: Date;
	level: LogLevel;
	message: string;
	context?: string;
	error?: Error;
	data?: Record<string, unknown>;
}

export class LoggerService {
	private outputChannel: vscode.OutputChannel;
	private readonly logHistory: LogEntry[] = [];
	private readonly maxHistorySize = 1000;
	private logLevel: LogLevel;

	constructor(
		channelName = "Command Central: Terminal",
		initialLogLevel: LogLevel = LogLevel.INFO,
		outputChannel?: vscode.OutputChannel, // Allow injecting output channel for testing
	) {
		if (outputChannel) {
			// Use injected output channel (for testing)
			this.outputChannel = outputChannel;
		} else {
			// Create real output channel
			this.outputChannel = vscode.window.createOutputChannel(channelName);
		}
		this.logLevel = initialLogLevel;
	}

	/**
	 * Set the minimum log level
	 */
	setLogLevel(level: LogLevel): void {
		// Log the change before updating the level so the message is always visible
		this.info(`Log level set to ${LogLevel[level]}`);
		this.logLevel = level;
	}

	/**
	 * Get the current log level
	 */
	getLogLevel(): LogLevel {
		return this.logLevel;
	}

	/**
	 * Show the output channel to the user
	 */
	show(): void {
		this.outputChannel.show();
	}

	/**
	 * Hide the output channel
	 */
	hide(): void {
		this.outputChannel.hide();
	}

	/**
	 * Clear the output channel
	 */
	clear(): void {
		this.outputChannel.clear();
		this.logHistory.length = 0;
	}

	/**
	 * Get the output channel for direct access
	 */
	getOutputChannel(): vscode.OutputChannel {
		return this.outputChannel;
	}

	/**
	 * Log a debug message
	 */
	debug(
		message: string,
		context?: string,
		data?: Record<string, unknown>,
	): void {
		this.log(LogLevel.DEBUG, message, context, undefined, data);
	}

	/**
	 * Log an info message
	 */
	info(
		message: string,
		context?: string,
		data?: Record<string, unknown>,
	): void {
		this.log(LogLevel.INFO, message, context, undefined, data);
	}

	/**
	 * Log a warning message
	 */
	warn(
		message: string,
		context?: string,
		data?: Record<string, unknown>,
	): void {
		this.log(LogLevel.WARN, message, context, undefined, data);
	}

	/**
	 * Log an error message
	 */
	error(
		message: string,
		error?: Error | unknown,
		context?: string,
		data?: Record<string, unknown>,
	): void {
		const errorObj = error instanceof Error ? error : undefined;
		this.log(LogLevel.ERROR, message, context, errorObj, data);
	}

	/**
	 * Log with performance metrics
	 */
	performance(operation: string, durationMs: number, context?: string): void {
		const message = `⏱️ ${operation}: ${durationMs.toFixed(2)}ms`;
		this.log(LogLevel.INFO, message, context);
	}

	/**
	 * Log a process lifecycle event
	 */
	process(action: string, pid: number | undefined, details?: string): void {
		const message = pid
			? `Process ${pid}: ${action}${details ? ` - ${details}` : ""}`
			: `Process: ${action}${details ? ` - ${details}` : ""}`;
		this.log(LogLevel.INFO, message, "ProcessManager");
	}

	/**
	 * Core logging method
	 */
	private log(
		level: LogLevel,
		message: string,
		context?: string,
		error?: Error,
		data?: Record<string, unknown>,
	): void {
		// Check if we should log this level
		if (level < this.logLevel) {
			return;
		}

		const entry: LogEntry = {
			timestamp: new Date(),
			level,
			message,
			context,
			error,
			data,
		};

		// Add to history
		this.addToHistory(entry);

		// Format and output the message
		const formattedMessage = this.formatMessage(entry);
		this.outputChannel.appendLine(formattedMessage);

		// For errors, also log the stack trace
		if (error?.stack) {
			this.outputChannel.appendLine(`  Stack: ${error.stack}`);
		}

		// For debug level, log additional data if present
		if (level === LogLevel.DEBUG && data) {
			this.outputChannel.appendLine(`  Data: ${JSON.stringify(data, null, 2)}`);
		}
	}

	/**
	 * Format a log message
	 */
	private formatMessage(entry: LogEntry): string {
		const timestamp = entry.timestamp.toISOString();
		const levelStr = LogLevel[entry.level].padEnd(5);
		const contextStr = entry.context ? `[${entry.context}] ` : "";
		const icon = this.getLevelIcon(entry.level);

		return `${timestamp} ${icon} ${levelStr} ${contextStr}${entry.message}`;
	}

	/**
	 * Get an icon for the log level
	 */
	private getLevelIcon(level: LogLevel): string {
		switch (level) {
			case LogLevel.DEBUG:
				return "🔍";
			case LogLevel.INFO:
				return "ℹ️";
			case LogLevel.WARN:
				return "⚠️";
			case LogLevel.ERROR:
				return "❌";
			default:
				return "📝";
		}
	}

	/**
	 * Add entry to history with size management
	 */
	private addToHistory(entry: LogEntry): void {
		this.logHistory.push(entry);

		// Trim history if it exceeds max size
		if (this.logHistory.length > this.maxHistorySize) {
			this.logHistory.shift();
		}
	}

	/**
	 * Get log history
	 */
	getHistory(limit?: number): LogEntry[] {
		if (limit) {
			return this.logHistory.slice(-limit);
		}
		return [...this.logHistory];
	}

	/**
	 * Export logs to a string
	 */
	exportLogs(): string {
		return this.logHistory.map((entry) => this.formatMessage(entry)).join("\n");
	}

	/**
	 * Dispose of resources
	 */
	dispose(): void {
		this.outputChannel.dispose();
	}
}

// Singleton instance for the extension
let loggerInstance: LoggerService | undefined;

/**
 * Get or create the singleton logger instance
 */
export function getLogger(): LoggerService {
	if (!loggerInstance) {
		loggerInstance = new LoggerService("Command Central: Terminal");
	}
	return loggerInstance;
}

/**
 * Set the singleton logger instance (useful for testing)
 */
export function setLogger(logger: LoggerService): void {
	loggerInstance = logger;
}

/**
 * Reset the singleton logger instance
 */
export function resetLogger(): void {
	if (loggerInstance) {
		loggerInstance.dispose();
		loggerInstance = undefined;
	}
}
