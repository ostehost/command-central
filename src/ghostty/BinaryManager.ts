/**
 * BinaryManager - Manages the Command Central Ghostty fork binary
 *
 * Handles install detection, version checking, and downloading/updating
 * the CC fork of Ghostty from GitHub Releases.
 *
 * Install location: ~/.command-central/ghostty/Ghostty.app
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { LoggerService } from "../services/logger-service.js";

const DEFAULT_GITHUB_REPO = "ostehost/ghostty-fork";
const GITHUB_API_BASE = "https://api.github.com";
const INSTALL_DIR = path.join(os.homedir(), ".command-central", "ghostty");
const APP_NAME = "Ghostty.app";
const APP_PATH = path.join(INSTALL_DIR, APP_NAME);
const _APP_BAK_PATH = path.join(INSTALL_DIR, `${APP_NAME}.bak`);

/** Valid bundle ID prefixes — supports both upstream and CC fork IDs */
const VALID_BUNDLE_ID_PREFIXES = [
	"com.mitchellh.ghostty",
	"dev.partnerai.ghostty",
];

/** Key used to store the installed release tag in VS Code globalState */
const INSTALLED_TAG_KEY = "ghostty.installedTag";

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
	buildDate: string | null;
}

export interface UpdateCheckResult {
	updateAvailable: boolean;
	latestTag: string;
	installedTag: string | null;
}

export class BinaryManager {
	private readonly logger: LoggerService;
	private readonly globalState: vscode.Memento | undefined;
	private readonly githubRepo: string;

	/** Visible for testing — can be overridden */
	installPath: string = APP_PATH;

	constructor(
		logger: LoggerService,
		globalState?: vscode.Memento,
		githubRepo: string = DEFAULT_GITHUB_REPO,
	) {
		this.logger = logger;
		this.globalState = globalState;
		this.githubRepo = githubRepo;
	}

	/**
	 * Retrieves a GitHub token via VS Code's built-in authentication API.
	 * When `createIfNone` is true, triggers the OAuth flow if no session exists.
	 * Protected for testability — override in tests to inject tokens.
	 */
	protected async getGitHubToken(
		createIfNone = false,
	): Promise<string | undefined> {
		try {
			const session = await vscode.authentication.getSession(
				"github",
				["repo"],
				{ createIfNone },
			);
			return session?.accessToken;
		} catch {
			return undefined;
		}
	}

	/**
	 * Builds GitHub API request headers with optional authentication.
	 */
	private async buildHeaders(
		accept = "application/vnd.github+json",
		createIfNone = false,
	): Promise<Record<string, string>> {
		const token = await this.getGitHubToken(createIfNone);
		const headers: Record<string, string> = {
			Accept: accept,
			"User-Agent": "command-central-vscode-extension",
			"X-GitHub-Api-Version": "2022-11-28",
		};
		if (token) {
			headers["Authorization"] = `Bearer ${token}`;
		}
		return headers;
	}

	/**
	 * Checks if the Ghostty binary is installed and valid.
	 * Valid means: Ghostty.app/Contents/Info.plist exists with a recognised bundle ID.
	 */
	async isInstalled(): Promise<boolean> {
		const plistPath = path.join(this.installPath, "Contents", "Info.plist");
		if (!fs.existsSync(plistPath)) {
			this.logger.debug(`Ghostty not found at: ${plistPath}`, "BinaryManager");
			return false;
		}

		try {
			const plistContent = fs.readFileSync(plistPath, "utf-8");
			const isValid = VALID_BUNDLE_ID_PREFIXES.some((prefix) =>
				plistContent.includes(prefix),
			);
			if (!isValid) {
				this.logger.warn(
					`Info.plist at ${plistPath} does not contain a recognised Ghostty bundle ID`,
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
	 * Returns CFBundleVersion, CC fork commit hash, and build date (if present).
	 */
	async getVersion(): Promise<GhosttyVersionInfo> {
		const plistPath = path.join(this.installPath, "Contents", "Info.plist");

		try {
			const plistContent = fs.readFileSync(plistPath, "utf-8");

			const bundleVersion = extractPlistValue(plistContent, "CFBundleVersion");
			const commitHash = extractPlistValue(plistContent, "CCForkCommit");
			const buildDate = extractPlistValue(plistContent, "CCForkBuildDate");

			return { bundleVersion, commitHash, buildDate };
		} catch (err) {
			this.logger.error(
				"Failed to read version from Info.plist",
				err instanceof Error ? err : undefined,
				"BinaryManager",
			);
			return { bundleVersion: null, commitHash: null, buildDate: null };
		}
	}

	/**
	 * Checks whether a newer release is available.
	 * Compares the stored installed tag against the latest GitHub release tag.
	 */
	async checkForUpdates(): Promise<UpdateCheckResult> {
		const release = await this.getLatestRelease();
		const installedTag =
			this.globalState?.get<string>(INSTALLED_TAG_KEY) ?? null;

		return {
			updateAvailable: installedTag !== release.tag_name,
			latestTag: release.tag_name,
			installedTag,
		};
	}

	/**
	 * Fetches the latest release from GitHub.
	 * Uses https://api.github.com/repos/<owner>/<repo>/releases/latest
	 */
	async getLatestRelease(): Promise<GhosttyRelease> {
		const url = `${GITHUB_API_BASE}/repos/${this.githubRepo}/releases/latest`;
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
	 * Verifies SHA256 checksum when a .sha256 asset is present.
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

		// SHA256 verification
		const sha256Asset = findSha256Asset(release.assets, asset.name);
		if (sha256Asset) {
			await this.verifySha256(zipPath, sha256Asset.browser_download_url);
		} else {
			this.logger.warn(
				`No .sha256 asset found for ${asset.name}, skipping checksum verification`,
				"BinaryManager",
			);
		}

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

		// Store the installed tag for future update checks
		if (this.globalState) {
			await this.globalState.update(INSTALLED_TAG_KEY, tag);
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
		const url = `${GITHUB_API_BASE}/repos/${this.githubRepo}/releases/tags/${tag}`;
		const response = await this.fetchJSON(url);
		const data = (await response.json()) as GhosttyRelease;

		if (!data.tag_name || !Array.isArray(data.assets)) {
			throw new Error("Unexpected GitHub API response format");
		}

		return data;
	}

	/**
	 * Fetches a JSON endpoint from GitHub API with authentication.
	 * On 401/403/404 without a prior token, prompts for GitHub OAuth and retries once.
	 * Exposed for testing — override to inject mock behavior.
	 */
	async fetchJSON(url: string): Promise<Response> {
		const headers = await this.buildHeaders();
		let response = await this.timedFetch(url, headers, FETCH_TIMEOUT_MS);

		// If unauthenticated and the request was rejected, prompt for OAuth + retry
		if (
			(response.status === 401 ||
				response.status === 403 ||
				response.status === 404) &&
			!headers["Authorization"]
		) {
			this.logger.info(
				`GitHub API returned ${response.status}, requesting authentication…`,
				"BinaryManager",
			);
			const retryHeaders = await this.buildHeaders(
				"application/vnd.github+json",
				true,
			);
			if (retryHeaders["Authorization"]) {
				response = await this.timedFetch(url, retryHeaders, FETCH_TIMEOUT_MS);
			}
		}

		if (!response.ok) {
			throw new Error(
				`GitHub API returned ${response.status}: ${response.statusText}`,
			);
		}

		return response;
	}

	/**
	 * Performs a fetch with a timeout and specified headers.
	 */
	private async timedFetch(
		url: string,
		headers: Record<string, string>,
		timeoutMs: number,
	): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		try {
			return await fetch(url, { signal: controller.signal, headers });
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Downloads a URL to a local file path with authentication.
	 * Uses `application/octet-stream` Accept header for GitHub release asset downloads.
	 */
	protected async downloadFile(url: string, destPath: string): Promise<void> {
		const headers = await this.buildHeaders("application/octet-stream");
		const response = await this.timedFetch(url, headers, DOWNLOAD_TIMEOUT_MS);

		if (!response.ok) {
			throw new Error(
				`Download failed: ${response.status} ${response.statusText}`,
			);
		}

		const buffer = await response.arrayBuffer();
		fs.writeFileSync(destPath, Buffer.from(buffer));
	}

	/**
	 * Downloads the SHA256 checksum file and verifies the downloaded zip.
	 * Checksum file format: `<hash>  <filename>` or just `<hash>`.
	 */
	private async verifySha256(
		zipPath: string,
		sha256Url: string,
	): Promise<void> {
		this.logger.info("Verifying SHA256 checksum…", "BinaryManager");

		const headers = await this.buildHeaders("application/octet-stream");
		const response = await this.timedFetch(
			sha256Url,
			headers,
			FETCH_TIMEOUT_MS,
		);

		if (!response.ok) {
			throw new Error(
				`Failed to download SHA256 checksum: ${response.status} ${response.statusText}`,
			);
		}

		const checksumText = (await response.text()).trim();
		// Parse either "<hash>  <filename>" or plain "<hash>"
		const expectedHash = checksumText.split(/\s+/)[0]?.toLowerCase();

		if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) {
			throw new Error(
				`Invalid SHA256 checksum format: ${checksumText.slice(0, 100)}`,
			);
		}

		const fileBuffer = fs.readFileSync(zipPath);
		const actualHash = crypto
			.createHash("sha256")
			.update(fileBuffer)
			.digest("hex");

		if (actualHash !== expectedHash) {
			// Remove the corrupted download
			try {
				fs.rmSync(zipPath, { force: true });
			} catch {
				// Best effort cleanup
			}
			throw new Error(
				`SHA256 mismatch: expected ${expectedHash}, got ${actualHash}`,
			);
		}

		this.logger.info("SHA256 checksum verified ✓", "BinaryManager");
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

/**
 * Finds the SHA256 checksum asset corresponding to a given zip asset name.
 */
function findSha256Asset(
	assets: GhosttyAsset[],
	zipName: string,
): GhosttyAsset | null {
	return (
		assets.find(
			(a) =>
				a.name === `${zipName}.sha256` || a.name === `${zipName}.sha256sum`,
		) ?? null
	);
}
