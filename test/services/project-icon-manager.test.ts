import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type * as _fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Ensure this file uses real fs even if other tests mock node:fs.
// Use the cached reference saved by the preload (global-test-cleanup.ts)
// because require("node:fs") would return the already-mocked version.
// We use realFs directly (not the `import * as fs` binding) because
// the import is already resolved to the mocked version at module load time.
const fs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof _fs;
mock.module("node:fs", () => fs);

const { ProjectIconManager } = await import(
	"../../src/services/project-icon-manager.js"
);

describe("ProjectIconManager", () => {
	let tmpDir: string;

	beforeEach(() => {
		// Re-register real node:fs after global afterEach's mock.restore() clears it
		mock.module("node:fs", () => fs);
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-icon-manager-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("reads explicit commandCentral.project.icon from settings", () => {
		const projectDir = path.join(tmpDir, "alpha-project");
		const vscodeDir = path.join(projectDir, ".vscode");
		fs.mkdirSync(vscodeDir, { recursive: true });
		fs.writeFileSync(
			path.join(vscodeDir, "settings.json"),
			`${JSON.stringify(
				{
					"commandCentral.project.icon": "🚀",
					"editor.tabSize": 2,
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);

		const manager = new ProjectIconManager();
		expect(manager.getIconForProject(projectDir)).toBe("🚀");
	});

	test("deterministic icon is stable but is NEVER written to settings", async () => {
		const projectDir = path.join(tmpDir, "deterministic-app");
		fs.mkdirSync(projectDir, { recursive: true });

		const manager = new ProjectIconManager();
		const first = manager.getIconForProject(projectDir);
		const second = manager.getIconForProject(projectDir);

		// Stable across calls so the tree does not flicker...
		expect(first).toBe(second);

		// ...but display-only. Persisting it is what stamped hash-picked emoji
		// into repositories this extension does not own, overwriting the icon
		// curated in Linear. A read must not mutate another project.
		const settingsPath = path.join(projectDir, ".vscode", "settings.json");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fs.existsSync(settingsPath)).toBe(false);
		expect(fs.existsSync(path.join(projectDir, ".vscode"))).toBe(false);
	});

	test("registry icon wins over the settings key", () => {
		const projectDir = path.join(tmpDir, "registry-app");
		const vscodeDir = path.join(projectDir, ".vscode");
		fs.mkdirSync(vscodeDir, { recursive: true });
		fs.writeFileSync(
			path.join(vscodeDir, "settings.json"),
			`${JSON.stringify({ "commandCentral.project.icon": "🧠" }, null, 2)}\n`,
			"utf-8",
		);

		const registryPath = path.join(tmpDir, "work-registry.json");
		fs.writeFileSync(
			registryPath,
			JSON.stringify({
				kind: "work-registry",
				projects: [
					{ id: "registry-app", icon: "🦀", paths: { node: projectDir } },
				],
			}),
			"utf-8",
		);

		const previous = process.env["PROJECTS_WORK_REGISTRY"];
		process.env["PROJECTS_WORK_REGISTRY"] = registryPath;
		try {
			const manager = new ProjectIconManager();
			// Linear (via the registry) is the authoring surface; the settings key
			// is only the fallback for projects the registry does not list.
			expect(manager.getIconForProject(projectDir)).toBe("🦀");
		} finally {
			if (previous === undefined) {
				delete process.env["PROJECTS_WORK_REGISTRY"];
			} else {
				process.env["PROJECTS_WORK_REGISTRY"] = previous;
			}
		}
	});

	test("settings key is used when the registry does not list the project", () => {
		const projectDir = path.join(tmpDir, "unlisted-app");
		const vscodeDir = path.join(projectDir, ".vscode");
		fs.mkdirSync(vscodeDir, { recursive: true });
		fs.writeFileSync(
			path.join(vscodeDir, "settings.json"),
			`${JSON.stringify({ "commandCentral.project.icon": "🧭" }, null, 2)}\n`,
			"utf-8",
		);

		const registryPath = path.join(tmpDir, "empty-registry.json");
		fs.writeFileSync(
			registryPath,
			JSON.stringify({ kind: "work-registry", projects: [] }),
			"utf-8",
		);

		const previous = process.env["PROJECTS_WORK_REGISTRY"];
		process.env["PROJECTS_WORK_REGISTRY"] = registryPath;
		try {
			const manager = new ProjectIconManager();
			expect(manager.getIconForProject(projectDir)).toBe("🧭");
		} finally {
			if (previous === undefined) {
				delete process.env["PROJECTS_WORK_REGISTRY"];
			} else {
				process.env["PROJECTS_WORK_REGISTRY"] = previous;
			}
		}
	});

	test("setCustomIcon preserves existing settings keys and indentation style", async () => {
		const projectDir = path.join(tmpDir, "custom-icon-app");
		const vscodeDir = path.join(projectDir, ".vscode");
		const settingsPath = path.join(vscodeDir, "settings.json");

		fs.mkdirSync(vscodeDir, { recursive: true });
		fs.writeFileSync(
			settingsPath,
			`{\n    "editor.tabSize": 4,\n    "files.eol": "\\n"\n}\n`,
			"utf-8",
		);

		const manager = new ProjectIconManager();
		await manager.setCustomIcon(projectDir, "🧪");

		const raw = fs.readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		expect(parsed["editor.tabSize"]).toBe(4);
		expect(parsed["files.eol"]).toBe("\n");
		expect(parsed["commandCentral.project.icon"]).toBe("🧪");
		expect(raw).toContain('\n    "commandCentral.project.icon":');
		expect(manager.getIconForProject(projectDir)).toBe("🧪");
	});

	test("setCustomIcon creates .vscode/settings.json when missing", async () => {
		const projectDir = path.join(tmpDir, "missing-settings-app");
		fs.mkdirSync(projectDir, { recursive: true });

		const manager = new ProjectIconManager();
		await manager.setCustomIcon(projectDir, "AI");

		const settingsPath = path.join(projectDir, ".vscode", "settings.json");
		const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<
			string,
			unknown
		>;
		expect(parsed["commandCentral.project.icon"]).toBe("AI");
	});

	test("resolveProjectIcon returns a fallback without creating settings", async () => {
		const projectDir = path.join(tmpDir, "first-launch-app");
		fs.mkdirSync(projectDir, { recursive: true });
		const settingsPath = path.join(projectDir, ".vscode", "settings.json");

		const manager = new ProjectIconManager();
		const icon = await manager.resolveProjectIcon(projectDir);

		expect(icon.length).toBeGreaterThan(0);
		// The launcher reads the work registry directly, so there is nothing to
		// materialize here — and materializing it meant writing into a repo we
		// do not own.
		expect(fs.existsSync(settingsPath)).toBe(false);
	});

	test("resolveProjectIcon respects configured icon without rewriting", async () => {
		const projectDir = path.join(tmpDir, "configured-icon-app");
		const vscodeDir = path.join(projectDir, ".vscode");
		const settingsPath = path.join(vscodeDir, "settings.json");
		fs.mkdirSync(vscodeDir, { recursive: true });
		const raw =
			'{\n\t"commandCentral.project.icon": "🧭",\n\t"editor.tabSize": 2\n}\n';
		fs.writeFileSync(settingsPath, raw, "utf-8");

		const manager = new ProjectIconManager();
		const icon = await manager.resolveProjectIcon(projectDir);

		expect(icon).toBe("🧭");
		expect(fs.readFileSync(settingsPath, "utf-8")).toBe(raw);
	});

	test("resolveProjectIcon does not clobber malformed settings", async () => {
		const projectDir = path.join(tmpDir, "malformed-settings-app");
		const vscodeDir = path.join(projectDir, ".vscode");
		const settingsPath = path.join(vscodeDir, "settings.json");
		fs.mkdirSync(vscodeDir, { recursive: true });
		const malformed = '{\n  "editor.tabSize": 2,\n';
		fs.writeFileSync(settingsPath, malformed, "utf-8");

		const manager = new ProjectIconManager();
		await manager.resolveProjectIcon(projectDir);

		expect(fs.readFileSync(settingsPath, "utf-8")).toBe(malformed);
	});
});
