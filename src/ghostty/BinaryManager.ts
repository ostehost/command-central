/**
 * BinaryManager - Manages the Command Central Ghostty fork binary
 *
 * Handles install detection, version checking, and downloading/updating
 * the CC fork of Ghostty from GitHub Releases.
 *
 * Install location: ~/.command-central/ghostty/Ghostty.app
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LoggerService } from "../services/logger-service.js";

const GITHUB_REPO = "ostehost/ghostty-fork";
const GITHUB_API_BASE = "https://api.github.com";
const INSTALL_DIR = path.join(os.homedir(), ".command-central", "ghostty");
const APP_NAME = "Ghostty.app";
const APP_PATH = path.join(INSTALL_DIR, APP_NAME);
const _APP_BAK_PATH = path.join(INSTALL_DIR, `${APP_NAME}.bak`);
const GHOSTTY_BUNDLE_ID_PREFIX = "com.mitchellh.ghostty";

/** Timeout for GitHub API calls (ms) */
const FETCH_TIMEOUT_MS = 15_000;

/** Timeout for download + extraction (ms) */
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface GhosttyRelease {
	tag_name: string;
	assets: GhosttyAsset[];
}

export interface GhosttyAsset {
	name: string;
	browser_download_url: string;
}

export interface GhosttyVersionInfo {
	bundleVersion: string | null;
	commitHash: string | null;
}

export class BinaryManager {
	private readonly logger: LoggerService;

	/** Visible for testing — can be overridden */
	installPath: string = APP_PATH;

	constructor(logger: LoggerService) {
		this.logger = logger;
	}

	/**
	 * Checks if the Ghostty binary is installed and valid.
	 * Valid means: Ghostty.app/Contents/Info.plist exists with the Ghostty bundle ID.
	 */
	async isInstalled(): Promise<boolean> {
		const plistPath = path.join(this.installPath, "Contents", "Info.plist");
		if (!fs.existsSync(plistPath)) {
			this.logger.debug(`Ghostty not found at: ${plistPath}`, "BinaryManager");
			return false;
		}

		try {
			const plistContent = fs.readFileSync(plistPath, "utf-8");
			const isValid = plistContent.includes(GHOSTTY_BUNDLE_ID_PREFIX);
			if (!isValid) {
				this.logger.warn(
					`Info.plist at ${plistPath} does not contain Ghostty bundle ID`,
					"BinaryManager",
				);
			}
			return isValid;
		} catch (err) {
			this.logger.error(
				"Failed to read Info.plist",
				err instanceof Error ? err : undefined,
				"BinaryManager",
			);
			return false;
		}
	}

	/**
	 * Reads version information from the installed Ghostty binary.
	 * Returns CFBundleVersion and CC commit hash (if present in plist).
	 */
	async getVersion(): Promise<GhosttyVersionInfo> {
		const plistPath = path.join(this.installPath, "Contents", "Info.plist");

		try {
			const plistContent = fs.readFileSync(plistPath, "utf-8");

			const bundleVersion = extractPlistValue(plistContent, "CFBundleVersion");
			// CC builds may embed a commit hash under a custom key
			const commitHash = extractPlistValue(plistContent, "CCCommitHash");

			return { bundleVersion, commitHash };
		} catch (err) {
			this.logger.error(
				"Failed to read version from Info.plist",
				err instanceof Error ? err : undefined,
				"BinaryManager",
			);
			return { bundleVersion: null, commitHash: null };
		}
	}

	/**
	 * Fetches the latest release from GitHub.
	 * Uses https://api.github.com/repos/<owner>/<repo>/releases/latest
	 */
	async getLatestRelease(): Promise<GhosttyRelease> {
		const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/releases/latest`;
		this.logger.info(`Checking latest release at: ${url}`, "BinaryManager");

		const response = await this.fetchJSON(url);
		const data = (await response.json()) as GhosttyRelease;

		if (!data.tag_name || !Array.isArray(data.assets)) {
			throw new Error("Unexpected GitHub API response format");
		}

		this.logger.info(
			`Latest release: ${data.tag_name} (${data.assets.length} assets)`,
			"BinaryManager",
		);

		return data;
	}

	/**
	 * Downloads and installs the release with the given tag.
	 * Backs up existing install to Ghostty.app.bak before overwriting.
	 *
	 * Expects a zip asset in the release whose name contains "Ghostty" and ends with ".zip".
	 */
	async downloadRelease(tag: string): Promise<void> {
		this.logger.info(`Downloading release: ${tag}`, "BinaryManager");

		const release = await this.getReleaseByTag(tag);
		const asset = findZipAsset(release.assets);

		if (!asset) {
			throw new Error(
				`No zip asset found for tag ${tag}. Available: ${release.assets.map((a) => a.name).join(", ")}`,
			);
		}

		this.logger.info(
			`Downloading asset: ${asset.name} from ${asset.browser_download_url}`,
			"BinaryManager",
		);

		// Ensure install directory exists
		fs.mkdirSync(INSTALL_DIR, { recursive: true });

		// Download the zip
		const zipPath = path.join(os.tmpdir(), `ghostty-cc-${tag}.zip`);
		await this.downloadFile(asset.browser_download_url, zipPath);

		this.logger.info(`Downloaded to: ${zipPath}`, "BinaryManager");

		// Back up existing install
		const bakPath = path.join(
			path.dirname(this.installPath),
			`${APP_NAME}.bak`,
		);
		if (fs.existsSync(this.installPath)) {
			this.logger.info(
				`Backing up existing install to: ${bakPath}`,
				"BinaryManager",
			);
			if (fs.existsSync(bakPath)) {
				fs.rmSync(bakPath, { recursive: true, force: true });
			}
			fs.renameSync(this.installPath, bakPath);
		}

		// Extract zip to install directory
		await this.extractZip(zipPath, path.dirname(this.installPath));

		// Validate that the app was installed
		const installed = await this.isInstalled();
		if (!installed) {
			// Restore backup on failure
			if (fs.existsSync(bakPath)) {
				this.logger.warn(
					"Validation failed, restoring backup",
					"BinaryManager",
				);
				if (fs.existsSync(this.installPath)) {
					fs.rmSync(this.installPath, { recursive: true, force: true });
				}
				fs.renameSync(bakPath, this.installPath);
			}
			throw new Error(
				"Ghostty app validation failed after extraction — backup restored",
			);
		}

		// Clean up temp file
		try {
			fs.rmSync(zipPath, { force: true });
		} catch {
			// Non-critical cleanup failure
		}

		this.logger.info(
			`Successfully installed Ghostty ${tag} to: ${this.installPath}`,
			"BinaryManager",
		);
	}

	/**
	 * Fetches a specific release by tag name.
	 */
	async getReleaseByTag(tag: string): Promise<GhosttyRelease> {
		const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/releases/tags/${tag}`;
		const response = await this.fetchJSON(url);
		const data = (await response.json()) as GhosttyRelease;

		if (!data.tag_name || !Array.isArray(data.assets)) {
			throw new Error("Unexpected GitHub API response format");
		}

		return data;
	}

	/**
	 * Fetches a JSON endpoint from GitHub API with proper headers.
	 * Throws on non-ok response. Exposed for testing — override to inject mock behavior.
	 */
	async fetchJSON(url: string): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

		let response: Response;
		try {
			response = await fetch(url, {
				signal: controller.signal,
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "command-central-vscode-extension",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});
		} finally {
			clearTimeout(timer);
		}

		if (!response.ok) {
			throw new Error(
				`GitHub API returned ${response.status}: ${response.statusText}`,
			);
		}

		return response;
	}

	/**
	 * Downloads a URL to a local file path.
	 */
	protected async downloadFile(url: string, destPath: string): Promise<void> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

		let response: Response;
		try {
			response = await fetch(url, { signal: controller.signal });
		} finally {
			clearTimeout(timer);
		}

		if (!response.ok) {
			throw new Error(
				`Download failed: ${response.status} ${response.statusText}`,
			);
		}

		const buffer = await response.arrayBuffer();
		fs.writeFileSync(destPath, Buffer.from(buffer));
	}

	/**
	 * Extracts a zip file to the target directory using the system `unzip` command.
	 * Uses a dynamic import so tests can mock node:child_process at call time.
	 */
	protected async extractZip(
		zipPath: string,
		targetDir: string,
	): Promise<void> {
		this.logger.info(`Extracting ${zipPath} to ${targetDir}`, "BinaryManager");

		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFile);

		try {
			await execFileAsync("unzip", ["-o", zipPath, "-d", targetDir], {
				timeout: DOWNLOAD_TIMEOUT_MS,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to extract zip: ${message}`);
		}
	}
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Extracts a string value for a given key from plist XML content.
 * Handles the common <key>K</key><string>V</string> pattern.
 */
function extractPlistValue(plistContent: string, key: string): string | null {
	const keyPattern = new RegExp(
		`<key>${escapeRegex(key)}</key>\\s*<string>([^<]+)</string>`,
	);
	const match = keyPattern.exec(plistContent);
	return match?.[1] ?? null;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds the primary zip asset in a list of release assets.
 * Prefers assets containing "Ghostty" in the name and ending with ".zip".
 */
function findZipAsset(assets: GhosttyAsset[]): GhosttyAsset | null {
	// Prefer named CC build artifacts first
	const preferred = assets.find(
		(a) => a.name.toLowerCase().includes("ghostty") && a.name.endsWith(".zip"),
	);
	if (preferred) return preferred;

	// Fall back to any zip
	return assets.find((a) => a.name.endsWith(".zip")) ?? null;
}
