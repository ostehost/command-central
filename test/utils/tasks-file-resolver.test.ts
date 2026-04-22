/**
 * Tests for tasks-file-resolver utility.
 * Verifies: explicit config path, workspace-local precedence, global fallback,
 * and null when missing.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof import("node:fs");

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

function xdgTasksPath(): string {
	return path.join(os.homedir(), ".config", "ghostty-launcher", "tasks.json");
}

function legacyTasksPath(): string {
	return path.join(os.homedir(), ".ghostty-launcher", "tasks.json");
}

function workspaceLocalTasksPath(workspacePath: string): string {
	return path.join(workspacePath, ".ghostty-launcher", "tasks.json");
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
		const xdgPath = xdgTasksPath();
		mockExistsSync.mockImplementation((p: unknown) => p === xdgPath);

		const result = resolveTasksFilePath("");
		expect(result).toBe(xdgPath);
	});

	test("auto-detects home dir path", () => {
		const homePath = legacyTasksPath();
		mockExistsSync.mockImplementation((p: unknown) => p === homePath);

		const result = resolveTasksFilePath("");
		expect(result).toBe(homePath);
	});

	test("workspace-local path wins over XDG path", () => {
		const wsPath = "/Users/test/my-project";
		const wsLocalPath = workspaceLocalTasksPath(wsPath);
		const xdgPath = xdgTasksPath();
		mockExistsSync.mockImplementation(
			(p: unknown) => p === wsLocalPath || p === xdgPath,
		);

		const result = resolveTasksFilePath("", [mockWorkspaceFolder(wsPath)]);
		expect(result).toBe(wsLocalPath);
	});

	test("workspace-local path wins over legacy path", () => {
		const wsPath = "/Users/test/my-project";
		const wsLocalPath = workspaceLocalTasksPath(wsPath);
		const legacyPath = legacyTasksPath();
		mockExistsSync.mockImplementation(
			(p: unknown) => p === wsLocalPath || p === legacyPath,
		);

		const result = resolveTasksFilePath("", [mockWorkspaceFolder(wsPath)]);
		expect(result).toBe(wsLocalPath);
	});

	test("configured path takes precedence over workspace-local auto-detect", () => {
		const wsPath = "/Users/test/my-project";
		const wsLocalPath = workspaceLocalTasksPath(wsPath);
		mockExistsSync.mockImplementation((p: unknown) => p === wsLocalPath);

		const result = resolveTasksFilePath("/explicit/tasks.json", [
			mockWorkspaceFolder(wsPath),
		]);
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

		const result = resolveTasksFilePath("", [
			mockWorkspaceFolder(firstWorkspacePath),
			mockWorkspaceFolder(secondWorkspacePath),
		]);

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

		const result = resolveTasksFilePath("", [
			mockWorkspaceFolder(firstWorkspacePath),
			mockWorkspaceFolder(secondWorkspacePath),
		]);

		expect(result).toBe(secondWorkspaceLocalPath);
	});

	test("falls through to XDG when no workspace-local path exists", () => {
		const firstWorkspacePath = "/Users/test/alpha";
		const secondWorkspacePath = "/Users/test/beta";
		const xdgPath = xdgTasksPath();
		mockExistsSync.mockImplementation((p: unknown) => p === xdgPath);

		const result = resolveTasksFilePath("", [
			mockWorkspaceFolder(firstWorkspacePath),
			mockWorkspaceFolder(secondWorkspacePath),
		]);

		expect(result).toBe(xdgPath);
	});

	test("falls through to legacy when no workspace-local or XDG path exists", () => {
		const workspacePath = "/Users/test/my-project";
		const legacyPath = legacyTasksPath();
		mockExistsSync.mockImplementation((p: unknown) => p === legacyPath);

		const result = resolveTasksFilePath("", [
			mockWorkspaceFolder(workspacePath),
		]);

		expect(result).toBe(legacyPath);
	});

	test("returns null with empty workspace folders and no home files", () => {
		const result = resolveTasksFilePath("", []);
		expect(result).toBeNull();
	});
});
