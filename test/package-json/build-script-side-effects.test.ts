import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Regression coverage for CP-42 / PAR-78.
 *
 * `bun run build` used to be byte-identical to `bun run dist`, so a plain build
 * ran the full distribution workflow: installing the VSIX into local VS Code
 * and pruning releases/. The build script must instead be side-effect-free.
 */

type PackageJsonShape = {
	scripts?: Record<string, string>;
};

const repoRoot = path.resolve(import.meta.dir, "../..");
const packageJsonPath = path.join(repoRoot, "package.json");
const distScriptPath = path.join(repoRoot, "scripts-v2", "dist-simple.ts");

function readScripts(): Record<string, string> {
	const pkg = JSON.parse(
		fs.readFileSync(packageJsonPath, "utf8"),
	) as PackageJsonShape;
	return pkg.scripts ?? {};
}

function readDistScriptSource(): string {
	return fs.readFileSync(distScriptPath, "utf8");
}

describe("build script side effects (CP-42 / PAR-78)", () => {
	test("build script is not byte-identical to dist script", () => {
		const scripts = readScripts();
		expect(scripts["build"]).toBeDefined();
		expect(scripts["dist"]).toBeDefined();
		expect(scripts["build"]).not.toBe(scripts["dist"]);
	});

	test("build script invokes the distribution script in build-only mode", () => {
		const build = readScripts()["build"] ?? "";
		expect(build).toMatch(/dist-simple\.ts/);
		expect(/--build-only\b|--no-release\b/.test(build)).toBe(true);
	});

	test("dist script recognises a build-only flag", () => {
		const source = readDistScriptSource();
		expect(source).toMatch(/buildOnly\s*:\s*args\.includes\(/);
		expect(source).toMatch(/--build-only/);
	});

	test("VS Code install is suppressed in build-only mode", () => {
		const source = readDistScriptSource();
		// The install call must be gated on the build-only flag, not just
		// on --no-install.
		expect(source).toMatch(
			/if\s*\(\s*!flags\.noInstall\s*&&\s*!flags\.buildOnly\s*\)/,
		);
	});

	test("release move and prune do not run in build-only mode", () => {
		const source = readDistScriptSource();
		const renameIndex = source.indexOf("fs.rename(prodVsixName");
		const cleanupIndex = source.indexOf("cleanupOldReleases(maxReleases)");
		expect(renameIndex).toBeGreaterThanOrEqual(0);
		expect(cleanupIndex).toBeGreaterThanOrEqual(0);

		// Both the release move and the prune must sit inside the `else` of a
		// build-only guard so a plain build cannot mutate releases/.
		const guardIndex = source.lastIndexOf("if (flags.buildOnly)", renameIndex);
		expect(guardIndex).toBeGreaterThanOrEqual(0);
		const elseIndex = source.indexOf("} else {", guardIndex);
		expect(elseIndex).toBeGreaterThanOrEqual(0);
		expect(elseIndex).toBeLessThan(renameIndex);
		expect(elseIndex).toBeLessThan(cleanupIndex);
	});
});
