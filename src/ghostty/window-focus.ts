/**
 * Ghostty Window Focus — targeted window activation via AppleScript
 *
 * Reads /tmp/ghostty-terminals.json for terminal mappings and uses
 * `application id` (bundle identifier) to activate specific Ghostty instances.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TERMINALS_JSON_PATH = "/tmp/ghostty-terminals.json";
const WINDOW_FOCUS_TIMEOUT_MS = 4_000;

export interface GhosttyTerminalMapping {
	terminal_id: string;
	window_id: string;
	bundle_id: string;
}

/**
 * Read /tmp/ghostty-terminals.json and find mapping for a session name.
 * Returns the mapping or null if not found / file missing / malformed.
 */
export async function lookupGhosttyTerminal(
	sessionName: string,
): Promise<GhosttyTerminalMapping | null> {
	try {
		const raw = await readFile(TERMINALS_JSON_PATH, "utf-8");
		const data = JSON.parse(raw);
		const entry = data?.[sessionName];
		if (
			entry &&
			typeof entry.terminal_id === "string" &&
			typeof entry.window_id === "string" &&
			typeof entry.bundle_id === "string"
		) {
			return entry as GhosttyTerminalMapping;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Focus a specific Ghostty window using AppleScript.
 *
 * Strategy:
 * 1. If sessionName provided, look up terminal map for bundle_id override
 * 2. Use `tell application id "<bundle_id>" to activate` + bring window 1 to front
 * 3. Fallback: `open -a <bundleId>` (current behavior)
 *
 * Returns true if focused successfully.
 */
export async function focusGhosttyWindow(
	bundleId: string,
	sessionName?: string,
): Promise<boolean> {
	// If we have a session name, try to get the precise bundle_id from the terminal map
	let effectiveBundleId = bundleId;
	if (sessionName) {
		try {
			const mapping = await lookupGhosttyTerminal(sessionName);
			if (mapping?.bundle_id) {
				effectiveBundleId = mapping.bundle_id;
			}
		} catch {
			// Use the provided bundleId
		}
	}

	// Primary: AppleScript with application id for targeted activation
	try {
		const script = `
tell application id "${effectiveBundleId}"
	activate
	if (count of windows) > 0 then
		set index of window 1 to 1
	end if
end tell`;
		await execFileAsync("osascript", ["-e", script], {
			timeout: WINDOW_FOCUS_TIMEOUT_MS,
		});
		return true;
	} catch {
		// AppleScript failed — fall back to open -a
	}

	// Fallback: open -a (activates the app but may not target the right window)
	try {
		await execFileAsync("open", ["-a", effectiveBundleId], {
			timeout: WINDOW_FOCUS_TIMEOUT_MS,
		});
		return true;
	} catch {
		return false;
	}
}
