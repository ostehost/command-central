/**
 * Tests for virtual file diff URI construction.
 *
 * Verifies:
 * - The custom scheme is stable
 * - Repo-relative paths become the URI path for clean tab titles/breadcrumbs
 * - Project/ref/taskId are encoded in the query string
 * - Path segments are encoded safely without flattening nested paths
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("vscode", () => ({
	Uri: {
		parse: (value: string) => {
			const parsed = new URL(value);
			return {
				scheme: parsed.protocol.slice(0, -1),
				path: parsed.pathname,
				query: parsed.search.slice(1),
				toString: () => value,
			};
		},
	},
}));

const { buildDiffContentUri, DiffContentProvider } = await import(
	"../../src/providers/diff-content-provider.js"
);

describe("file diff virtual URI construction", () => {
	test("uses the cc-diff scheme", () => {
		const uri = buildDiffContentUri({
			projectDir: "/Users/test/project",
			ref: "abc123",
			relativePath: "package.json",
			taskId: "task-1",
		});

		expect(uri.scheme).toBe(DiffContentProvider.scheme);
	});

	test("preserves nested repo-relative paths in the URI path", () => {
		const uri = buildDiffContentUri({
			projectDir: "/Users/test/project",
			ref: "abc123",
			relativePath: "src/utils/helper.ts",
			taskId: "task-1",
		});

		expect(uri.path).toBe("/src/utils/helper.ts");
	});

	test("encodes project, ref, and taskId in the query string", () => {
		const uri = buildDiffContentUri({
			projectDir: "/Users/test/project",
			ref: "working-tree",
			relativePath: "src/app.ts",
			taskId: "task-99",
		});

		const params = new URLSearchParams(uri.query);
		expect(params.get("project")).toBe("/Users/test/project");
		expect(params.get("ref")).toBe("working-tree");
		expect(params.get("taskId")).toBe("task-99");
	});

	test("encodes special characters in path segments without flattening", () => {
		const uri = buildDiffContentUri({
			projectDir: "/Users/test/project",
			ref: "abc123",
			relativePath: "docs/space name/#intro?.md",
			taskId: "task-1",
		});

		expect(uri.toString()).toContain("docs/space%20name/%23intro%3F.md");
		expect(uri.path).toBe("/docs/space%20name/%23intro%3F.md");
	});
});
