import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildInstalledPackagePath,
	compareExtensionVersions,
	extensionId,
	findSiblingExtensions,
	parseArgs,
	parseExtensionVersion,
	parseInstalledVersion,
	receiptFileName,
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

describe("receiptFileName (CCREL-05 per-RC per-node proof)", () => {
	test("includes the node label so hub and node receipts do not collide", () => {
		expect(receiptFileName("0.6.0-rc.71", "hub")).toBe(
			"vscode-consumption-0.6.0-rc.71-hub.json",
		);
		expect(receiptFileName("0.6.0-rc.71", "node")).toBe(
			"vscode-consumption-0.6.0-rc.71-node.json",
		);
	});

	test("omits the suffix when no label is given", () => {
		expect(receiptFileName("0.6.0-rc.71")).toBe(
			"vscode-consumption-0.6.0-rc.71.json",
		);
	});

	test("sanitizes unsafe label characters", () => {
		expect(receiptFileName("0.6.0-rc.71", "Mike MacBook/Pro")).toBe(
			"vscode-consumption-0.6.0-rc.71-Mike-MacBook-Pro.json",
		);
	});
});

describe("parseExtensionVersion", () => {
	test("parses a release and a prerelease triple", () => {
		expect(parseExtensionVersion("1.2.3")).toEqual({
			major: 1,
			minor: 2,
			patch: 3,
			prerelease: null,
		});
		expect(parseExtensionVersion("0.6.0-rc.71")).toEqual({
			major: 0,
			minor: 6,
			patch: 0,
			prerelease: "rc.71",
		});
	});

	test("rejects strings that are not a bare version", () => {
		expect(parseExtensionVersion("extra-1.0.0")).toBeNull();
		expect(parseExtensionVersion("v1.2.3")).toBeNull();
		expect(parseExtensionVersion("1.2")).toBeNull();
		expect(parseExtensionVersion("")).toBeNull();
	});
});

describe("compareExtensionVersions", () => {
	test("orders prereleases numerically, not lexically", () => {
		expect(compareExtensionVersions("0.6.0-rc.9", "0.6.0-rc.10")).toBeLessThan(
			0,
		);
		expect(compareExtensionVersions("0.6.0-rc.71", "0.6.0-rc.72")).toBeLessThan(
			0,
		);
	});

	test("ranks a released version above a prerelease of the same triple", () => {
		expect(compareExtensionVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
		expect(compareExtensionVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
	});

	test("compares major/minor/patch and treats equal versions as 0", () => {
		expect(compareExtensionVersions("0.7.0", "0.6.9")).toBeGreaterThan(0);
		expect(compareExtensionVersions("0.6.0-rc.71", "0.6.0-rc.71")).toBe(0);
	});
});

describe("findSiblingExtensions (read-only stale-install intelligence)", () => {
	let extensionsDir: string;

	beforeEach(() => {
		extensionsDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "cc-consumption-siblings-"),
		);
	});

	afterEach(() => {
		fs.rmSync(extensionsDir, { recursive: true, force: true });
	});

	function makeDir(name: string): void {
		fs.mkdirSync(path.join(extensionsDir, name), { recursive: true });
	}

	test("lists other siblings, flags older ones stale, and never mutates them", () => {
		for (const rc of ["71", "72", "73", "74"]) {
			makeDir(`oste.command-central-0.6.0-rc.${rc}`);
		}
		// A different extension that merely shares the id prefix — must be ignored.
		makeDir("oste.command-central-extra-1.0.0");
		// An unrelated publisher — must be ignored.
		makeDir("other.publisher-1.0.0");
		// A stray file in the profile — must not blow up readdir handling.
		fs.writeFileSync(path.join(extensionsDir, "extensions.json"), "[]", "utf8");

		const siblings = findSiblingExtensions(
			extensionsDir,
			"oste.command-central",
			"0.6.0-rc.74",
		);

		// Verified rc.74 is excluded (it is the install itself, not a sibling);
		// extra/other/file entries are excluded; remainder sorted ascending.
		expect(siblings.map((s) => s.version)).toEqual([
			"0.6.0-rc.71",
			"0.6.0-rc.72",
			"0.6.0-rc.73",
		]);
		expect(siblings.every((s) => s.stale)).toBe(true);
		expect(siblings[0]?.name).toBe("oste.command-central-0.6.0-rc.71");
		expect(siblings[0]?.path).toBe(
			path.join(extensionsDir, "oste.command-central-0.6.0-rc.71"),
		);

		// Read-only guarantee: every sibling directory still exists afterward.
		for (const sibling of siblings) {
			expect(fs.existsSync(sibling.path)).toBe(true);
		}
	});

	test("flags newer siblings as not stale", () => {
		for (const rc of ["71", "72", "73", "74"]) {
			makeDir(`oste.command-central-0.6.0-rc.${rc}`);
		}

		const siblings = findSiblingExtensions(
			extensionsDir,
			"oste.command-central",
			"0.6.0-rc.72",
		);

		const byVersion = Object.fromEntries(
			siblings.map((s) => [s.version, s.stale]),
		);
		expect(byVersion["0.6.0-rc.71"]).toBe(true);
		expect(byVersion["0.6.0-rc.73"]).toBe(false);
		expect(byVersion["0.6.0-rc.74"]).toBe(false);
		// The verified rc.72 is not listed as its own sibling.
		expect(byVersion["0.6.0-rc.72"]).toBeUndefined();
	});

	test("returns an empty list when the extensions dir does not exist", () => {
		expect(
			findSiblingExtensions(
				path.join(extensionsDir, "does-not-exist"),
				"oste.command-central",
				"0.6.0-rc.74",
			),
		).toEqual([]);
	});
});
