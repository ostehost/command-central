/**
 * Launch command handler
 * Launches terminal with default settings
 */

import type { TerminalLauncherService } from "../services/terminal-launcher-service.js";

export async function execute(service: TerminalLauncherService): Promise<void> {
	const outputChannel = service.getSecurityService().getOutputChannel();
	outputChannel.appendLine("Executing commandCentral.terminal.launch command");

	try {
		const result = await service.launch();

		if (!result.success) {
			outputChannel.appendLine(`Failed to launch terminal: ${result.error}`);
			// Error is already user-friendly from service layer
			throw new Error(
				result.error ||
					"Failed to launch terminal. Check the Output panel for more details.",
			);
		}
		outputChannel.appendLine(
			`Terminal launched successfully${result.pid ? ` with PID: ${result.pid}` : ""}`,
		);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`Error in launch command: ${errorMessage}`);

		// Add context if it's a generic error
		if (
			!errorMessage.includes("terminal") &&
			!errorMessage.includes("terminal")
		) {
			throw new Error(`Failed to launch terminal: ${errorMessage}`);
		}
		throw error; // Re-throw to be handled by command registration
	}
}
