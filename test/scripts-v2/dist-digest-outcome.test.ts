import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { evaluateDigestResult } from "../../scripts-v2/dist-simple-utils.ts";

// The digest is the release RECORD for a preview cut (CHANGELOG is curated for
// stable GA only), so "no digest" is never a silent-success case. This branch
// used to swallow every failure mode: stderr was piped and never read, a
// non-zero exit wrote nothing, and a bare `catch { /* digest is optional */ }`
// discarded the error — a broken generator produced a cut with no release
// record and no complaint anywhere in the output.
describe("evaluateDigestResult", () => {
	test("writes the digest on a clean run", () => {
		const outcome = evaluateDigestResult(
			"0.6.0-rc.91",
			0,
			"## Command Central v0.6.0-rc.91\n",
			"",
		);
		expect(outcome.write).toBe(true);
		expect(outcome.warnings).toEqual([]);
	});

	test("warns instead of writing when the generator exits non-zero", () => {
		const outcome = evaluateDigestResult("0.6.0-rc.91", 1, "partial", "");
		expect(outcome.write).toBe(false);
		expect(outcome.warnings.join("\n")).toContain("NOT written");
		expect(outcome.warnings.join("\n")).toContain("no release record");
	});

	test("warns instead of writing when output is empty despite exit 0", () => {
		// The shape that silently produced a record-less cut: exit 0, no output.
		const outcome = evaluateDigestResult("0.6.0-rc.91", 0, "   \n  ", "");
		expect(outcome.write).toBe(false);
		expect(outcome.warnings.join("\n")).toContain("empty output");
	});

	test("surfaces generator stderr even on an otherwise successful run", () => {
		// The stable-version "no CHANGELOG section" warning reaches the operator
		// only through this path — stderr is piped and was previously discarded.
		const outcome = evaluateDigestResult(
			"0.6.0",
			0,
			"## Command Central v0.6.0\n",
			"WARNING: CHANGELOG.md has no section for stable version 0.6.0",
		);
		expect(outcome.write).toBe(true);
		expect(outcome.warnings.join("\n")).toContain(
			"no section for stable version",
		);
	});

	test("reports a null exit code rather than treating it as success", () => {
		// A killed subprocess reports exitCode null; `null === 0` is false, so it
		// must land in the warn-and-skip path, not silently write.
		const outcome = evaluateDigestResult("0.6.0-rc.91", null, "content", "");
		expect(outcome.write).toBe(false);
		expect(outcome.warnings.join("\n")).toContain("exit null");
	});
});

describe("dist-simple CLI entry", () => {
	test("main() only runs when the script is the entrypoint", () => {
		// dist-simple.ts called main() unconditionally at module scope, so merely
		// importing it started a real distribution run — cleaning dist/, building
		// VSIXes, and potentially installing to VS Code. Asserted on source text
		// rather than by importing: importing it is precisely the hazard, and a
		// test that reintroduced it would run a build inside the suite.
		const source = fs.readFileSync(
			path.join(import.meta.dir, "../../scripts-v2/dist-simple.ts"),
			"utf-8",
		);
		expect(source).toContain("if (import.meta.main)");
		// No bare `main();` at the start of a line, outside the guard.
		expect(source).not.toMatch(/^main\(\);/m);
	});
});
