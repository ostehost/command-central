import { describe, expect, test } from "bun:test";
import {
	cleanPromptForDisplay,
	isPromptBoilerplateLine,
	normalizePromptSummaryLine,
	truncatePromptSummary,
} from "../../src/providers/prompt-display.js";

describe("prompt-display", () => {
	test("cleanPromptForDisplay skips boilerplate prefixes to the first real line", () => {
		const raw = [
			"ULTRATHINK",
			"<system-reminder>be careful</system-reminder>",
			"## Heading",
			"---",
			"task_id: abc",
			"  Build the thing  ",
		].join("\n");
		expect(cleanPromptForDisplay(raw)).toBe("Build the thing");
		expect(cleanPromptForDisplay("## only boilerplate")).toBeNull();
	});

	test("truncatePromptSummary caps at 80 chars with an ellipsis", () => {
		expect(truncatePromptSummary("short")).toBe("short");
		const long = "x".repeat(100);
		const out = truncatePromptSummary(long);
		expect(out.endsWith("…")).toBe(true);
		expect(out.length).toBe(81);
	});

	test("normalizePromptSummaryLine strips list markers and collapses whitespace", () => {
		expect(normalizePromptSummaryLine("- do   the  thing")).toBe(
			"do the thing",
		);
		expect(normalizePromptSummaryLine("3. step three")).toBe("step three");
		expect(normalizePromptSummaryLine("> quoted")).toBe("quoted");
		expect(normalizePromptSummaryLine("   ")).toBeNull();
	});

	test("isPromptBoilerplateLine flags launcher/harness preambles", () => {
		expect(isPromptBoilerplateLine("At the START of your work, do X")).toBe(
			true,
		);
		expect(
			isPromptBoilerplateLine("You are the implementation agent for task_id 5"),
		).toBe(true);
		expect(isPromptBoilerplateLine("Fix the login bug")).toBe(false);
	});
});
