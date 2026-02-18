/**
 * Central configuration management for Script Architecture V2
 * Provides defaults and merging capabilities for all build operations
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { getUTCDateString } from "../../src/utils/formatters.ts";

export interface ExtensionConfig {
	paths: {
		root: string;
		entry: string;
		dist: string;
		test: string;
		src: string;
	};
	development: {
		sourcemap: "inline" | "external" | false;
		typecheck: boolean;
		minify: boolean;
		inspectPort: number;
		disableExtensions: boolean;
	};
	production: {
		sourcemap: "external" | false;
		minify: boolean;
		typecheck: boolean;
		runTests: boolean;
		validateLevel: "quick" | "standard" | "full";
	};
	vsix: {
		outputDir: string;
		nameTemplate: string; // e.g., "{name}-{version}.vsix"
		includeSourceMap: boolean;
		skipValidation: boolean;
	};
	performance: {
		measureBuild: boolean;
		reportThreshold: number; // ms
	};
}

/**
 * Get default configuration
 */
export function getDefaults(): ExtensionConfig {
	const root = process.cwd();
	return {
		paths: {
			root,
			entry: path.join(root, "src", "extension.ts"),
			dist: path.join(root, "dist"),
			test: path.join(root, "test"),
			src: path.join(root, "src"),
		},
		development: {
			sourcemap: "inline",
			typecheck: true,
			minify: false,
			inspectPort: 9229,
			disableExtensions: true,
		},
		production: {
			sourcemap: "external",
			minify: true,
			typecheck: true,
			runTests: true,
			validateLevel: "full",
		},
		vsix: {
			outputDir: path.join(root, "dist"),
			nameTemplate: "{name}-{version}.vsix",
			includeSourceMap: false,
			skipValidation: false,
		},
		performance: {
			measureBuild: true,
			reportThreshold: 5000, // Report if build takes > 5s
		},
	};
}

/**
 * Load configuration from package.json and merge with defaults
 */
export async function loadConfig(): Promise<ExtensionConfig> {
	const defaults = getDefaults();

	try {
		// Read package.json for name and version
		const packageJsonPath = path.join(defaults.paths.root, "package.json");
		const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));

		// Check for custom config in package.json under "scripts-v2" key
		const customConfig = packageJson["scripts-v2"] || {};

		return mergeConfig(defaults, customConfig);
	} catch (error) {
		// If package.json doesn't exist or has issues, return defaults
		console.warn("⚠️  Could not load package.json, using defaults");
		return defaults;
	}
}

/**
 * Merge configurations with proper deep merging
 */
export function mergeConfig(
	base: ExtensionConfig,
	overrides: Partial<ExtensionConfig>,
): ExtensionConfig {
	return {
		paths: {
			...base.paths,
			...(overrides.paths || {}),
		},
		development: {
			...base.development,
			...(overrides.development || {}),
		},
		production: {
			...base.production,
			...(overrides.production || {}),
		},
		vsix: {
			...base.vsix,
			...(overrides.vsix || {}),
		},
		performance: {
			...base.performance,
			...(overrides.performance || {}),
		},
	};
}

/**
 * Get package.json metadata
 */
export interface PackageMetadata {
	name: string;
	displayName?: string;
	version: string;
	description?: string;
	publisher?: string;
}

export async function getPackageMetadata(): Promise<PackageMetadata> {
	const config = await loadConfig();
	const packageJsonPath = path.join(config.paths.root, "package.json");

	try {
		const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
		return {
			name: packageJson.name || "unknown",
			displayName: packageJson.displayName,
			version: packageJson.version || "0.0.0",
			description: packageJson.description,
			publisher: packageJson.publisher,
		};
	} catch {
		return {
			name: "unknown",
			version: "0.0.0",
		};
	}
}

/**
 * Resolve VSIX output filename with template variables
 */
export async function resolveVSIXPath(
	template?: string,
): Promise<string> {
	const config = await loadConfig();
	const metadata = await getPackageMetadata();
	const finalTemplate: string = template ?? config.vsix.nameTemplate;

	const filename = finalTemplate
		.replace("{name}", metadata.name)
		.replace("{version}", metadata.version)
		.replace("{timestamp}", getUTCDateString(new Date()));

	return path.join(config.vsix.outputDir, filename);
}

/**
 * Check if running in CI environment
 */
export function isCI(): boolean {
	return process.env["CI"] === "true" || process.env["GITHUB_ACTIONS"] === "true";
}

/**
 * Get mode based on environment
 */
export function getMode(): "development" | "production" {
	return process.env["NODE_ENV"] === "production" ? "production" : "development";
}