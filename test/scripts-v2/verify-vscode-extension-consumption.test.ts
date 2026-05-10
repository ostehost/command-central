import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	buildInstalledPackagePath,
	extensionId,
	parseArgs,
	parseInstalledVersion,
	resolveDefaultExtensionsDir,
	type VsixPackageIdentity,
} from "../../scripts-v2/verify-vscode-extension-consumption.ts";

const identity: VsixPackageIdentity = {
	publisher: "oste",
	name: "command-central",
	version: "0.6.0-rc.25",
};

describe("verify-vscode-extension-consumption helpers", () => {
	test("builds the VS Code extension id from VSIX identity", () => {
		expect(extensionId(identity)).toBe("oste.command-central");
	});

	test("parses the exact installed version reported by code", () => {
		expect(
			parseInstalledVersion(
				[
					"other.publisher@1.0.0",
					"OSTE.COMMAND-CENTRAL@0.6.0-rc.25",
					"oste.command-central-extra@9.9.9",
				].join("\n"),
				"oste.command-central",
			),
		).toBe("0.6.0-rc.25");
	});

	test("returns null when code does not report the extension", () => {
		expect(
			parseInstalledVersion(
				"oste.command-central-extra@9.9.9",
				"oste.command-central",
			),
		).toBeNull();
	});

	test("builds the normal installed package path for a concrete VSIX version", () => {
		expect(buildInstalledPackagePath("/tmp/extensions", identity)).toBe(
			path.join(
				"/tmp/extensions",
				"oste.command-central-0.6.0-rc.25",
				"package.json",
			),
		);
	});

	test("parses CLI args with explicit consumption profile paths", () => {
		expect(
			parseArgs([
				"--vsix",
				"releases/command-central-0.6.0-rc.25.vsix",
				"--expected-version=0.6.0-rc.25",
				"--code-bin",
				"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
				"--extensions-dir",
				"/Users/ostehost/.vscode/extensions",
				"--manifest-out",
				"logs/consumption.json",
			]),
		).toEqual({
			vsixPath: path.resolve("releases/command-central-0.6.0-rc.25.vsix"),
			expectedVersion: "0.6.0-rc.25",
			codeBin:
				"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
			extensionsDir: "/Users/ostehost/.vscode/extensions",
			manifestOut: path.resolve("logs/consumption.json"),
		});
	});

	test("defaults to a user VS Code extension profile", () => {
		expect(resolveDefaultExtensionsDir()).toEndWith(
			path.join(".vscode", "extensions"),
		);
		expect(resolveDefaultExtensionsDir()).not.toContain(
			path.join(".openclaw", "agents", "main", "agent", "codex-home", "home"),
		);
	});
});
