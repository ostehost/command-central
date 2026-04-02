const EXACT_MODEL_ALIASES = new Map<string, string>([
	["anthropic/claude-opus-4-6", "opus"],
	["anthropic/claude-opus-4-5", "opus"],
	["anthropic/claude-sonnet-4-5", "sonnet"],
	["anthropic/claude-sonnet-4-0", "sonnet"],
	["anthropic/claude-3.7-sonnet", "sonnet"],
	["anthropic/claude-3.5-sonnet", "sonnet"],
	["anthropic/claude-3.5-haiku", "haiku"],
	["openai-codex/gpt-5.4", "codex-5.4"],
	["openai-codex/gpt-5.4-mini", "codex-5.4-mini"],
	["openai/gpt-4o", "gpt-4o"],
	["openai/gpt-4.1", "gpt-4.1"],
	["openai/o3", "o3"],
	["openai/o4-mini", "o4-mini"],
	["google/gemini-3.1-pro-preview", "gemini-pro"],
	["google/gemini-2.5-pro", "gemini-pro"],
	["google/gemini-2.5-flash", "flash"],
	["google/gemini-2.5-flash-lite", "flash-lite"],
]);

export function getModelAlias(fullModelName: string): string {
	const normalized = fullModelName.trim().toLowerCase();
	if (normalized.length === 0) return "";

	const exactAlias = EXACT_MODEL_ALIASES.get(normalized);
	if (exactAlias) return exactAlias;

	if (normalized.includes("claude-opus")) return "opus";
	if (normalized.includes("claude-sonnet")) return "sonnet";
	if (normalized.includes("claude-haiku")) return "haiku";
	if (normalized.startsWith("openai-codex/gpt-5.4")) {
		return normalized.includes("mini") ? "codex-5.4-mini" : "codex-5.4";
	}
	if (normalized.includes("gemini") && normalized.includes("flash-lite")) {
		return "flash-lite";
	}
	if (normalized.includes("gemini") && normalized.includes("flash")) {
		return "flash";
	}
	if (normalized.includes("gemini") && normalized.includes("pro")) {
		return "gemini-pro";
	}

	const [, modelName = normalized] = normalized.split("/", 2);
	return modelName;
}
