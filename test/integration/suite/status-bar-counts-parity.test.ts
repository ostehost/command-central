import assert from "node:assert/strict";
import { formatCountSummary } from "../../../src/utils/agent-counts.js";
import { getTestApi } from "./helpers.js";

export const scenarioName = "status bar counts parity with tree engine";

// Regression (2026-07-04): the agent-count status bar item recounted raw
// task.status while the tree grouped through its signal-based engine, so the
// bar showed "3 attention" beside 13 Action Required rows. The contract now
// locked in a real extension host: the bar's rendered text IS
// formatCountSummary over the provider's getUnifiedAgentCounts() — one
// classification engine for both surfaces, no independent recount.

const ICON_PREFIX = /^\$\([a-z0-9~-]+\)\s/;
const SETTLE_DEADLINE_MS = 15_000;
const POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

export async function run(): Promise<void> {
	const testApi = await getTestApi();

	// The launch fixture registers one running task, so the item must render.
	// Poll until the bar text and the tree-engine counts agree — both derive
	// from the same (static) fixture registry, so a persistent mismatch is a
	// real parity break, not a race.
	const deadline = Date.now() + SETTLE_DEADLINE_MS;
	let snapshot = testApi.getSnapshot();
	let expected: string | undefined;
	while (Date.now() < deadline) {
		snapshot = testApi.getSnapshot();
		const counts = snapshot.unifiedAgentCounts;
		if (snapshot.agentStatusBarText && counts) {
			expected = formatCountSummary(counts, { includeAttention: true });
			if (snapshot.agentStatusBarText.replace(ICON_PREFIX, "") === expected) {
				break;
			}
		}
		await sleep(POLL_INTERVAL_MS);
	}

	const counts = snapshot.unifiedAgentCounts;
	assert.ok(
		counts,
		"Snapshot must expose the provider's unified (tree-engine) counts.",
	);
	const barText = snapshot.agentStatusBarText;
	assert.ok(barText, "Agent count item must render for the launch fixture.");

	const rendered = barText.replace(ICON_PREFIX, "");
	assert.notEqual(
		rendered,
		barText,
		`Bar text must carry a codicon prefix, got: ${barText}`,
	);
	assert.equal(
		rendered,
		formatCountSummary(counts, { includeAttention: true }),
		`Bar text must equal formatCountSummary over getUnifiedAgentCounts() ` +
			`(counts: ${JSON.stringify(counts)}), got: ${barText}`,
	);

	// The specific historical failure: an attention figure in the bar that the
	// tree engine did not produce (or vice versa).
	if (counts.attention > 0) {
		assert.ok(
			rendered.includes(`${counts.attention} attention`),
			`Bar must show the tree engine's attention count ${counts.attention}, got: ${barText}`,
		);
	} else {
		assert.ok(
			!rendered.includes("attention"),
			`Bar must not invent an attention figure the tree engine lacks, got: ${barText}`,
		);
	}

	console.log(`  parity: "${barText}" ⇔ ${JSON.stringify(counts)}`);
}
