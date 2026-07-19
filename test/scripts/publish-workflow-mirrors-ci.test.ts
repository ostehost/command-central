import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Contract: the release gate (publish.yml) must run the repo's canonical test
 * entrypoint, not a hand-curated directory subset.
 *
 * History: publish.yml once ran
 *   `bun test test/commands test/git-sort test/mocks ... test/integration`
 * which (a) drifted out of sync with the real suite and (b) included a phantom
 * `test/mocks` path that silently passed zero tests. That let the release gate
 * green-light a build whose tests CI would have flagged. This contract freezes
 * the gate to `bun run test` (the same selection ci.yml runs via
 * `just ci` -> test:coverage:ci) so it can never re-drift.
 */

const repoRoot = path.resolve(import.meta.dir, "../..");
const publishWorkflowPath = path.join(
	repoRoot,
	".github",
	"workflows",
	"publish.yml",
);
const packageJsonPath = path.join(repoRoot, "package.json");

function readPublishWorkflow(): string {
	return fs.readFileSync(publishWorkflowPath, "utf8");
}

describe("publish.yml release gate mirrors CI", () => {
	test("invokes the canonical `bun run test` entrypoint", () => {
		const workflow = readPublishWorkflow();
		expect(workflow).toContain("bun run test");
	});

	test("does not embed a hand-curated `bun test test/...` directory list", () => {
		const workflow = readPublishWorkflow();
		// A drifted gate re-emerges as an explicit multi-arg `bun test test/<dir>`
		// invocation. `bun run test` (the sanctioned form) never has a `test/`
		// argument on the same line.
		const driftedInvocation = /bun\s+test\s+test\//;
		expect(driftedInvocation.test(workflow)).toBe(false);
	});

	test("does not reference the phantom test/mocks path", () => {
		const workflow = readPublishWorkflow();
		// test/mocks does not exist; listing it silently passed zero tests.
		expect(fs.existsSync(path.join(repoRoot, "test", "mocks"))).toBe(false);
		expect(workflow).not.toContain("test/mocks");
	});

	test("the canonical `test` script exists in package.json", () => {
		const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
			scripts?: Record<string, string>;
		};
		expect(pkg.scripts?.test).toBeTruthy();
		// The gate delegates to this script; if it disappears the gate breaks.
		expect(pkg.scripts?.test).toContain("bun test");
	});
});
