/**
 * Tests for tasks-file-resolver utility.
 * Verifies: launcher quarantine by default (no config/workspace/global
 * resolution without the legacy opt-in), the TASKS_FILE hermetic override,
 * and the legacy escape-hatch behaviors (explicit config path, workspace-local
 * precedence, global fallback, null when missing).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof import("node:fs");

import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";

// Mock fs.existsSync — control which paths "exist"
const mockExistsSync = mock((..._args: unknown[]) => false);
mock.module("node:fs", () => ({
	...realFs,
	existsSync: mockExistsSync,
	// Preserve other fs exports the module may reference
	default: { ...realFs, existsSync: mockExistsSync },
}));

import {
	resolveTasksFilePath,
	resolveTasksFilePaths,
} from "../../src/utils/tasks-file-resolver.js";

const LEGACY_ON = { legacyLauncherEnabled: true };

function mockWorkspaceFolder(fsPath: string) {
	return {
		uri: { fsPath },
		name: path.basename(fsPath),
		index: 0,
	} as unknown as vscode.WorkspaceFolder;
}

function xdgTasksPath(): string {
	return path.join(os.homedir(), ".config", "ghostty-launcher", "tasks.json");
}

function legacyTasksPath(): string {
	return path.join(os.homedir(), ".ghostty-launcher", "tasks.json");
}

function workspaceLocalTasksPath(workspacePath: string): string {
	return path.join(workspacePath, ".ghostty-launcher", "tasks.json");
}

describe("resolveTasksFilePath — quarantine by default", () => {
	beforeEach(() => {
		mockExistsSync.mockReset();
		mockExistsSync.mockReturnValue(false);
	});

	test("ignores explicit config path when legacy launcher ingestion is off", () => {
		mockExistsSync.mockReturnValue(true);
		const result = resolveTasksFilePath("/custom/path/tasks.json");
		expect(result).toBeNull();
	});

	test("ignores workspace-local .ghostty-launcher/tasks.json when legacy is off", () => {
		const wsPath = "/Users/test/my-project";
		const wsLocalPath = workspaceLocalTasksPath(wsPath);
		mockExistsSync.mockImplementation((p: unknown) => p === wsLocalPath);

		const result = resolveTasksFilePath("", [mockWorkspaceFolder(wsPath)]);
		expect(result).toBeNull();
	});

	test("ignores global XDG registry when legacy is off", () => {
		const xdgPath = xdgTasksPath();
		mockExistsSync.mockImplementation((p: unknown) => p === xdgPath);

		const result = resolveTasksFilePath("");
		expect(result).toBeNull();
	});

	test("ignores global home-dir registry when legacy is off", () => {
		const homePath = legacyTasksPath();
		mockExistsSync.mockImplementation((p: unknown) => p === homePath);

		const result = resolveTasksFilePath("");
		expect(result).toBeNull();
	});

	test("ignores everything when legacyLauncherEnabled is explicitly false", () => {
		mockExistsSync.mockReturnValue(true);
		const result = resolveTasksFilePath(
			"/custom/path/tasks.json",
			[mockWorkspaceFolder("/Users/test/my-project")],
			{ legacyLauncherEnabled: false },
		);
		expect(result).toBeNull();
	});

	test("TASKS_FILE override is still honored when legacy is off", () => {
		const envPath = "/env/tasks.json";
		mockExistsSync.mockImplementation((p: unknown) => p === envPath);

		const result = resolveTasksFilePath("", undefined, {
			envTasksFile: envPath,
		});

		expect(result).toBe(envPath);
	});

	test("TASKS_FILE pointing at a missing file does not fall back to launcher registries", () => {
		const xdgPath = xdgTasksPath();
		mockExistsSync.mockImplementation((p: unknown) => p === xdgPath);

		const result = resolveTasksFilePath("", undefined, {
			envTasksFile: "/missing/tasks.json",
		});

		expect(result).toBeNull();
	});
});

describe("resolveTasksFilePath — legacy escape hatch enabled", () => {
	beforeEach(() => {
		mockExistsSync.mockReset();
		mockExistsSync.mockReturnValue(false);
	});

	test("returns expanded path when config value is set", () => {
		const result = resolveTasksFilePath(
			"/custom/path/tasks.json",
			undefined,
			LEGACY_ON,
		);
		expect(result).toBe("/custom/path/tasks.json");
	});

	test("env override takes precedence when TASKS_FILE exists", () => {
		const envPath = "/env/tasks.json";
		mockExistsSync.mockImplementation((p: unknown) => p === envPath);

		const result = resolveTasksFilePath("/custom/path/tasks.json", undefined, {
			...LEGACY_ON,
			envTasksFile: envPath,
		});

		expect(result).toBe(envPath);
	});

	test("expands ~ in TASKS_FILE override", () => {
		const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
		const envPath = path.join(home, "fixture", "tasks.json");
		mockExistsSync.mockImplementation((p: unknown) => p === envPath);

		const result = resolveTasksFilePath("", undefined, {
			envTasksFile: "~/fixture/tasks.json",
		});

		expect(result).toBe(envPath);
	});

	test("expands ~ in configured path", () => {
		const result = resolveTasksFilePath(
			"~/my-launcher/tasks.json",
			undefined,
			LEGACY_ON,
		);
		const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
		expect(result).toBe(path.join(home, "my-launcher/tasks.json"));
	});

	test("returns null when config empty and no files exist", () => {
		const result = resolveTasksFilePath("", undefined, LEGACY_ON);
		expect(result).toBeNull();
	});

	test("returns null when config is whitespace", () => {
		const result = resolveTasksFilePath("  ", undefined, LEGACY_ON);
		expect(result).toBeNull();
	});

	test("auto-detects XDG config path", () => {
		const xdgPath = xdgTasksPath();
		mockExistsSync.mockImplementation((p: unknown) => p === xdgPath);

		const result = resolveTasksFilePath("", undefined, LEGACY_ON);
		expect(result).toBe(xdgPath);
	});

	test("auto-detects home dir path", () => {
		const homePath = legacyTasksPath();
		mockExistsSync.mockImplementation((p: unknown) => p === homePath);

		const result = resolveTasksFilePath("", undefined, LEGACY_ON);
		expect(result).toBe(homePath);
	});

	test("workspace-local path wins over XDG path", () => {
		const wsPath = "/Users/test/my-project";
		const wsLocalPath = workspaceLocalTasksPath(wsPath);
		const xdgPath = xdgTasksPath();
		mockExistsSync.mockImplementation(
			(p: unknown) => p === wsLocalPath || p === xdgPath,
		);

		const result = resolveTasksFilePath(
			"",
			[mockWorkspaceFolder(wsPath)],
			LEGACY_ON,
		);
		expect(result).toBe(wsLocalPath);
	});

	test("workspace-local path wins over legacy path", () => {
		const wsPath = "/Users/test/my-project";
		const wsLocalPath = workspaceLocalTasksPath(wsPath);
		const legacyPath = legacyTasksPath();
		mockExistsSync.mockImplementation(
			(p: unknown) => p === wsLocalPath || p === legacyPath,
		);

		const result = resolveTasksFilePath(
			"",
			[mockWorkspaceFolder(wsPath)],
			LEGACY_ON,
		);
		expect(result).toBe(wsLocalPath);
	});

	test("configured path takes precedence over workspace-local auto-detect", () => {
		const wsPath = "/Users/test/my-project";
		const wsLocalPath = workspaceLocalTasksPath(wsPath);
		mockExistsSync.mockImplementation((p: unknown) => p === wsLocalPath);

		const result = resolveTasksFilePath(
			"/explicit/tasks.json",
			[mockWorkspaceFolder(wsPath)],
			LEGACY_ON,
		);
		expect(result).toBe("/explicit/tasks.json");
	});

	test("multi-root prefers the first workspace-local path in folder order", () => {
		const firstWorkspacePath = "/Users/test/alpha";
		const secondWorkspacePath = "/Users/test/beta";
		const firstWorkspaceLocalPath = workspaceLocalTasksPath(firstWorkspacePath);
		const secondWorkspaceLocalPath =
			workspaceLocalTasksPath(secondWorkspacePath);
		mockExistsSync.mockImplementation(
			(p: unknown) =>
				p === firstWorkspaceLocalPath || p === secondWorkspaceLocalPath,
		);

		const result = resolveTasksFilePath(
			"",
			[
				mockWorkspaceFolder(firstWorkspacePath),
				mockWorkspaceFolder(secondWorkspacePath),
			],
			LEGACY_ON,
		);

		expect(result).toBe(firstWorkspaceLocalPath);
	});

	test("multi-root falls through to the next workspace-local path when earlier folders have none", () => {
		const firstWorkspacePath = "/Users/test/alpha";
		const secondWorkspacePath = "/Users/test/beta";
		const secondWorkspaceLocalPath =
			workspaceLocalTasksPath(secondWorkspacePath);
		mockExistsSync.mockImplementation(
			(p: unknown) => p === secondWorkspaceLocalPath,
		);

		const result = resolveTasksFilePath(
			"",
			[
				mockWorkspaceFolder(firstWorkspacePath),
				mockWorkspaceFolder(secondWorkspacePath),
			],
			LEGACY_ON,
		);

		expect(result).toBe(secondWorkspaceLocalPath);
	});

	test("falls through to XDG when no workspace-local path exists", () => {
		const firstWorkspacePath = "/Users/test/alpha";
		const secondWorkspacePath = "/Users/test/beta";
		const xdgPath = xdgTasksPath();
		mockExistsSync.mockImplementation((p: unknown) => p === xdgPath);

		const result = resolveTasksFilePath(
			"",
			[
				mockWorkspaceFolder(firstWorkspacePath),
				mockWorkspaceFolder(secondWorkspacePath),
			],
			LEGACY_ON,
		);

		expect(result).toBe(xdgPath);
	});

	test("falls through to legacy when no workspace-local or XDG path exists", () => {
		const workspacePath = "/Users/test/my-project";
		const legacyPath = legacyTasksPath();
		mockExistsSync.mockImplementation((p: unknown) => p === legacyPath);

		const result = resolveTasksFilePath(
			"",
			[mockWorkspaceFolder(workspacePath)],
			LEGACY_ON,
		);
		expect(result).toBe(legacyPath);
	});

	test("returns null with empty workspace folders and no home files", () => {
		const result = resolveTasksFilePath("", [], LEGACY_ON);
		expect(result).toBeNull();
	});
});

describe("resolveTasksFilePaths", () => {
	beforeEach(() => {
		mockExistsSync.mockReset();
		mockExistsSync.mockReturnValue(false);
	});

	test("returns empty list by default even with primary and additional paths configured", () => {
		const result = resolveTasksFilePaths("/primary/tasks.json", [
			"/mirror/node/tasks.json",
			"/mirror/other/tasks.json",
		]);

		expect(result).toEqual([]);
	});

	test("TASKS_FILE override is the only path returned when legacy is off", () => {
		const envPath = "/env/tasks.json";
		mockExistsSync.mockImplementation((p: unknown) => p === envPath);

		const result = resolveTasksFilePaths(
			"/primary/tasks.json",
			["/mirror/node/tasks.json"],
			undefined,
			{ envTasksFile: envPath },
		);

		expect(result).toEqual([envPath]);
	});

	test("returns primary path plus explicit additional registry paths when legacy is on", () => {
		const result = resolveTasksFilePaths(
			"/primary/tasks.json",
			["/mirror/node/tasks.json", "/mirror/other/tasks.json"],
			undefined,
			LEGACY_ON,
		);

		expect(result).toEqual([
			"/primary/tasks.json",
			"/mirror/node/tasks.json",
			"/mirror/other/tasks.json",
		]);
	});

	test("deduplicates primary and additional paths", () => {
		const result = resolveTasksFilePaths(
			"/primary/tasks.json",
			["/primary/tasks.json", "  ", "/primary/tasks.json"],
			undefined,
			LEGACY_ON,
		);

		expect(result).toEqual(["/primary/tasks.json"]);
	});

	test("keeps auto-detected primary behavior and appends node mirrors when legacy is on", () => {
		const xdgPath = xdgTasksPath();
		mockExistsSync.mockImplementation((p: unknown) => p === xdgPath);

		const result = resolveTasksFilePaths(
			"",
			["/mirror/node/tasks.json"],
			undefined,
			LEGACY_ON,
		);

		expect(result).toEqual([xdgPath, "/mirror/node/tasks.json"]);
	});
});
