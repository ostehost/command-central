import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fc from "fast-check";
import { joinShellArgs, shellQuote } from "../../src/utils/shell-command.js";

const shellArgArb = fc
	.string({ maxLength: 20 })
	.filter((argument) => !argument.includes("\u0000"));

function parseShellCommand(command: string): string[] {
	if (command.length === 0) {
		return [];
	}

	const output = execFileSync("sh", [
		"-c",
		`set -- ${command}
printf '%s\\0' "$@"`,
	]);

	return output.toString("utf8").split("\0").slice(0, -1);
}

describe("shell command property tests", () => {
	// This property checks that shellQuote() and joinShellArgs() preserve argv semantics
	// when a real POSIX shell reparses the command line they produced.
	test("joinShellArgs round-trips arbitrary argv through POSIX sh", () => {
		fc.assert(
			fc.property(fc.array(shellArgArb, { maxLength: 6 }), (arguments_) => {
				expect(parseShellCommand(joinShellArgs(arguments_))).toEqual(
					arguments_,
				);
			}),
			{ numRuns: 100 },
		);
	});

	// This property checks the single-argument case directly so regressions in shellQuote()
	// are caught even if joinShellArgs() stays structurally the same.
	test("shellQuote round-trips a single arbitrary argument through POSIX sh", () => {
		fc.assert(
			fc.property(shellArgArb, (argument) => {
				expect(parseShellCommand(shellQuote(argument))).toEqual([argument]);
			}),
			{ numRuns: 100 },
		);
	});

	// INTENTIONAL_PROPERTY_DEMO: This stays skipped because it demonstrates the exact bug the
	// real property guards against. Naively joining args with spaces breaks argv boundaries.
	test.skip("INTENTIONAL_PROPERTY_DEMO: naive shell joins lose argv semantics", () => {
		fc.assert(
			fc.property(
				shellArgArb.filter((argument) => /\s/.test(argument)),
				shellArgArb,
				(spacedArgument, otherArgument) => {
					expect(
						parseShellCommand([spacedArgument, otherArgument].join(" ")),
					).toEqual([spacedArgument, otherArgument]);
				},
			),
			{ numRuns: 100 },
		);
	});
});
