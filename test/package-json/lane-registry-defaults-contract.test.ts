/**
 * Lane registry defaults + legacy deprecation contract.
 *
 * Locks the zero-config Agent Status source contract in the extension
 * manifest:
 *   - `commandCentral.laneRegistry.files` defaults to the transitional
 *     OpenClaw-namespace Work System bridge file plus the deprecated
 *     ghostty-launcher compat path, in that order, and matches the
 *     code-side DEFAULT_LANE_REGISTRY_FILES fallback exactly. Both are
 *     file bridges (OpenClaw has no native lane projection yet) — the
 *     description must say so rather than blessing a final identity path;
 *   - `commandCentral.legacyLauncherTasks.enabled` stays default `false` and
 *     is marked deprecated (diagnostics-only escape hatch);
 *   - the legacy `agentTasksFile(s)` inputs are marked deprecated and point
 *     operators at the lane registry setting.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_LANE_REGISTRY_FILES } from "../../src/utils/tasks-file-resolver.js";

type ConfigProperty = {
	type?: string;
	default?: unknown;
	markdownDescription?: string;
	markdownDeprecationMessage?: string;
	deprecationMessage?: string;
	scope?: string;
};

async function getConfigProperties(): Promise<Record<string, ConfigProperty>> {
	const raw = await Bun.file(
		new URL("../../package.json", import.meta.url),
	).text();
	const pkg = JSON.parse(raw) as {
		contributes?: {
			configuration?: { properties?: Record<string, ConfigProperty> };
		};
	};
	return pkg.contributes?.configuration?.properties ?? {};
}

function deprecationText(property: ConfigProperty | undefined): string {
	return (
		property?.markdownDeprecationMessage ?? property?.deprecationMessage ?? ""
	);
}

describe("lane registry defaults + legacy deprecation contract", () => {
	test("laneRegistry.files defaults to the transitional bridge plus the deprecated launcher compat path", async () => {
		const properties = await getConfigProperties();
		const setting = properties["commandCentral.laneRegistry.files"];

		expect(setting?.default).toEqual([
			"~/.config/openclaw/lanes.json",
			"~/.config/ghostty-launcher/tasks.json",
		]);
		// The OpenClaw-namespace bridge leads; the launcher-branded path is
		// compat-only and must never become the first (identity) entry.
		expect((setting?.default as string[])[0]).toContain("openclaw");
		expect(setting?.markdownDescription).toMatch(/project_ref/);
		expect(setting?.markdownDescription).toMatch(/deprecated/i);
		// File defaults are a bridge, not the blessed end state — the native
		// OpenClaw projection remains the long-term target.
		expect(setting?.markdownDescription).toMatch(/transitional/i);
		expect(setting?.markdownDescription).toMatch(/OpenClaw-native/);
		expect(setting?.scope).toBe("machine");
	});

	test("manifest default matches the code-side DEFAULT_LANE_REGISTRY_FILES fallback", async () => {
		const properties = await getConfigProperties();
		const setting = properties["commandCentral.laneRegistry.files"];

		expect(setting?.default).toEqual([...DEFAULT_LANE_REGISTRY_FILES]);
	});

	test("legacyLauncherTasks.enabled stays default false and is marked deprecated", async () => {
		const properties = await getConfigProperties();
		const setting = properties["commandCentral.legacyLauncherTasks.enabled"];

		expect(setting?.default).toBe(false);
		expect(deprecationText(setting)).toMatch(/deprecated/i);
		expect(deprecationText(setting)).toContain(
			"commandCentral.laneRegistry.files",
		);
	});

	test("legacy agentTasksFile inputs are marked deprecated and point at the lane registry", async () => {
		const properties = await getConfigProperties();
		for (const key of [
			"commandCentral.agentTasksFile",
			"commandCentral.agentTasksFiles",
		]) {
			const setting = properties[key];
			expect(deprecationText(setting)).toMatch(/deprecated/i);
			expect(deprecationText(setting)).toContain(
				"commandCentral.laneRegistry.files",
			);
		}
	});
});
