import type { LoggerService } from "../services/logger-service.js";

export interface ProjectBundleRefresher {
	isLauncherInstalled(): Promise<boolean>;
	createProjectTerminal(projectDir: string): Promise<void>;
}

interface ProjectIconBundleRefreshDeps {
	terminalManager?: ProjectBundleRefresher;
	logger?: Pick<LoggerService, "warn">;
	showWarningMessage?: (message: string) => Promise<unknown> | unknown;
}

/**
 * Best-effort Ghostty bundle refresh after project icon change.
 * The icon setting is already persisted before this runs.
 */
export async function refreshGhosttyBundleAfterProjectIconChange(
	projectDir: string,
	{ terminalManager, logger, showWarningMessage }: ProjectIconBundleRefreshDeps,
): Promise<void> {
	if (!terminalManager) return;

	let warningMessage: string | null = null;

	try {
		const launcherInstalled = await terminalManager.isLauncherInstalled();
		if (!launcherInstalled) {
			warningMessage =
				"Project icon was saved, but Ghostty launcher is unavailable, so the .app bundle icon was not refreshed.";
			logger?.warn(warningMessage, "ProjectIcon");
		} else {
			await terminalManager.createProjectTerminal(projectDir);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warningMessage = `Project icon was saved, but failed to refresh the Ghostty .app bundle icon: ${message}`;
		logger?.warn(
			`Failed to refresh Ghostty bundle after project icon change for ${projectDir}: ${message}`,
			"ProjectIcon",
		);
	}

	if (warningMessage) {
		await showWarningMessage?.(warningMessage);
	}
}
