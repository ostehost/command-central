/**
 * Generates macOS .app bundles for Command Central project terminals.
 * Creates a standalone app that launches Ghostty with project-specific env vars.
 */

import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface AppBundleConfig {
	projectName: string;
	projectIcon: string;
	workspacePath: string;
	theme?: string;
}

export function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

export function getAppDir(): string {
	return path.join(process.env.HOME || "~", "Applications", "CommandCentral");
}

export function getAppPath(projectName: string): string {
	return path.join(getAppDir(), `${projectName}.app`);
}

function generateLaunchScript(config: AppBundleConfig): string {
	const themeArg = config.theme
		? ` --config-file="" --font-thicken --theme="${config.theme}"`
		: "";
	return `#!/bin/bash
export COMMAND_CENTRAL_PROJECT="${config.projectName}"
export COMMAND_CENTRAL_ROOT="${config.workspacePath}"
exec /Applications/Ghostty.app/Contents/MacOS/ghostty --working-directory="${config.workspacePath}"${themeArg}
`;
}

function generateInfoPlist(config: AppBundleConfig): string {
	const slug = slugify(config.projectName);
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>${config.projectName}</string>
	<key>CFBundleIdentifier</key>
	<string>com.commandcentral.${slug}</string>
	<key>CFBundleVersion</key>
	<string>1.0</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleExecutable</key>
	<string>launch</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>LSMinimumSystemVersion</key>
	<string>12.0</string>
</dict>
</plist>
`;
}

/**
 * Generate .icns from an emoji using osascript + iconutil.
 * Falls back silently if it fails — the app will just use a generic icon.
 */
async function generateEmojiIcon(
	emoji: string,
	resourcesDir: string,
): Promise<boolean> {
	const iconsetDir = path.join(resourcesDir, "AppIcon.iconset");
	try {
		await fs.promises.mkdir(iconsetDir, { recursive: true });

		// Render emoji to PNG at various sizes using osascript
		const sizes = [16, 32, 64, 128, 256, 512];
		for (const size of sizes) {
			const pngPath = path.join(iconsetDir, `icon_${size}x${size}.png`);
			const retinaPngPath = path.join(
				iconsetDir,
				`icon_${size}x${size}@2x.png`,
			);

			// Use osascript to render emoji to image
			const script = (s: number, out: string) =>
				`osascript -e '
use framework "AppKit"
set theImage to current application\\'s NSImage\\'s alloc()\\'s initWithSize:{${s}, ${s}}
theImage\\'s lockFocus()
set theString to current application\\'s NSAttributedString\\'s alloc()\\'s initWithString:"${emoji}" attributes:{NSFont:current application\\'s NSFont\\'s systemFontOfSize:${s * 0.75}}
theString\\'s drawAtPoint:{${s * 0.1}, ${s * 0.1}}
theImage\\'s unlockFocus()
set tiffData to theImage\\'s TIFFRepresentation()
set bitmapRep to current application\\'s NSBitmapImageRep\\'s imageRepWithData:tiffData
set pngData to bitmapRep\\'s representationUsingType:(current application\\'s NSBitmapImageFileTypePNG) properties:{}
pngData\\'s writeToFile:"${out}" atomically:true
'`;

			await execAsync(script(size, pngPath), { timeout: 10000 });
			if (size <= 256) {
				await execAsync(script(size * 2, retinaPngPath), { timeout: 10000 });
			}
		}

		// Convert iconset to icns
		await execAsync(
			`iconutil -c icns "${iconsetDir}" -o "${path.join(resourcesDir, "AppIcon.icns")}"`,
			{ timeout: 10000 },
		);

		// Cleanup iconset
		await fs.promises.rm(iconsetDir, { recursive: true, force: true });
		return true;
	} catch {
		// Cleanup on failure
		await fs.promises
			.rm(iconsetDir, { recursive: true, force: true })
			.catch(() => {});
		return false;
	}
}

export async function generateAppBundle(
	config: AppBundleConfig,
): Promise<string> {
	const appPath = getAppPath(config.projectName);
	const contentsDir = path.join(appPath, "Contents");
	const macosDir = path.join(contentsDir, "MacOS");
	const resourcesDir = path.join(contentsDir, "Resources");

	// Create directory structure
	await fs.promises.mkdir(macosDir, { recursive: true });
	await fs.promises.mkdir(resourcesDir, { recursive: true });

	// Write launch script
	const launchPath = path.join(macosDir, "launch");
	await fs.promises.writeFile(launchPath, generateLaunchScript(config), {
		mode: 0o755,
	});

	// Write Info.plist
	await fs.promises.writeFile(
		path.join(contentsDir, "Info.plist"),
		generateInfoPlist(config),
	);

	// Generate icon (best effort)
	if (config.projectIcon) {
		await generateEmojiIcon(config.projectIcon, resourcesDir);
	}

	return appPath;
}

export async function launchApp(appPath: string): Promise<void> {
	await execAsync(`open -a "${appPath}"`, { timeout: 10000 });
}
