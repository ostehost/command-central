import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import {
	parseTaskRegistry,
	serializeTaskRegistry,
} from "../../src/utils/agent-task-registry.js";

const taskKeyArb = fc.string({ minLength: 1, maxLength: 12 });
const tasksArb = fc.dictionary(taskKeyArb, fc.jsonValue(), { maxKeys: 5 });

describe("agent task registry property tests", () => {
	// This property checks that valid v1/v2 registries survive parse + serialize without losing
	// version or task payload data, aside from normal JSON pretty-printing and trailing newline.
	test("serializeTaskRegistry(parseTaskRegistry(raw)) preserves valid registries", () => {
		fc.assert(
			fc.property(fc.constantFrom(1, 2), tasksArb, (version, tasks) => {
				const raw = JSON.stringify({ version, tasks });
				const roundTripped = JSON.parse(
					serializeTaskRegistry(parseTaskRegistry(raw)),
				);

				expect(roundTripped).toEqual({ version, tasks });
			}),
			{ numRuns: 100 },
		);
	});

	// This property checks that unsupported numeric versions are normalized to 2 while
	// preserving the task map that was present in the raw registry JSON.
	test("parseTaskRegistry normalizes unsupported numeric versions to 2", () => {
		fc.assert(
			fc.property(
				fc.integer().filter((version) => version !== 1 && version !== 2),
				tasksArb,
				(version, tasks) => {
					const raw = JSON.stringify({ version, tasks });
					const normalized = JSON.parse(
						serializeTaskRegistry(parseTaskRegistry(raw)),
					);

					expect(normalized).toEqual({ version: 2, tasks });
				},
			),
			{ numRuns: 100 },
		);
	});
});
