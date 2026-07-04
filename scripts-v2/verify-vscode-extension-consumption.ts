#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface VerifyConsumptionArgs {
	vsixPath: string;
	expectedVersion?: string;
	codeBin: string;
	extensionsDir: string;
	manifestOut?: string;
	nodeLabel?: string;
	receiptDir?: string;
}

export interface VsixPackageIdentity {
	publisher: string;
	name: string;
	version: string;
}

export interface SiblingExtension {
	/** Directory basename, e.g. `oste.command-central-0.6.0-rc.71`. */
	name: string;
	/** Absolute path to the sibling extension directory. */
	path: string;
	/** Version parsed from the directory name. */
	version: string;
	/** True when this sibling is older than the verified version. */
	stale: boolean;
}

export interface ConsumptionReceipt {
	generatedAt: string;
	nodeLabel?: string;
	vsixPath: string;
	vsixSha256: string;
	vsixIdentity: VsixPackageIdentity;
	expectedVersion: string;
	codeBin: string;
	extensionsDir: string;
	installedExtensionId: string;
	installedVersionFromCode: string | null;
	installedPackagePath: string;
	installedPackageVersion: string | null;
	/**
	 * Other `oste.command-central-*` extension directories found alongside the
	 * verified install. Read-only intelligence: stale copies are flagged but
	 * never touched, so operators can spot installs that confuse visible proof.
	 */
	siblingExtensions: SiblingExtension[];
	/** Non-fatal notes (e.g. stale siblings). Do not affect {@link success}. */
	warnings: string[];
	success: boolean;
	errors: string[];
}

function usage(): never {
	throw new Error(
		[
			"Usage: bun run scripts-v2/verify-vscode-extension-consumption.ts --vsix <path> [--expected-version <version>] [--manifest-out <path>]",
			"",
			"Optional:",
			"  --code-bin <path>        Defaults to code",
			"  --extensions-dir <path> Defaults to ~/.vscode/extensions",
			"  --node-label <label>    Records which host produced the receipt (e.g. hub, node)",
			"  --receipt-dir <path>    Auto-names the receipt vscode-consumption-<version>[-<label>].json",
		].join("\n"),
	);
}

function argValue(args: string[], flag: string): string | undefined {
	const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
	if (index === -1) return undefined;
	const current = args[index];
	if (!current) return undefined;
	if (current.includes("=")) return current.split("=").slice(1).join("=");
	return args[index + 1];
}

export function resolveDefaultExtensionsDir(): string {
	const home = os.homedir();
	const userInfo = os.userInfo();
	let profileHome = home;

	if (home.includes(`${path.sep}.openclaw${path.sep}`)) {
		const macUserHome = path.join("/Users", userInfo.username);
		profileHome = fs.existsSync(macUserHome) ? macUserHome : userInfo.homedir;
	}

	return path.join(profileHome, ".vscode", "extensions");
}

export function parseArgs(args: string[]): VerifyConsumptionArgs {
	const vsixPath = argValue(args, "--vsix");
	if (!vsixPath) usage();
	const manifestOut = argValue(args, "--manifest-out");
	const receiptDir = argValue(args, "--receipt-dir");
	return {
		vsixPath: path.resolve(vsixPath),
		expectedVersion: argValue(args, "--expected-version"),
		codeBin: argValue(args, "--code-bin") ?? "code",
		extensionsDir: path.resolve(
			argValue(args, "--extensions-dir") ?? resolveDefaultExtensionsDir(),
		),
		manifestOut: manifestOut ? path.resolve(manifestOut) : undefined,
		nodeLabel: argValue(args, "--node-label"),
		receiptDir: receiptDir ? path.resolve(receiptDir) : undefined,
	};
}

/**
 * Per-RC, per-node receipt filename. CCREL-05 needs install proof on BOTH the
 * hub AND the node for the same RC, so receipts must not collide: the version
 * and the optional node label both go in the name. Example:
 * `vscode-consumption-0.6.0-rc.71-node.json`.
 */
export function receiptFileName(version: string, nodeLabel?: string): string {
	const safeLabel = nodeLabel?.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
	const suffix = safeLabel ? `-${safeLabel}` : "";
	return `vscode-consumption-${version}${suffix}.json`;
}

export function extensionId(identity: VsixPackageIdentity): string {
	return `${identity.publisher}.${identity.name}`;
}

export function parseInstalledVersion(
	listExtensionsOutput: string,
	id: string,
): string | null {
	const prefix = `${id.toLowerCase()}@`;
	for (const line of listExtensionsOutput.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.toLowerCase().startsWith(prefix)) {
			return trimmed.slice(prefix.length);
		}
	}
	return null;
}

function sha256File(filePath: string): string {
	const hash = createHash("sha256");
	hash.update(fs.readFileSync(filePath));
	return hash.digest("hex");
}

function readVsixPackageIdentity(vsixPath: string): VsixPackageIdentity {
	const raw = execFileSync("unzip", ["-p", vsixPath, "extension/package.json"], {
		encoding: "utf8",
	});
	const pkg = JSON.parse(raw) as Partial<VsixPackageIdentity>;
	if (!pkg.publisher || !pkg.name || !pkg.version) {
		throw new Error(`VSIX package.json is missing publisher/name/version: ${vsixPath}`);
	}
	return {
		publisher: pkg.publisher,
		name: pkg.name,
		version: pkg.version,
	};
}

function readInstalledPackageVersion(packagePath: string): string | null {
	if (!fs.existsSync(packagePath)) return null;
	const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
		version?: unknown;
	};
	return typeof pkg.version === "string" ? pkg.version : null;
}

export function buildInstalledPackagePath(
	extensionsDir: string,
	identity: VsixPackageIdentity,
): string {
	return path.join(
		extensionsDir,
		`${extensionId(identity)}-${identity.version}`,
		"package.json",
	);
}

interface ParsedExtensionVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease: string | null;
}

/**
 * Parses a bare extension version such as `0.6.0-rc.71`. Returns null for
 * anything that is not a `major.minor.patch[-prerelease]` string, which is how
 * we distinguish a real sibling directory from an unrelated extension whose id
 * merely shares our prefix (e.g. `oste.command-central-extra-1.0.0`).
 */
export function parseExtensionVersion(
	version: string,
): ParsedExtensionVersion | null {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
	if (!match) return null;
	const [, major, minor, patch, prerelease] = match;
	if (!major || !minor || !patch) return null;
	return {
		major: Number.parseInt(major, 10),
		minor: Number.parseInt(minor, 10),
		patch: Number.parseInt(patch, 10),
		prerelease: prerelease ?? null,
	};
}

/**
 * Ascending semver-ish comparison: negative when `a` is older than `b`. Mirrors
 * the precedence used by dist-simple-utils (a released version outranks a
 * prerelease of the same triple; prereleases compare numerically).
 */
export function compareExtensionVersions(a: string, b: string): number {
	const versionA = parseExtensionVersion(a);
	const versionB = parseExtensionVersion(b);
	if (!versionA || !versionB) {
		return a.localeCompare(b, undefined, { numeric: true });
	}
	if (versionA.major !== versionB.major) return versionA.major - versionB.major;
	if (versionA.minor !== versionB.minor) return versionA.minor - versionB.minor;
	if (versionA.patch !== versionB.patch) return versionA.patch - versionB.patch;
	const preA = versionA.prerelease;
	const preB = versionB.prerelease;
	if (preA === preB) return 0;
	if (preA === null) return 1;
	if (preB === null) return -1;
	return preA.localeCompare(preB, undefined, { numeric: true });
}

/**
 * Enumerates other `<id>-<version>` directories in the extensions dir, excluding
 * the verified version's own directory. Purely read-only — it never deletes or
 * mutates a sibling (honors the never-blind-delete rule). Siblings older than
 * the verified version are flagged `stale`. Returns [] when the extensions dir
 * is unreadable rather than throwing, so a missing profile never fails the gate.
 */
export function findSiblingExtensions(
	extensionsDir: string,
	id: string,
	verifiedVersion: string,
): SiblingExtension[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const prefix = `${id}-`;
	const siblings: SiblingExtension[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (!entry.name.startsWith(prefix)) continue;
		const version = entry.name.slice(prefix.length);
		if (!parseExtensionVersion(version)) continue;
		if (version === verifiedVersion) continue;
		siblings.push({
			name: entry.name,
			path: path.join(extensionsDir, entry.name),
			version,
			stale: compareExtensionVersions(version, verifiedVersion) < 0,
		});
	}
	siblings.sort((a, b) => compareExtensionVersions(a.version, b.version));
	return siblings;
}

export function verifyConsumption(args: VerifyConsumptionArgs): ConsumptionReceipt {
	const identity = readVsixPackageIdentity(args.vsixPath);
	const id = extensionId(identity);
	const expectedVersion = args.expectedVersion ?? identity.version;
	const listOutput = execFileSync(args.codeBin, [
		"--list-extensions",
		"--show-versions",
	], { encoding: "utf8" });
	const installedVersionFromCode = parseInstalledVersion(listOutput, id);
	const installedPackagePath = buildInstalledPackagePath(
		args.extensionsDir,
		identity,
	);
	const installedPackageVersion =
		readInstalledPackageVersion(installedPackagePath);
	const siblingExtensions = findSiblingExtensions(
		args.extensionsDir,
		id,
		expectedVersion,
	);
	const warnings: string[] = [];
	for (const sibling of siblingExtensions) {
		if (sibling.stale) {
			warnings.push(
				`Stale sibling extension ${sibling.name} (${sibling.version}) is older than verified ${expectedVersion} and may confuse visible UI proof: ${sibling.path}`,
			);
		}
	}
	const errors: string[] = [];

	if (identity.version !== expectedVersion) {
		errors.push(
			`VSIX version ${identity.version} does not match expected ${expectedVersion}.`,
		);
	}
	if (installedVersionFromCode !== expectedVersion) {
		errors.push(
			`code reports ${id}@${installedVersionFromCode ?? "(missing)"} instead of ${expectedVersion}.`,
		);
	}
	if (installedPackageVersion !== expectedVersion) {
		errors.push(
			`Installed package ${installedPackagePath} has version ${installedPackageVersion ?? "(missing)"} instead of ${expectedVersion}.`,
		);
	}

	return {
		generatedAt: new Date().toISOString(),
		nodeLabel: args.nodeLabel,
		vsixPath: args.vsixPath,
		vsixSha256: sha256File(args.vsixPath),
		vsixIdentity: identity,
		expectedVersion,
		codeBin: args.codeBin,
		extensionsDir: args.extensionsDir,
		installedExtensionId: id,
		installedVersionFromCode,
		installedPackagePath,
		installedPackageVersion,
		siblingExtensions,
		warnings,
		success: errors.length === 0,
		errors,
	};
}

if (import.meta.main) {
	try {
		const args = parseArgs(Bun.argv.slice(2));
		const receipt = verifyConsumption(args);
		if (args.manifestOut) {
			fs.mkdirSync(path.dirname(args.manifestOut), { recursive: true });
			fs.writeFileSync(args.manifestOut, `${JSON.stringify(receipt, null, 2)}\n`);
		}
		if (args.receiptDir) {
			const receiptPath = path.join(
				args.receiptDir,
				receiptFileName(receipt.expectedVersion, args.nodeLabel),
			);
			fs.mkdirSync(args.receiptDir, { recursive: true });
			fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
		}
		for (const warning of receipt.warnings) {
			console.warn(`warning: ${warning}`);
		}
		console.log(JSON.stringify(receipt, null, 2));
		if (!receipt.success) process.exit(1);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
