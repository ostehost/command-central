import { describe, expect, test } from "bun:test";
import { extractFileReferences } from "../../src/terminal/terminal-link-provider.js";

describe("extractFileReferences", () => {
	test("file:line:col pattern", () => {
		const refs = extractFileReferences("error in src/index.ts:42:10 something");
		expect(refs.length).toBeGreaterThanOrEqual(1);
		const ref = refs.find((r) => r.filePath === "src/index.ts");
		expect(ref).toBeDefined();
		expect(ref?.line).toBe(42);
		expect(ref?.column).toBe(10);
	});

	test("file:line pattern", () => {
		const refs = extractFileReferences("src/app.tsx:15 warning");
		expect(refs.length).toBeGreaterThanOrEqual(1);
		const ref = refs.find((r) => r.filePath === "src/app.tsx");
		expect(ref).toBeDefined();
		expect(ref?.line).toBe(15);
		expect(ref?.column).toBeUndefined();
	});

	test("Node.js stack trace", () => {
		const refs = extractFileReferences(
			"    at Object.<anonymous> (src/index.ts:15:3)",
		);
		expect(refs.length).toBeGreaterThanOrEqual(1);
		const ref = refs.find((r) => r.filePath === "src/index.ts");
		expect(ref).toBeDefined();
		expect(ref?.line).toBe(15);
		expect(ref?.column).toBe(3);
	});

	test("Python traceback", () => {
		const refs = extractFileReferences('  File "app/main.py", line 42');
		expect(refs.length).toBeGreaterThanOrEqual(1);
		const ref = refs.find((r) => r.filePath === "app/main.py");
		expect(ref).toBeDefined();
		expect(ref?.line).toBe(42);
	});

	test("Go compiler error", () => {
		const refs = extractFileReferences(
			"cmd/server/main.go:28:5: undefined: foo",
		);
		expect(refs.length).toBeGreaterThanOrEqual(1);
		const ref = refs.find((r) => r.filePath === "cmd/server/main.go");
		expect(ref).toBeDefined();
		expect(ref?.line).toBe(28);
	});

	test("Rust compiler error", () => {
		const refs = extractFileReferences(" --> src/lib.rs:10:5");
		expect(refs.length).toBeGreaterThanOrEqual(1);
		const ref = refs.find((r) => r.filePath === "src/lib.rs");
		expect(ref).toBeDefined();
		expect(ref?.line).toBe(10);
		expect(ref?.column).toBe(5);
	});

	test("relative path with ./", () => {
		const refs = extractFileReferences("./components/Button.tsx:5:1");
		expect(refs.length).toBeGreaterThanOrEqual(1);
		const ref = refs.find((r) => r.filePath === "./components/Button.tsx");
		expect(ref).toBeDefined();
		expect(ref?.line).toBe(5);
	});

	test("skips http URLs", () => {
		const refs = extractFileReferences("GET http://localhost:3000/api");
		const httpRefs = refs.filter((r) => r.filePath.startsWith("http"));
		expect(httpRefs.length).toBe(0);
	});

	test("skips node: builtins", () => {
		const refs = extractFileReferences(
			"at node:internal/modules/cjs/loader:1234:12",
		);
		const nodeRefs = refs.filter((r) => r.filePath.startsWith("node:"));
		expect(nodeRefs.length).toBe(0);
	});

	test("skips node_modules", () => {
		const refs = extractFileReferences(
			"at Object.<anonymous> (node_modules/foo/index.js:1:1)",
		);
		const nmRefs = refs.filter((r) => r.filePath.includes("node_modules"));
		expect(nmRefs.length).toBe(0);
	});

	test("empty line returns empty", () => {
		expect(extractFileReferences("")).toEqual([]);
	});

	test("no file references returns empty", () => {
		expect(extractFileReferences("just some text without files")).toEqual([]);
	});
});
