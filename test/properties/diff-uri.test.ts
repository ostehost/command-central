import { describe, expect, mock, test } from "bun:test";
import * as fc from "fast-check";

mock.module("vscode", () => ({
	Uri: {
		parse: (value: string) => {
			const [scheme = "", remainder = ""] = value.split(":", 2);
			const [path = "", query = ""] = remainder.split("?", 2);
			return {
				scheme,
				path,
				query,
				toString: () => value,
			};
		},
	},
}));

const { buildDiffContentUri, DiffContentProvider } = await import(
	"../../src/providers/diff-content-provider.js"
);

const uriTextCharArb = fc.constantFrom(
	..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.#?%[]()!@+=,~^$'\"",
);

const safeTextArb = fc
	.array(uriTextCharArb, { minLength: 1, maxLength: 20 })
	.map((chars) => chars.join(""));

const safePathSegmentArb = safeTextArb.filter(
	(segment) => segment !== "." && segment !== "..",
);

const relativePathArb = fc
	.array(safePathSegmentArb, { minLength: 1, maxLength: 5 })
	.map((segments) => segments.join("/"));

const projectDirArb = fc
	.array(safePathSegmentArb, { minLength: 1, maxLength: 4 })
	.map((segments) => `/${segments.join("/")}`);

function encodeRelativePath(relativePath: string): string {
	return relativePath
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

function decodeRelativePath(uriPath: string): string {
	return uriPath
		.slice(1)
		.split("/")
		.map((segment) => decodeURIComponent(segment))
		.join("/");
}

describe("diff-content URI property tests", () => {
	// This property checks that building a diff URI never loses query metadata and that
	// decoding the URI path reconstructs the original repo-relative path segment-for-segment.
	test("buildDiffContentUri round-trips metadata and encoded relative paths", () => {
		fc.assert(
			fc.property(
				projectDirArb,
				safeTextArb,
				relativePathArb,
				safeTextArb,
				(projectDir, ref, relativePath, taskId) => {
					const uri = buildDiffContentUri({
						projectDir,
						ref,
						relativePath,
						taskId,
					});

					const params = new URLSearchParams(uri.query);
					expect(uri.scheme).toBe(DiffContentProvider.scheme);
					expect(uri.path).toBe(`/${encodeRelativePath(relativePath)}`);
					expect(decodeRelativePath(uri.path)).toBe(relativePath);
					expect(params.get("project")).toBe(projectDir);
					expect(params.get("ref")).toBe(ref);
					expect(params.get("taskId")).toBe(taskId);
				},
			),
			{ numRuns: 100 },
		);
	});
});
