/**
 * Launch Workspace command handler
 * Launches terminal at the workspace root
 */

import type { TerminalLauncherService } from "../services/terminal-launcher-service.js";

export async function execute(service: TerminalLauncherService): Promise<void> {
	const outputChannel = service.getSecurityService().getOutputChannel();
	outputChannel.appendLine(
		"Executing commandCentral.terminal.launchWorkspace command",
	);

	try {
		const result = await service.launchWorkspace();

		if (!result.success) {
			outputChannel.appendLine(
				`Failed to launch terminal at workspace: ${result.error}`,
			);
			// Error is already user-friendly from service layer
			throw new Error(
				result.error ||
					"Failed to launch terminal at workspace root. Check the Output panel for more details.",
			);
		}
		outputChannel.appendLine(
			`Terminal launched successfully at workspace root${result.pid ? ` with PID: ${result.pid}` : ""}`,
		);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(
			`Error in launchWorkspace command: ${errorMessage}`,
		);

		// Add context if it's a generic error
		if (
			!errorMessage.includes("terminal") &&
			!errorMessage.includes("terminal") &&
			!errorMessage.includes("workspace")
		) {
			throw new Error(
				`Failed to launch terminal at workspace: ${errorMessage}`,
			);
		}
		throw error; // Re-throw to be handled by command registration
	}
}
