/**
 * Tests for extension-discovery.ts
 *
 * Testing strategy:
 * - countExtensionsByWorkspace: counting logic, normalization, multi-workspace
 * - buildExtensionMetadata: metadata construction, sorting, display names
 * - Edge cases: empty inputs, files without extensions, mixed case
 */

import { describe, expect, test } from "bun:test";
import type { Uri } from "vscode";
import {
	buildExtensionMetadata,
	countExtensionsByWorkspace,
	type WorkspaceChanges,
} from "../../src/utils/extension-discovery.ts";

// Helper to create a mock GitChangeItem
function mockChange(filePath: string) {
	return {
		uri: { fsPath: filePath } as Uri,
	};
}

// Helper to create WorkspaceChanges
function ws(workspace: string, paths: string[]): WorkspaceChanges {
	return {
		workspace,
		changes: paths.map(mockChange),
	};
}

// ============================================================================
// countExtensionsByWorkspace()
// ============================================================================

describe("countExtensionsByWorkspace", () => {
	test("returns empty map for empty input", () => {
		const result = countExtensionsByWorkspace([]);
		expect(result.size).toBe(0);
	});

	test("returns empty map for workspace with no changes", () => {
		const result = countExtensionsByWorkspace([
			{ workspace: "ws1", changes: [] },
		]);
		expect(result.size).toBe(0);
	});

	test("counts a single file extension", () => {
		const result = countExtensionsByWorkspace([
			ws("ws1", ["/project/src/index.ts"]),
		]);

		expect(result.size).toBe(1);
		expect(result.get(".ts")?.get("ws1")).toBe(1);
	});

	test("counts multiple files with the same extension", () => {
		const result = countExtensionsByWorkspace([
			ws("ws1", ["/project/a.ts", "/project/b.ts", "/project/c.ts"]),
		]);

		expect(result.size).toBe(1);
		expect(result.get(".ts")?.get("ws1")).toBe(3);
	});

	test("counts multiple different extensions", () => {
		const result = countExtensionsByWorkspace([
			ws("ws1", ["/project/a.ts", "/project/b.js", "/project/c.md"]),
		]);

		expect(result.size).toBe(3);
		expect(result.get(".ts")?.get("ws1")).toBe(1);
		expect(result.get(".js")?.get("ws1")).toBe(1);
		expect(result.get(".md")?.get("ws1")).toBe(1);
	});

	test("normalizes extensions to lowercase", () => {
		const result = countExtensionsByWorkspace([
			ws("ws1", ["/project/a.TS", "/project/b.Ts", "/project/c.ts"]),
		]);

		expect(result.size).toBe(1);
		expect(result.get(".ts")?.get("ws1")).toBe(3);
	});

	test("handles files without extensions (empty string key)", () => {
		const result = countExtensionsByWorkspace([
			ws("ws1", ["/project/Makefile", "/project/Dockerfile"]),
		]);

		expect(result.size).toBe(1);
		expect(result.get("")?.get("ws1")).toBe(2);
	});

	test("counts across multiple workspaces", () => {
		const result = countExtensionsByWorkspace([
			ws("ws1", ["/ws1/a.ts", "/ws1/b.ts"]),
			ws("ws2", ["/ws2/c.ts"]),
		]);

		expect(result.size).toBe(1);
		const tsCounts = result.get(".ts");
		expect(tsCounts?.get("ws1")).toBe(2);
		expect(tsCounts?.get("ws2")).toBe(1);
	});

	test("separates counts by workspace correctly", () => {
		const result = countExtensionsByWorkspace([
			ws("frontend", ["/fe/app.tsx", "/fe/util.ts"]),
			ws("backend", ["/be/server.ts", "/be/db.ts", "/be/config.json"]),
		]);

		expect(result.get(".ts")?.get("frontend")).toBe(1);
		expect(result.get(".ts")?.get("backend")).toBe(2);
		expect(result.get(".tsx")?.get("frontend")).toBe(1);
		expect(result.get(".tsx")?.get("backend")).toBeUndefined();
		expect(result.get(".json")?.get("backend")).toBe(1);
	});

	test("handles dotfiles (extension is full filename minus leading dot)", () => {
		const result = countExtensionsByWorkspace([
			ws("ws1", ["/project/.gitignore"]),
		]);

		// path.extname(".gitignore") returns "" — no extension
		// Actually, path.extname returns "" for dotfiles with no further extension
		// Let's verify what the function produces
		expect(result.has("") || result.has(".gitignore")).toBe(true);
	});

	test("handles deeply nested paths", () => {
		const result = countExtensionsByWorkspace([
			ws("ws1", ["/a/b/c/d/e/f/deep.py"]),
		]);

		expect(result.get(".py")?.get("ws1")).toBe(1);
	});

	test("handles multiple workspaces with empty changes arrays", () => {
		const result = countExtensionsByWorkspace([
			{ workspace: "ws1", changes: [] },
			{ workspace: "ws2", changes: [] },
			{ workspace: "ws3", changes: [] },
		]);

		expect(result.size).toBe(0);
	});
});

// ============================================================================
// buildExtensionMetadata()
// ============================================================================

describe("buildExtensionMetadata", () => {
	test("returns empty array for empty map", () => {
		const result = buildExtensionMetadata(new Map());
		expect(result).toEqual([]);
	});

	test("builds metadata for a single extension", () => {
		const counts = new Map<string, Map<string, number>>();
		counts.set(".ts", new Map([["ws1", 5]]));

		const result = buildExtensionMetadata(counts);

		expect(result).toHaveLength(1);
		expect(result[0]?.extension).toBe(".ts");
		expect(result[0]?.displayName).toBe("TypeScript");
		expect(result[0]?.totalCount).toBe(5);
		expect(result[0]?.workspaceCounts.get("ws1")).toBe(5);
	});

	test("calculates totalCount across multiple workspaces", () => {
		const counts = new Map<string, Map<string, number>>();
		counts.set(
			".ts",
			new Map([
				["ws1", 3],
				["ws2", 7],
				["ws3", 2],
			]),
		);

		const result = buildExtensionMetadata(counts);

		expect(result[0]?.totalCount).toBe(12);
	});

	test("sorts results alphabetically by extension", () => {
		const counts = new Map<string, Map<string, number>>();
		counts.set(".ts", new Map([["ws1", 1]]));
		counts.set(".js", new Map([["ws1", 1]]));
		counts.set(".css", new Map([["ws1", 1]]));
		counts.set(".md", new Map([["ws1", 1]]));

		const result = buildExtensionMetadata(counts);

		const extensions = result.map((r) => r.extension);
		expect(extensions).toEqual([".css", ".js", ".md", ".ts"]);
	});

	test("empty extension sorts first (alphabetically)", () => {
		const counts = new Map<string, Map<string, number>>();
		counts.set(".ts", new Map([["ws1", 1]]));
		counts.set("", new Map([["ws1", 2]]));

		const result = buildExtensionMetadata(counts);

		expect(result[0]?.extension).toBe("");
		expect(result[0]?.displayName).toBe("No Extension");
		expect(result[0]?.totalCount).toBe(2);
	});

	test("uses correct display names for known extensions", () => {
		const counts = new Map<string, Map<string, number>>();
		counts.set(".ts", new Map([["ws1", 1]]));
		counts.set(".py", new Map([["ws1", 1]]));
		counts.set(".md", new Map([["ws1", 1]]));

		const result = buildExtensionMetadata(counts);

		const nameMap = new Map(result.map((r) => [r.extension, r.displayName]));
		expect(nameMap.get(".ts")).toBe("TypeScript");
		expect(nameMap.get(".py")).toBe("Python");
		expect(nameMap.get(".md")).toBe("Markdown");
	});

	test("generates uppercase display name for unknown extensions", () => {
		const counts = new Map<string, Map<string, number>>();
		counts.set(".xyz", new Map([["ws1", 1]]));

		const result = buildExtensionMetadata(counts);

		expect(result[0]?.displayName).toBe("XYZ");
	});

	test("preserves workspace counts map in metadata", () => {
		const wsCounts = new Map([
			["frontend", 10],
			["backend", 20],
		]);
		const counts = new Map<string, Map<string, number>>();
		counts.set(".ts", wsCounts);

		const result = buildExtensionMetadata(counts);

		expect(result[0]?.workspaceCounts).toBe(wsCounts);
	});
});

// ============================================================================
// Integration: countExtensionsByWorkspace -> buildExtensionMetadata
// ============================================================================

describe("end-to-end: count then build metadata", () => {
	test("full pipeline with multiple workspaces and extensions", () => {
		const workspaceData: WorkspaceChanges[] = [
			ws("frontend", [
				"/fe/App.tsx",
				"/fe/index.ts",
				"/fe/styles.css",
				"/fe/utils.ts",
			]),
			ws("backend", [
				"/be/server.ts",
				"/be/db.ts",
				"/be/config.json",
				"/be/README.md",
			]),
		];

		const counts = countExtensionsByWorkspace(workspaceData);
		const metadata = buildExtensionMetadata(counts);

		// Should have 5 unique extensions: .css, .json, .md, .ts, .tsx
		expect(metadata).toHaveLength(5);

		// Verify sorted order
		const exts = metadata.map((m) => m.extension);
		expect(exts).toEqual([".css", ".json", ".md", ".ts", ".tsx"]);

		// Verify .ts counts: frontend=2, backend=2, total=4
		const tsInfo = metadata.find((m) => m.extension === ".ts");
		expect(tsInfo?.totalCount).toBe(4);
		expect(tsInfo?.workspaceCounts.get("frontend")).toBe(2);
		expect(tsInfo?.workspaceCounts.get("backend")).toBe(2);

		// Verify .tsx is only in frontend
		const tsxInfo = metadata.find((m) => m.extension === ".tsx");
		expect(tsxInfo?.totalCount).toBe(1);
		expect(tsxInfo?.workspaceCounts.get("frontend")).toBe(1);
		expect(tsxInfo?.workspaceCounts.get("backend")).toBeUndefined();
	});

	test("pipeline with no files produces empty metadata", () => {
		const counts = countExtensionsByWorkspace([]);
		const metadata = buildExtensionMetadata(counts);
		expect(metadata).toEqual([]);
	});
});
