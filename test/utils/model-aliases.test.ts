import { describe, expect, test } from "bun:test";
import { getModelAlias } from "../../src/utils/model-aliases.js";

describe("getModelAlias", () => {
	test("maps common Anthropic models to short aliases", () => {
		expect(getModelAlias("anthropic/claude-opus-4-6")).toBe("opus");
		expect(getModelAlias("anthropic/claude-3.7-sonnet")).toBe("sonnet");
	});

	test("maps common OpenAI Codex and Gemini models to short aliases", () => {
		expect(getModelAlias("openai-codex/gpt-5.4")).toBe("codex-5.4");
		expect(getModelAlias("google/gemini-3.1-pro-preview")).toBe("gemini-pro");
		expect(getModelAlias("google/gemini-2.5-flash-lite")).toBe("flash-lite");
		expect(getModelAlias("openai/gpt-4o")).toBe("gpt-4o");
	});

	test("falls back to the model name without provider prefix", () => {
		expect(getModelAlias("provider/custom-model-v2")).toBe("custom-model-v2");
	});
});
