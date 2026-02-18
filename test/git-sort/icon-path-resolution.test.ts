import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LoggerService } from "../../src/services/logger-service.js";
import { createMockLogger } from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// Type helper for testing private methods
interface ProviderWithIconMethod {
	getGitStatusIcon: (type: string) => {
		light: { path: string; scheme: string; toString: () => string };
		dark: { path: string; scheme: string; toString: () => string };
	};
}

describe("Icon Path Resolution", () => {
	let mockLogger: LoggerService;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
		mockLogger = createMockLogger();
	});

	test("should return object with light and dark properties", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = {
			extensionUri: vscode.Uri.file("/mock/extension/path"),
		} as unknown as import("vscode").ExtensionContext;

		const provider = new SortedGitChangesProvider(mockLogger, mockContext);
		const iconPath = (
			provider as unknown as ProviderWithIconMethod
		).getGitStatusIcon("staged");

		expect(iconPath).toBeDefined();
		expect(iconPath).toHaveProperty("light");
		expect(iconPath).toHaveProperty("dark");
	});

	test("should return correct light theme path for staged icons", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = {
			extensionUri: vscode.Uri.file("/mock/extension/path"),
		} as unknown as import("vscode").ExtensionContext;

		const provider = new SortedGitChangesProvider(mockLogger, mockContext);
		const iconPath = (
			provider as unknown as ProviderWithIconMethod
		).getGitStatusIcon("staged");

		expect(iconPath.light).toBeDefined();
		expect(iconPath.light.path).toContain(
			"resources/icons/git-status/light/staged.svg",
		);
	});

	test("should return correct dark theme path for staged icons", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = {
			extensionUri: vscode.Uri.file("/mock/extension/path"),
		} as unknown as import("vscode").ExtensionContext;

		const provider = new SortedGitChangesProvider(mockLogger, mockContext);
		const iconPath = (
			provider as unknown as ProviderWithIconMethod
		).getGitStatusIcon("staged");

		expect(iconPath.dark).toBeDefined();
		expect(iconPath.dark.path).toContain(
			"resources/icons/git-status/dark/staged.svg",
		);
	});

	test("should return correct light theme path for working icons", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = {
			extensionUri: vscode.Uri.file("/mock/extension/path"),
		} as unknown as import("vscode").ExtensionContext;

		const provider = new SortedGitChangesProvider(mockLogger, mockContext);
		const iconPath = (
			provider as unknown as ProviderWithIconMethod
		).getGitStatusIcon("working");

		expect(iconPath.light).toBeDefined();
		expect(iconPath.light.path).toContain(
			"resources/icons/git-status/light/working.svg",
		);
	});

	test("should return correct dark theme path for working icons", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = {
			extensionUri: vscode.Uri.file("/mock/extension/path"),
		} as unknown as import("vscode").ExtensionContext;

		const provider = new SortedGitChangesProvider(mockLogger, mockContext);
		const iconPath = (
			provider as unknown as ProviderWithIconMethod
		).getGitStatusIcon("working");

		expect(iconPath.dark).toBeDefined();
		expect(iconPath.dark.path).toContain(
			"resources/icons/git-status/dark/working.svg",
		);
	});

	test("should handle extension context URI correctly", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = {
			extensionUri: vscode.Uri.file("/mock/extension/path"),
		} as unknown as import("vscode").ExtensionContext;

		const provider = new SortedGitChangesProvider(mockLogger, mockContext);
		const iconPath = (
			provider as unknown as ProviderWithIconMethod
		).getGitStatusIcon("staged");

		// Paths should start with the mock extension URI
		expect(iconPath.light.toString()).toContain("mock/extension/path");
		expect(iconPath.dark.toString()).toContain("mock/extension/path");
	});

	test("should construct valid file paths using Uri.joinPath", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		const mockContext = {
			extensionUri: vscode.Uri.file("/mock/extension/path"),
		} as unknown as import("vscode").ExtensionContext;

		const provider = new SortedGitChangesProvider(mockLogger, mockContext);
		const iconPath = (
			provider as unknown as ProviderWithIconMethod
		).getGitStatusIcon("working");

		// Verify paths are properly constructed URIs
		expect(iconPath.light.scheme).toBeDefined();
		expect(iconPath.dark.scheme).toBeDefined();

		// Verify path structure
		expect(iconPath.light.path).toMatch(
			/resources\/icons\/git-status\/light\/working\.svg$/,
		);
		expect(iconPath.dark.path).toMatch(
			/resources\/icons\/git-status\/dark\/working\.svg$/,
		);
	});
});
