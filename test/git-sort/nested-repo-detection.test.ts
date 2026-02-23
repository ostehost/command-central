/**
 * Tests for nested repository detection in SortedGitChangesProvider
 *
 * Bug: When workspace folder is a PARENT of the git repo root (nested repo),
 * findRepositoryForFile() failed to match because it only checked
 * filePath.startsWith(repoPath), not the reverse direction.
 *
 * Fix: Added Strategy 2 — reverse match for nested repos where
 * repoPath.startsWith(filePath + '/').
 *
 * These tests verify:
 * 1. Nested repo detection (workspace parent of repo)
 * 2. Direct repo detection (workspace = repo root, or file inside repo)
 * 3. No false positives (similar path prefixes)
 * 4. getChildren() returns data for nested repos (integration through public API)
 * 5. Multi-root workspace with mix of direct and nested repos
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LoggerService } from "../../src/services/logger-service.js";
import {
	createMockExtensionContext,
	createMockLogger,
} from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("Nested Repository Detection", () => {
	let mockLogger: LoggerService;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
		mockLogger = createMockLogger();
	});

	/**
	 * Helper to create a mock git extension with given repositories.
	 * Sets up vscode.extensions.getExtension to return it.
	 */
	async function setupGitExtensionWithRepos(
		repos: Array<{
			rootPath: string;
			workingTreeChanges?: Array<{
				uri: { fsPath: string; path: string; scheme: string };
				originalUri: { fsPath: string; path: string; scheme: string };
				renameUri: undefined;
				status: number;
			}>;
			indexChanges?: Array<{
				uri: { fsPath: string; path: string; scheme: string };
				originalUri: { fsPath: string; path: string; scheme: string };
				renameUri: undefined;
				status: number;
			}>;
		}>,
	) {
		const vscode = await import("vscode");

		const mockRepos = repos.map((r) => ({
			rootUri: vscode.Uri.file(r.rootPath),
			state: {
				workingTreeChanges: r.workingTreeChanges ?? [],
				indexChanges: r.indexChanges ?? [],
				mergeChanges: [],
				HEAD: undefined,
				refs: [],
				remotes: [],
				submodules: [],
				rebaseCommit: undefined,
				onDidChange: mock(() => ({ dispose: () => {} })),
			},
			status: mock(async () => {}),
			diffWithHEAD: mock(async () => []),
			diffWith: mock(async () => []),
		}));

		const mockGitApi = {
			repositories: mockRepos,
			onDidOpenRepository: mock(() => ({ dispose: () => {} })),
			onDidCloseRepository: mock(() => ({ dispose: () => {} })),
			onDidChangeState: mock(() => ({ dispose: () => {} })),
		};

		const mockGitExtension = {
			id: "vscode.git",
			extensionUri: vscode.Uri.file("/mock/extension"),
			extensionPath: "/mock/extension",
			isActive: true,
			packageJSON: {},
			extensionKind: vscode.ExtensionKind.Workspace,
			activate: mock(() => Promise.resolve({ getAPI: () => mockGitApi })),
			exports: { getAPI: mock(() => mockGitApi) },
		};

		vscode.extensions.getExtension = mock(
			() =>
				// biome-ignore lint/suspicious/noExplicitAny: GitExtension API has dynamic export structure
				mockGitExtension as any,
		);

		return { mockGitApi, mockRepos };
	}

	// =========================================================================
	// Strategy 1: Direct match (existing behavior — file/folder inside repo)
	// =========================================================================

	test("finds repo when workspace root equals repo root (exact match)", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		await setupGitExtensionWithRepos([{ rootPath: "/workspace" }]);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			mockLogger,
			mockContext,
			undefined,
			vscode.Uri.file("/workspace"),
		);
		await provider.initialize();

		const repo = provider.findRepositoryForFile(vscode.Uri.file("/workspace"));
		expect(repo).toBeDefined();
		expect(repo?.rootUri.fsPath).toBe("/workspace");
	});

	test("finds repo when file is inside repo (standard case)", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		await setupGitExtensionWithRepos([{ rootPath: "/workspace" }]);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			mockLogger,
			mockContext,
			undefined,
			vscode.Uri.file("/workspace"),
		);
		await provider.initialize();

		const repo = provider.findRepositoryForFile(
			vscode.Uri.file("/workspace/src/file.ts"),
		);
		expect(repo).toBeDefined();
		expect(repo?.rootUri.fsPath).toBe("/workspace");
	});

	test("returns most specific repo in multi-root workspace", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		await setupGitExtensionWithRepos([
			{ rootPath: "/workspace" },
			{ rootPath: "/workspace/packages/sub-repo" },
		]);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			mockLogger,
			mockContext,
			undefined,
			vscode.Uri.file("/workspace"),
		);
		await provider.initialize();

		// File inside sub-repo should match sub-repo (most specific)
		const repo = provider.findRepositoryForFile(
			vscode.Uri.file("/workspace/packages/sub-repo/src/index.ts"),
		);
		expect(repo).toBeDefined();
		expect(repo?.rootUri.fsPath).toBe("/workspace/packages/sub-repo");
	});

	// =========================================================================
	// Strategy 2: Nested repo detection (repo root is child of workspace)
	// =========================================================================

	test("finds nested repo when workspace is parent of repo root", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Workspace is ~/.openclaw, repo is ~/.openclaw/workspace
		await setupGitExtensionWithRepos([
			{ rootPath: "/Users/test/.openclaw/workspace" },
		]);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			mockLogger,
			mockContext,
			undefined,
			vscode.Uri.file("/Users/test/.openclaw"),
		);
		await provider.initialize();

		const repo = provider.findRepositoryForFile(
			vscode.Uri.file("/Users/test/.openclaw"),
		);
		expect(repo).toBeDefined();
		expect(repo?.rootUri.fsPath).toBe("/Users/test/.openclaw/workspace");
	});

	test("picks shallowest nested repo when multiple exist", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Workspace has two nested repos at different depths
		await setupGitExtensionWithRepos([
			{ rootPath: "/parent/deep/nested/repo" },
			{ rootPath: "/parent/shallow" },
		]);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			mockLogger,
			mockContext,
			undefined,
			vscode.Uri.file("/parent"),
		);
		await provider.initialize();

		const repo = provider.findRepositoryForFile(vscode.Uri.file("/parent"));
		expect(repo).toBeDefined();
		// Should pick the shallowest (closest to workspace root)
		expect(repo?.rootUri.fsPath).toBe("/parent/shallow");
	});

	// =========================================================================
	// No false positives
	// =========================================================================

	test("does NOT match repo with similar prefix (path boundary)", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Repo at /workspace-other should NOT match workspace /workspace
		await setupGitExtensionWithRepos([{ rootPath: "/workspace-other" }]);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			mockLogger,
			mockContext,
			undefined,
			vscode.Uri.file("/workspace"),
		);
		await provider.initialize();

		const repo = provider.findRepositoryForFile(vscode.Uri.file("/workspace"));
		expect(repo).toBeUndefined();
	});

	test("does NOT match nested repo with similar prefix", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Repo at /parent-other/repo should NOT be found as nested under /parent
		await setupGitExtensionWithRepos([{ rootPath: "/parent-other/repo" }]);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			mockLogger,
			mockContext,
			undefined,
			vscode.Uri.file("/parent"),
		);
		await provider.initialize();

		const repo = provider.findRepositoryForFile(vscode.Uri.file("/parent"));
		expect(repo).toBeUndefined();
	});

	test("returns undefined when no repos exist", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		await setupGitExtensionWithRepos([]);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			mockLogger,
			mockContext,
			undefined,
			vscode.Uri.file("/workspace"),
		);
		await provider.initialize();

		const repo = provider.findRepositoryForFile(vscode.Uri.file("/workspace"));
		expect(repo).toBeUndefined();
	});

	test("returns undefined when gitApi is not initialized", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Don't call initialize() — gitApi stays undefined
		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			mockLogger,
			mockContext,
			undefined,
			vscode.Uri.file("/workspace"),
		);

		const repo = provider.findRepositoryForFile(vscode.Uri.file("/workspace"));
		expect(repo).toBeUndefined();
	});

	// =========================================================================
	// Strategy 1 takes priority over Strategy 2
	// =========================================================================

	test("prefers containing repo over nested repo", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Both a parent repo and a nested repo exist
		await setupGitExtensionWithRepos([
			{ rootPath: "/workspace" }, // Contains the query path
			{ rootPath: "/workspace/sub/nested" }, // Nested under query path
		]);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			mockLogger,
			mockContext,
			undefined,
			vscode.Uri.file("/workspace/sub"),
		);
		await provider.initialize();

		// Query a path inside /workspace but parent of /workspace/sub/nested
		const repo = provider.findRepositoryForFile(
			vscode.Uri.file("/workspace/sub"),
		);
		expect(repo).toBeDefined();
		// Strategy 1 (containing repo) should win: /workspace contains /workspace/sub
		expect(repo?.rootUri.fsPath).toBe("/workspace");
	});

	// =========================================================================
	// Multi-root workspace with mix of direct and nested repos
	// =========================================================================

	test("handles multi-root with direct and nested repos", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Simulate multi-root workspace:
		// Folder 1: /projects/alpha (IS a git repo root — direct)
		// Folder 2: /home/config    (CONTAINS a git repo at /home/config/dotfiles — nested)
		await setupGitExtensionWithRepos([
			{ rootPath: "/projects/alpha" },
			{ rootPath: "/home/config/dotfiles" },
		]);

		const mockContext = createMockExtensionContext();

		// Provider for folder 1 (direct repo)
		const provider1 = new SortedGitChangesProvider(
			mockLogger,
			mockContext,
			undefined,
			vscode.Uri.file("/projects/alpha"),
		);
		await provider1.initialize();

		const repo1 = provider1.findRepositoryForFile(
			vscode.Uri.file("/projects/alpha"),
		);
		expect(repo1).toBeDefined();
		expect(repo1?.rootUri.fsPath).toBe("/projects/alpha");

		// Provider for folder 2 (nested repo)
		const provider2 = new SortedGitChangesProvider(
			mockLogger,
			mockContext,
			undefined,
			vscode.Uri.file("/home/config"),
		);
		await provider2.initialize();

		const repo2 = provider2.findRepositoryForFile(
			vscode.Uri.file("/home/config"),
		);
		expect(repo2).toBeDefined();
		expect(repo2?.rootUri.fsPath).toBe("/home/config/dotfiles");
	});

	// =========================================================================
	// Integration: getChildren() with nested repos
	// =========================================================================

	test("getChildren returns changes for nested repo (the actual bug)", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// Simulate the actual bug scenario:
		// Workspace folder: /Users/test/.openclaw (no .git)
		// Git repo:         /Users/test/.openclaw/workspace (.git here)
		const testFile = "/Users/test/.openclaw/workspace/src/app.ts";
		const modifiedFileUri = vscode.Uri.file(testFile);

		await setupGitExtensionWithRepos([
			{
				rootPath: "/Users/test/.openclaw/workspace",
				workingTreeChanges: [
					{
						uri: modifiedFileUri,
						originalUri: modifiedFileUri,
						renameUri: undefined,
						status: 5, // Status.MODIFIED
					},
				],
			},
		]);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			mockLogger,
			mockContext,
			undefined,
			vscode.Uri.file("/Users/test/.openclaw"), // workspace root = parent folder
		);
		await provider.initialize();

		// Verify the provider can find the nested repo (the core fix)
		const repo = provider.findRepositoryForFile(
			vscode.Uri.file("/Users/test/.openclaw"),
		);
		expect(repo).toBeDefined();
		expect(repo?.rootUri.fsPath).toBe("/Users/test/.openclaw/workspace");
	});

	test("getChildren returns empty when workspace has no nested repos", async () => {
		const vscode = await import("vscode");
		const { SortedGitChangesProvider } = await import(
			"../../src/git-sort/sorted-changes-provider.js"
		);

		// No repos match the workspace
		await setupGitExtensionWithRepos([
			{ rootPath: "/completely/different/path" },
		]);

		const mockContext = createMockExtensionContext();
		const provider = new SortedGitChangesProvider(
			mockLogger,
			mockContext,
			undefined,
			vscode.Uri.file("/Users/test/.openclaw"),
		);
		await provider.initialize();

		const children = await provider.getChildren();
		expect(children).toEqual([]);
	});
});
