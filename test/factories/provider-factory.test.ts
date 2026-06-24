/**
 * ProjectProviderFactory.getProviderForFile — cross-platform path containment
 *
 * Regression coverage for CP-16 / PAR-57: on Windows, `Uri.fsPath` uses
 * backslash separators (C:\repo\src\file.ts), but the workspace-containment
 * check hard-coded a `/` separator. Nested workspace files therefore never
 * matched their provider, and gitSort openChange/openDiff reported
 * "No workspace found for this file".
 *
 * These tests construct backslash fsPaths directly (the vscode mock stores
 * fsPath verbatim, so this exercises the Windows shape on any host OS) and
 * assert correct longest-match containment while preserving POSIX behavior.
 */

import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ProjectViewConfig } from "../../src/config/project-views.js";
import type { LoggerService } from "../../src/services/logger-service.js";
import {
	createMockExtensionContext,
	createMockLogger,
} from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

function makeConfig(id: string, gitPath: string): ProjectViewConfig {
	return {
		id,
		displayName: id,
		iconPath: "resources/icon.svg",
		gitPath,
	};
}

describe("ProjectProviderFactory.getProviderForFile", () => {
	let logger: LoggerService;

	beforeEach(() => {
		logger = createMockLogger();
		mock.restore();
		setupVSCodeMock();
	});

	test("matches nested Windows backslash fsPaths to their workspace provider", async () => {
		const { ProjectProviderFactory } = await import(
			"../../src/factories/provider-factory.js"
		);
		const vscode = await import("vscode");

		const factory = new ProjectProviderFactory(
			logger,
			createMockExtensionContext({ globalStoragePath: "/tmp/test" }),
		);

		const repo = await factory.createProvider(makeConfig("repo", "C:\\repo"));

		// Nested file inside the workspace, Windows-style fsPath.
		const nested = vscode.Uri.file("C:\\repo\\src\\file.ts");

		// On the buggy code this returns undefined because the containment
		// check compares "C:\\repo\\src\\file.ts" against "C:\\repo/".
		expect(factory.getProviderForFile(nested)).toBe(repo);

		await factory.dispose();
	});

	test("does not match a sibling workspace sharing a path prefix (Windows)", async () => {
		const { ProjectProviderFactory } = await import(
			"../../src/factories/provider-factory.js"
		);
		const vscode = await import("vscode");

		const factory = new ProjectProviderFactory(
			logger,
			createMockExtensionContext({ globalStoragePath: "/tmp/test" }),
		);

		const repo = await factory.createProvider(makeConfig("repo", "C:\\repo"));
		const other = await factory.createProvider(
			makeConfig("repoOther", "C:\\repo-other"),
		);

		// C:\repo-other\src\file.ts must resolve to repoOther, never repo,
		// proving the separator boundary survives normalization.
		const otherFile = vscode.Uri.file("C:\\repo-other\\src\\file.ts");
		expect(factory.getProviderForFile(otherFile)).toBe(other);
		expect(factory.getProviderForFile(otherFile)).not.toBe(repo);

		await factory.dispose();
	});

	test("longest-match wins for nested Windows workspaces", async () => {
		const { ProjectProviderFactory } = await import(
			"../../src/factories/provider-factory.js"
		);
		const vscode = await import("vscode");

		const factory = new ProjectProviderFactory(
			logger,
			createMockExtensionContext({ globalStoragePath: "/tmp/test" }),
		);

		const outer = await factory.createProvider(makeConfig("outer", "C:\\repo"));
		const inner = await factory.createProvider(
			makeConfig("inner", "C:\\repo\\packages\\app"),
		);

		const innerFile = vscode.Uri.file("C:\\repo\\packages\\app\\src\\file.ts");
		expect(factory.getProviderForFile(innerFile)).toBe(inner);
		expect(factory.getProviderForFile(innerFile)).not.toBe(outer);

		await factory.dispose();
	});

	test("preserves POSIX forward-slash containment behavior", async () => {
		const { ProjectProviderFactory } = await import(
			"../../src/factories/provider-factory.js"
		);
		const vscode = await import("vscode");

		const factory = new ProjectProviderFactory(
			logger,
			createMockExtensionContext({ globalStoragePath: "/tmp/test" }),
		);

		const repo = await factory.createProvider(
			makeConfig("repo", "/home/user/repo"),
		);
		await factory.createProvider(makeConfig("repo10", "/home/user/repo10"));

		const nested = vscode.Uri.file("/home/user/repo/src/file.ts");
		expect(factory.getProviderForFile(nested)).toBe(repo);

		// Substring sibling must not match (the original separator-boundary guard).
		const unrelated = vscode.Uri.file("/home/user/repo10/src/file.ts");
		expect(factory.getProviderForFile(unrelated)).not.toBe(repo);

		await factory.dispose();
	});

	test("returns undefined when no workspace contains the file", async () => {
		const { ProjectProviderFactory } = await import(
			"../../src/factories/provider-factory.js"
		);
		const vscode = await import("vscode");

		const factory = new ProjectProviderFactory(
			logger,
			createMockExtensionContext({ globalStoragePath: "/tmp/test" }),
		);

		await factory.createProvider(makeConfig("repo", "C:\\repo"));

		const outside = vscode.Uri.file("D:\\elsewhere\\file.ts");
		expect(factory.getProviderForFile(outside)).toBeUndefined();

		await factory.dispose();
	});
});

/**
 * Regression coverage for CP-04 / PAR-47: concurrent createProvider calls for
 * the same config.id must NOT create duplicate, untracked providers.
 *
 * The buggy implementation read the `providers` cache before awaiting storage
 * creation and provider.initialize(), then wrote the map only afterward. Two
 * concurrent calls for the same id therefore both missed the cache, both built
 * a provider, and one overwrote the other in the map — the orphaned provider
 * was never disposed by dispose() (which iterates only the tracked map).
 *
 * These tests interleave two createProvider calls via Promise.all and assert
 * that they resolve to the SAME instance, that only one provider was built
 * (storage create called once), and that disposal cleans up exactly one
 * provider — i.e. no leak.
 */
describe("ProjectProviderFactory.createProvider concurrency (CP-04 / PAR-47)", () => {
	let logger: LoggerService;

	beforeEach(() => {
		logger = createMockLogger();
		mock.restore();
		setupVSCodeMock();
	});

	test("concurrent calls for the same id share one provider instance", async () => {
		const { ProjectProviderFactory } = await import(
			"../../src/factories/provider-factory.js"
		);
		const storageModule = await import("../../src/git-sort/storage/index.js");

		// Count how many providers actually begin construction. On the buggy code
		// both concurrent callers reach storage creation, so this fires twice.
		const createSpy = spyOn(
			storageModule.WorkspaceStateStorageAdapter,
			"create",
		);

		const factory = new ProjectProviderFactory(
			logger,
			createMockExtensionContext({ globalStoragePath: "/tmp/test" }),
		);

		const config = makeConfig("repo", "/home/user/repo");

		const [first, second] = await Promise.all([
			factory.createProvider(config),
			factory.createProvider(config),
		]);

		// Same shared instance — not two duplicates.
		expect(first).toBe(second);
		// Exactly one provider was built; the second caller coalesced.
		expect(createSpy).toHaveBeenCalledTimes(1);

		// A subsequent call (post-settle) still returns the cached instance.
		const third = await factory.createProvider(config);
		expect(third).toBe(first);
		expect(createSpy).toHaveBeenCalledTimes(1);

		createSpy.mockRestore();
		await factory.dispose();
	});

	test("disposal cleans up exactly one provider after concurrent creation (no leak)", async () => {
		const { ProjectProviderFactory } = await import(
			"../../src/factories/provider-factory.js"
		);

		const factory = new ProjectProviderFactory(
			logger,
			createMockExtensionContext({ globalStoragePath: "/tmp/test" }),
		);

		const config = makeConfig("repo", "/home/user/repo");

		const [first, second] = await Promise.all([
			factory.createProvider(config),
			factory.createProvider(config),
		]);
		expect(first).toBe(second);

		// Spy on the single shared provider's dispose. On the buggy code a second,
		// orphaned provider would never be disposed; here exactly one is.
		const disposeSpy = spyOn(first, "dispose");

		await factory.dispose();

		expect(disposeSpy).toHaveBeenCalledTimes(1);

		// After disposal the factory holds no providers — a fresh create rebuilds.
		const rebuilt = await factory.createProvider(config);
		expect(rebuilt).not.toBe(first);

		await factory.dispose();
	});

	test("a failed creation clears the in-flight entry so the next call retries", async () => {
		const { ProjectProviderFactory } = await import(
			"../../src/factories/provider-factory.js"
		);
		const providerModule = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);
		const vscode = await import("vscode");

		const factory = new ProjectProviderFactory(
			logger,
			createMockExtensionContext({ globalStoragePath: "/tmp/test" }),
		);

		const config = makeConfig("repo", "/home/user/repo");

		// Force the first initialize() to reject, then restore real behavior.
		const initSpy = spyOn(
			providerModule.SortedGitChangesProvider.prototype,
			"initialize",
		).mockImplementationOnce(async () => {
			throw new Error("boom");
		});

		await expect(factory.createProvider(config)).rejects.toThrow("boom");

		// The in-flight entry must have been cleared on failure: a retry succeeds
		// and produces a tracked provider reachable via file lookup.
		const retry = await factory.createProvider(config);
		expect(retry).toBeDefined();
		const fileInWorkspace = vscode.Uri.file("/home/user/repo/src/file.ts");
		expect(factory.getProviderForFile(fileInWorkspace)).toBe(retry);

		initSpy.mockRestore();
		await factory.dispose();
	});
});
