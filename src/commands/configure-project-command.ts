/**
 * Configure project command handler
 * Configures project settings for launcher (icon, name, theme)
 */

import type { TerminalLauncherService } from "../services/terminal-launcher-service.js";

export async function execute(service: TerminalLauncherService): Promise<void> {
	const outputChannel = service.getSecurityService().getOutputChannel();
	outputChannel.appendLine(
		"Executing commandCentral.terminal.configure command",
	);

	try {
		await service.configureProject();
		outputChannel.appendLine("Project configuration completed");
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(
			`Error in configureProject command: ${errorMessage}`,
		);
		throw new Error(`Failed to configure project: ${errorMessage}`);
	}
}
