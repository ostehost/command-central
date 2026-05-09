import { describe, expect, test } from "bun:test";
import {
	formatNodeExecutionGuardFailure,
	type NodeExecutionContext,
	validateNodeExecutionContext,
} from "../../scripts-v2/node-execution-guard.ts";

function context(
	overrides: Partial<NodeExecutionContext> = {},
): NodeExecutionContext {
	return {
		user: "ostehost",
		home: "/Users/ostehost",
		cwd: "/Users/ostehost/projects/command-central",
		hostname: "MacBookPro",
		...overrides,
	};
}

describe("validateNodeExecutionContext", () => {
	test("accepts the MacBook node execution identity", () => {
		expect(validateNodeExecutionContext(context())).toEqual({
			ok: true,
			issues: [],
		});
	});

	test("rejects the hub execution identity before VS Code can launch", () => {
		const result = validateNodeExecutionContext(
			context({
				user: "ostemini",
				home: "/Users/ostemini",
				cwd: "/Users/ostemini/projects/command-central",
				hostname: "MacMini",
			}),
		);

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("expected USER=ostehost, got ostemini");
		expect(result.issues).toContain(
			"expected HOME under /Users/ostehost, got /Users/ostemini",
		);
		expect(result.issues).toContain(
			"expected cwd under /Users/ostehost, got /Users/ostemini/projects/command-central",
		);
	});

	test("formats a clear OpenClaw-native recovery instruction", () => {
		const failure = formatNodeExecutionGuardFailure(
			context({ user: "ostemini" }),
			["expected USER=ostehost, got ostemini"],
		);

		expect(failure).toContain("Refusing to run node-only");
		expect(failure).toContain('host=node node="Mike MacBook Pro"');
		expect(failure).toContain("expected USER=ostehost, got ostemini");
	});
});
