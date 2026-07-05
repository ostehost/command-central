import { describe, expect, test } from "bun:test";
import {
	GUARDED_BUILTINS,
	scanSource,
	stripComments,
} from "../../scripts-v2/mock-hygiene-gate.ts";

const SNAPSHOT_DECL = `const realFs = (globalThis as Record<string, unknown>)["__realNodeFs"] as typeof import("node:fs");`;

describe("mock-hygiene-gate scanSource", () => {
	test("flags a partial node:fs mock with no real fall-through", () => {
		const src = `mock.module("node:fs", () => ({ watch: () => ({ close() {} }) }));`;
		const viols = scanSource("a.test.ts", src);
		expect(viols).toHaveLength(1);
		expect(viols[0]?.module).toBe("node:fs");
		expect(viols[0]?.rule).toBe("node-builtin-fallthrough");
	});

	test("accepts a node:fs mock that spreads the frozen snapshot", () => {
		const src = `${SNAPSHOT_DECL}\nmock.module("node:fs", () => ({ ...realFs, watch: () => ({}) }));`;
		expect(scanSource("a.test.ts", src)).toHaveLength(0);
	});

	test("accepts a mock that returns the real snapshot directly", () => {
		const src = `const fs = (globalThis as Record<string, unknown>)["__realNodeFs"];\nmock.module("node:fs", () => fs);`;
		expect(scanSource("a.test.ts", src)).toHaveLength(0);
	});

	test("accepts a require() real-pin", () => {
		const src = `const cp = require("node:child_process");\nmock.module("node:child_process", () => cp);`;
		expect(scanSource("a.test.ts", src)).toHaveLength(0);
	});

	test("flags node:child_process partial mock", () => {
		const src = `mock.module("node:child_process", () => ({ execFile: () => {} }));`;
		const viols = scanSource("a.test.ts", src);
		expect(viols).toHaveLength(1);
		expect(viols[0]?.module).toBe("node:child_process");
	});

	test("does not accept a node:fs mock covered only by the fs/promises token", () => {
		// __realNodeFsPromises must not spuriously satisfy the node:fs guard.
		const src = `const p = (globalThis as Record<string, unknown>)["__realNodeFsPromises"];\nmock.module("node:fs", () => ({ watch: () => ({}) }));`;
		const viols = scanSource("a.test.ts", src);
		expect(viols).toHaveLength(1);
		expect(viols[0]?.module).toBe("node:fs");
	});

	test("ignores mock.module examples that live only in comments", () => {
		const src = `/**\n * Example:\n *   mock.module("node:fs", () => partialFs);\n */\nexport const noop = 1;`;
		expect(scanSource("a.test.ts", src)).toHaveLength(0);
	});

	test("a /* glob fragment inside a // comment does not swallow real code", () => {
		// Regression: a naive block-comment regex pairs the `/*` in `foo/*.test.ts`
		// with a much later `*/`, deleting the snapshot binding beneath it.
		const src = `// matches tree-view/*.test.ts in a mixed run\n${SNAPSHOT_DECL}\nmock.module("node:fs", () => ({ ...realFs, watch: () => ({}) }));`;
		expect(stripComments(src)).toContain("__realNodeFs");
		expect(scanSource("a.test.ts", src)).toHaveLength(0);
	});

	test("ignores mocks of non-guarded modules", () => {
		const src = `mock.module("vscode", () => ({ ThemeColor: class {} }));\nmock.module("node:os", () => ({}));`;
		expect(scanSource("a.test.ts", src)).toHaveLength(0);
	});

	test("does not confuse node:fs with node:fs/promises", () => {
		// Mocking only node:fs/promises must not be reported against node:fs.
		const src = `const p = (globalThis as Record<string, unknown>)["__realNodeFsPromises"];\nmock.module("node:fs/promises", () => ({ ...p, readFile: async () => "" }));`;
		expect(scanSource("a.test.ts", src)).toHaveLength(0);
	});

	test("guards exactly the three shared Node builtins", () => {
		expect(Object.keys(GUARDED_BUILTINS).sort()).toEqual([
			"node:child_process",
			"node:fs",
			"node:fs/promises",
		]);
	});
});

describe("mock-hygiene-gate stripComments", () => {
	test("removes block and line comments but keeps string literals", () => {
		const src = `const a = "keep://this"; // drop this\n/* drop */ const b = 2;`;
		const out = stripComments(src);
		expect(out).toContain('"keep://this"');
		expect(out).not.toContain("drop this");
		expect(out).not.toContain("/* drop */");
	});

	test("does not treat // inside a string as a comment", () => {
		const src = `const url = "https://example.com/path"; const x = 1;`;
		expect(stripComments(src)).toContain("https://example.com/path");
		expect(stripComments(src)).toContain("const x = 1");
	});
});
