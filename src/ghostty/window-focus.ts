/**
 * Ghostty Window Focus — launcher-aware activation via AppleScript.
 *
 * Uses the ghostty-launcher `oste-focus.applescript` helper when we have a
 * launcher-managed bundle ID so Command Central can raise the exact project
 * window by session ID. Non-launcher targets fall back to plain `open -a`.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

// IMPORTANT: `promisify(execFile)` captured at module scope snapshots the
// real execFile reference at load time and bypasses any later
// `mock.module("node:child_process", ...)`. Use a closure so the
// identifier resolves via ES live binding on every call. See
// src/discovery/process-scanner.ts for the full rationale.
function execFileAsync(
	file: string,
	args: ReadonlyArray<string>,
	options: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(file, args as string[], options, (err, stdout, stderr) => {
			if (err) reject(err);
			else
				resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}
const require = createRequire(import.meta.url);

const WINDOW_FOCUS_TIMEOUT_MS = 12_000;
const LAUNCHER_BUNDLE_PREFIX = "dev.partnerai.ghostty.";
const STOCK_GHOSTTY_BUNDLE_ID = "com.mitchellh.ghostty";
const LAUNCHER_FOCUS_SCRIPT_NAME = "oste-focus.applescript";
const DEFAULT_LAUNCHER_FOCUS_SCRIPT = path.join(
	os.homedir(),
	"projects",
	"ghostty-launcher",
	"scripts",
	LAUNCHER_FOCUS_SCRIPT_NAME,
);

function isBundlePath(target: string): boolean {
	return target.includes("/") || target.endsWith(".app");
}

function isLauncherBundleId(bundleId: string): boolean {
	return (
		bundleId.startsWith(LAUNCHER_BUNDLE_PREFIX) &&
		bundleId.length > LAUNCHER_BUNDLE_PREFIX.length &&
		bundleId !== STOCK_GHOSTTY_BUNDLE_ID
	);
}

function launcherAppPathFromBundleId(bundleId: string): string | null {
	if (!isLauncherBundleId(bundleId)) {
		return null;
	}

	const projectId = bundleId.slice(LAUNCHER_BUNDLE_PREFIX.length);
	return path.join("/Applications/Projects", `${projectId}.app`);
}

function lookupConfiguredLauncherPath(): string | null {
	try {
		const vscode = require("vscode") as typeof import("vscode");
		const configured = vscode.workspace
			.getConfiguration("commandCentral")
			.get<string>("ghostty.launcherPath");
		const trimmed = configured?.trim();
		return trimmed ? trimmed : null;
	} catch {
		return null;
	}
}

function configuredFocusScriptCandidates(): string[] {
	const launcherPath = lookupConfiguredLauncherPath();
	if (!launcherPath) {
		return [];
	}

	const resolvedLauncherPath = path.resolve(launcherPath);
	const launcherDir = path.dirname(resolvedLauncherPath);
	const parentDir = path.dirname(launcherDir);
	const candidates = [
		path.join(launcherDir, "scripts", LAUNCHER_FOCUS_SCRIPT_NAME),
		path.basename(launcherDir) === "scripts"
			? path.join(launcherDir, LAUNCHER_FOCUS_SCRIPT_NAME)
			: null,
		path.join(parentDir, "scripts", LAUNCHER_FOCUS_SCRIPT_NAME),
	];

	return candidates.filter((candidate): candidate is string =>
		Boolean(candidate),
	);
}

export function lookupLauncherFocusScript(): string | null {
	const candidates = [
		DEFAULT_LAUNCHER_FOCUS_SCRIPT,
		...configuredFocusScriptCandidates(),
	];

	for (const candidate of new Set(candidates)) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	return null;
}

async function activateGhosttyTarget(target: string): Promise<boolean> {
	try {
		await execFileAsync("open", ["-a", target], {
			timeout: WINDOW_FOCUS_TIMEOUT_MS,
		});
		return true;
	} catch {
		return false;
	}
}

export async function focusGhosttyWindowBySession(
	bundleTarget: string,
	sessionId?: string,
): Promise<boolean> {
	if (isBundlePath(bundleTarget)) {
		return activateGhosttyTarget(bundleTarget);
	}

	if (!isLauncherBundleId(bundleTarget)) {
		return activateGhosttyTarget(bundleTarget);
	}

	const focusScriptPath = lookupLauncherFocusScript();
	const appPath = launcherAppPathFromBundleId(bundleTarget) ?? bundleTarget;
	if (!focusScriptPath) {
		return activateGhosttyTarget(appPath);
	}

	try {
		const args = [focusScriptPath, bundleTarget];
		const trimmedSessionId = sessionId?.trim();
		if (trimmedSessionId) {
			args.push(trimmedSessionId);
		}
		await execFileAsync("osascript", args, {
			timeout: WINDOW_FOCUS_TIMEOUT_MS,
		});
		return true;
	} catch {
		return activateGhosttyTarget(appPath);
	}
}

export async function focusGhosttyWindow(
	bundleTarget: string,
	sessionId?: string,
): Promise<boolean> {
	return focusGhosttyWindowBySession(bundleTarget, sessionId);
}

/**
 * Focus the Ghostty app without System Events, then select a tmux window.
 *
 * Unlike `focusGhosttyWindowBySession`, this function never calls
 * `oste-focus.applescript` and therefore never triggers the macOS
 * System Events permission dialog.  It uses `open -a <appPath>` to bring
 * the Ghostty bundle to the foreground, then runs
 * `tmux select-window -t <windowId>` to land on the correct agent window.
 */
export async function focusGhosttyBundleAndTmuxWindow(
	bundleIdOrPath: string,
	tmuxTarget?: {
		socket?: string | null;
		windowId?: string | null;
		sessionId?: string | null;
	},
): Promise<boolean> {
	// Resolve the path to open:
	//   launcher bundle ID  → /Applications/Projects/<projectId>.app
	//   bundle path         → use as-is
	//   stock bundle ID     → use as-is (open -a accepts bundle IDs too)
	let appTarget: string;
	if (isBundlePath(bundleIdOrPath)) {
		appTarget = bundleIdOrPath;
	} else if (isLauncherBundleId(bundleIdOrPath)) {
		appTarget = launcherAppPathFromBundleId(bundleIdOrPath) ?? bundleIdOrPath;
	} else {
		appTarget = bundleIdOrPath;
	}

	// Step 1: bring Ghostty to the foreground — no System Events required
	const focused = await activateGhosttyTarget(appTarget);
	if (!focused) return false;

	// Step 2: select the right tmux window (non-fatal if it fails)
	if (tmuxTarget) {
		const windowTarget =
			tmuxTarget.windowId?.trim() || tmuxTarget.sessionId?.trim();
		if (windowTarget) {
			const args: string[] = [];
			const socket = tmuxTarget.socket?.trim();
			if (socket) {
				args.push("-S", socket);
			}
			args.push("select-window", "-t", windowTarget);
			try {
				await execFileAsync("tmux", args, {
					timeout: WINDOW_FOCUS_TIMEOUT_MS,
				});
			} catch {
				// tmux select-window failure is non-fatal; app is already focused
			}
		}
	}

	return true;
}
