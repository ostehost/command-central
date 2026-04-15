/**
 * Tests for tasks-file-resolver utility.
 * Verifies: explicit config path, ~ expansion, global auto-detect priority, null when missing.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";

// Mock vscode
mock.module("vscode", () => ({}));

// Mock fs.existsSync — control which paths "exist"
const mockExistsSync = mock((..._args: unknown[]) => false);
mock.module("node:fs", () => ({
	...realFs,
	existsSync: mockExistsSync,
	// Preserve other fs exports the module may reference
	default: { ...realFs, existsSync: mockExistsSync },
}));

import { resolveTasksFilePath } from "../../src/utils/tasks-file-resolver.js";

function mockWorkspaceFolder(fsPath: string) {
	return {
		uri: { fsPath },
		name: path.basename(fsPath),
		index: 0,
	} as unknown as vscode.WorkspaceFolder;
}

describe("resolveTasksFilePath", () => {
	beforeEach(() => {
		mockExistsSync.mockReset();
		mockExistsSync.mockReturnValue(false);
	});

	test("returns expanded path when config value is set", () => {
		const result = resolveTasksFilePath("/custom/path/tasks.json");
		expect(result).toBe("/custom/path/tasks.json");
	});

	test("expands ~ in configured path", () => {
		const result = resolveTasksFilePath("~/my-launcher/tasks.json");
		const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
		expect(result).toBe(path.join(home, "my-launcher/tasks.json"));
	});

	test("returns null when config empty and no files exist", () => {
		const result = resolveTasksFilePath("");
		expect(result).toBeNull();
	});

	test("returns null when config is whitespace", () => {
		const result = resolveTasksFilePath("  ");
		expect(result).toBeNull();
	});

	test("auto-detects XDG config path", () => {
		const xdgPath = path.join(
			os.homedir(),
			".config",
			"ghostty-launcher",
			"tasks.json",
		);
		mockExistsSync.mockImplementation((p: unknown) => p === xdgPath);

		const result = resolveTasksFilePath("");
		expect(result).toBe(xdgPath);
	});

	test("auto-detects home dir path", () => {
		const homePath = path.join(os.homedir(), ".ghostty-launcher", "tasks.json");
		mockExistsSync.mockImplementation((p: unknown) => p === homePath);

		const result = resolveTasksFilePath("");
		expect(result).toBe(homePath);
	});

	test("never returns a workspace-local path when a global path exists", () => {
		const wsPath = "/Users/test/my-project";
		const wsLocalPath = path.join(wsPath, ".ghostty-launcher", "tasks.json");
		const xdgPath = path.join(
			os.homedir(),
			".config",
			"ghostty-launcher",
			"tasks.json",
		);
		mockExistsSync.mockImplementation(
			(p: unknown) => p === wsLocalPath || p === xdgPath,
		);

		const result = resolveTasksFilePath("", [mockWorkspaceFolder(wsPath)]);
		expect(result).toBe(xdgPath);
		expect(result).not.toBe(wsLocalPath);
	});

	test("configured path takes precedence over auto-detect", () => {
		const xdgPath = path.join(
			os.homedir(),
			".config",
			"ghostty-launcher",
			"tasks.json",
		);
		mockExistsSync.mockImplementation((p: unknown) => p === xdgPath);

		const result = resolveTasksFilePath("/explicit/tasks.json");
		expect(result).toBe("/explicit/tasks.json");
	});

	test("returns null with empty workspace folders and no home files", () => {
		const result = resolveTasksFilePath("", []);
		expect(result).toBeNull();
	});
});
