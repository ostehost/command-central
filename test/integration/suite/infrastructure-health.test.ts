import assert from "node:assert/strict";
import { getTestApi } from "./helpers.js";

export const scenarioName = "infrastructure health status bar";

// CC-001: the health item must settle into one of the five evidence-weighted
// states. The exact state depends on the host's real gateway/task state, so
// the proof asserts the rendered text is a truthful member of the new state
// machine — never the legacy three-state output or a stuck spinner.
const SETTLED_TEXT =
	/^\$\((pulse|warning|history|error)\) OpenClaw (OK|WARN|DEGRADED|STALE|DOWN)( \(hub\))?$/;

const SETTLE_DEADLINE_MS = 15_000;
const POLL_INTERVAL_MS = 250;

export async function run(): Promise<void> {
	const testApi = await getTestApi();

	const deadline = Date.now() + SETTLE_DEADLINE_MS;
	let text = testApi.getSnapshot().infrastructureHealthStatusText;
	while (!(text && SETTLED_TEXT.test(text)) && Date.now() < deadline) {
		await new Promise<void>((resolve) => {
			setTimeout(resolve, POLL_INTERVAL_MS);
		});
		text = testApi.getSnapshot().infrastructureHealthStatusText;
	}

	assert.ok(
		text,
		"Activation should create the infrastructure health status bar item.",
	);
	assert.match(
		text,
		SETTLED_TEXT,
		`Status bar should settle into ok/warn/degraded/stale/down, got: ${text}`,
	);

	const state = text.match(SETTLED_TEXT)?.[2];
	assert.ok(
		["OK", "WARN", "DEGRADED", "STALE", "DOWN"].includes(state ?? ""),
		`Rendered state must be one of the five display states, got: ${state}`,
	);
	console.log(`  rendered: ${text}`);
}
