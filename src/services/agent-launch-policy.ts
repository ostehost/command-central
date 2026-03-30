export const AGENT_BACKENDS = ["claude", "codex", "gemini"] as const;

export type AgentBackend = (typeof AGENT_BACKENDS)[number];
export type AgentLaunchMode = "single" | "mix";

export interface AgentLaunchPolicy {
	mode: AgentLaunchMode;
	defaultBackend: AgentBackend;
	mixBackends: AgentBackend[];
}

interface ConfigReader {
	get<T>(key: string, defaultValue: T): T;
}

const DEFAULT_BACKEND: AgentBackend = "codex";

function ensureMixBackends(
	configured: AgentBackend[],
	defaultBackend: AgentBackend,
): AgentBackend[] {
	if (configured.length >= 2) {
		return configured;
	}

	const fallback = [
		defaultBackend,
		...AGENT_BACKENDS.filter((backend) => backend !== defaultBackend),
	];
	return fallback.slice(0, 2);
}

export function isAgentBackend(value: unknown): value is AgentBackend {
	return (
		typeof value === "string" &&
		(AGENT_BACKENDS as readonly string[]).includes(value)
	);
}

function normalizeDefaultBackend(value: unknown): AgentBackend {
	return isAgentBackend(value) ? value : DEFAULT_BACKEND;
}

function normalizeLaunchMode(value: unknown): AgentLaunchMode {
	return value === "mix" ? "mix" : "single";
}

function normalizeMixBackends(value: unknown): AgentBackend[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const seen = new Set<AgentBackend>();
	const normalized: AgentBackend[] = [];
	for (const entry of value) {
		if (!isAgentBackend(entry) || seen.has(entry)) {
			continue;
		}
		seen.add(entry);
		normalized.push(entry);
	}
	return normalized;
}

export function readAgentLaunchPolicy(config: ConfigReader): AgentLaunchPolicy {
	const defaultBackend = normalizeDefaultBackend(
		config.get<unknown>("defaultBackend", DEFAULT_BACKEND),
	);
	const mode = normalizeLaunchMode(config.get<unknown>("launchMode", "single"));
	const configuredMix = normalizeMixBackends(
		config.get<unknown>("mixBackends", ["codex", "gemini"]),
	);

	return {
		mode,
		defaultBackend,
		mixBackends: ensureMixBackends(configuredMix, defaultBackend),
	};
}

export function selectAgentBackend(
	policy: AgentLaunchPolicy,
	random: () => number = Math.random,
): AgentBackend {
	if (policy.mode === "single") {
		return policy.defaultBackend;
	}

	const pool = ensureMixBackends(policy.mixBackends, policy.defaultBackend);
	const rawRoll = random();
	const roll =
		Number.isFinite(rawRoll) && rawRoll >= 0 && rawRoll < 1 ? rawRoll : 0;
	const index = Math.floor(roll * pool.length);
	return pool[index] ?? policy.defaultBackend;
}

function backendDisplayName(backend: AgentBackend): string {
	if (backend === "claude") return "Claude";
	if (backend === "gemini") return "Gemini";
	return "Codex";
}

export function formatAgentLaunchPolicy(policy: AgentLaunchPolicy): string {
	if (policy.mode === "single") {
		return backendDisplayName(policy.defaultBackend);
	}

	const names = ensureMixBackends(policy.mixBackends, policy.defaultBackend)
		.map(backendDisplayName)
		.join("/");
	return `Mix ${names}`;
}

export function buildAgentLaunchPolicyEnv(
	policy: AgentLaunchPolicy,
	selectedBackend: AgentBackend,
): Record<string, string> {
	return {
		OPENCLAW_LAUNCHED_AGENT_BACKEND: selectedBackend,
		OPENCLAW_LAUNCHED_AGENT_POLICY_MODE: policy.mode,
		OPENCLAW_LAUNCHED_AGENT_POLICY_DEFAULT: policy.defaultBackend,
		OPENCLAW_LAUNCHED_AGENT_POLICY_MIX: ensureMixBackends(
			policy.mixBackends,
			policy.defaultBackend,
		).join(","),
	};
}
