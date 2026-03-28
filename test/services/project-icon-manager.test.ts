import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Ensure this file uses real fs even if other tests mock node:fs.
const realFs = require("node:fs");
mock.module("node:fs", () => realFs);

const { ProjectIconManager } = await import(
	"../../src/services/project-icon-manager.js"
);

describe("ProjectIconManager", () => {
	let tmpDir: string;

	beforeEach(() => {
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

	test("auto-generates deterministic icon and persists it to settings", async () => {
		const projectDir = path.join(tmpDir, "deterministic-app");
		fs.mkdirSync(projectDir, { recursive: true });

		const manager = new ProjectIconManager();
		const first = manager.getIconForProject(projectDir);
		const second = manager.getIconForProject(projectDir);

		expect(first).toBe(second);

		// Auto-write is async best effort.
		await new Promise((resolve) => setTimeout(resolve, 25));

		const settingsPath = path.join(projectDir, ".vscode", "settings.json");
		expect(fs.existsSync(settingsPath)).toBe(true);

		const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<
			string,
			unknown
		>;
		expect(parsed["commandCentral.project.icon"]).toBe(first);
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

	test("ensureProjectIconPersisted writes deterministic fallback immediately", async () => {
		const projectDir = path.join(tmpDir, "first-launch-app");
		fs.mkdirSync(projectDir, { recursive: true });
		const settingsPath = path.join(projectDir, ".vscode", "settings.json");

		const manager = new ProjectIconManager();
		const icon = await manager.ensureProjectIconPersisted(projectDir);

		expect(fs.existsSync(settingsPath)).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<
			string,
			unknown
		>;
		expect(parsed["commandCentral.project.icon"]).toBe(icon);
	});

	test("ensureProjectIconPersisted respects configured icon without rewriting", async () => {
		const projectDir = path.join(tmpDir, "configured-icon-app");
		const vscodeDir = path.join(projectDir, ".vscode");
		const settingsPath = path.join(vscodeDir, "settings.json");
		fs.mkdirSync(vscodeDir, { recursive: true });
		const raw =
			'{\n\t"commandCentral.project.icon": "🧭",\n\t"editor.tabSize": 2\n}\n';
		fs.writeFileSync(settingsPath, raw, "utf-8");

		const manager = new ProjectIconManager();
		const icon = await manager.ensureProjectIconPersisted(projectDir);

		expect(icon).toBe("🧭");
		expect(fs.readFileSync(settingsPath, "utf-8")).toBe(raw);
	});

	test("ensureProjectIconPersisted does not clobber malformed settings", async () => {
		const projectDir = path.join(tmpDir, "malformed-settings-app");
		const vscodeDir = path.join(projectDir, ".vscode");
		const settingsPath = path.join(vscodeDir, "settings.json");
		fs.mkdirSync(vscodeDir, { recursive: true });
		const malformed = '{\n  "editor.tabSize": 2,\n';
		fs.writeFileSync(settingsPath, malformed, "utf-8");

		const manager = new ProjectIconManager();
		await manager.ensureProjectIconPersisted(projectDir);

		expect(fs.readFileSync(settingsPath, "utf-8")).toBe(malformed);
	});
});
