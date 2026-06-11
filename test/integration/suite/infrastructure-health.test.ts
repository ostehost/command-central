import assert from "node:assert/strict";
import { getTestApi } from "./helpers.js";

export const scenarioName = "infrastructure health status bar";

// CC-001: the health item must settle into one of the five evidence-weighted
// states. The exact state depends on the host's real gateway/task state, so
// the proof asserts the rendered text is a truthful member of the new state
// machine — never the legacy three-state output or a stuck spinner.
const SETTLED_TEXT =
	/^\$\((pulse|warning|history|error)\) OpenClaw (OK|WARN|DEGRADED|STALE|DOWN)( \(hub\))?$/;
const WORKING_COUNT = /(\d+) working/;

const SETTLE_DEADLINE_MS = 15_000;
const POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

export async function run(): Promise<void> {
	const testApi = await getTestApi();

	const deadline = Date.now() + SETTLE_DEADLINE_MS;
	let text = testApi.getSnapshot().infrastructureHealthStatusText;
	while (!(text && SETTLED_TEXT.test(text)) && Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
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

	// CC-001 follow-up: the launch fixture (TASKS_FILE) registers one fresh
	// `running` task, so the agent count item must render a working count —
	// the task service is demonstrably alive in this host. Under that
	// evidence the corrected state machine forbids DOWN outright: a failing
	// gateway probe is at most DEGRADED, a healthy one OK/WARN/STALE. This
	// pins the exact contradictory pairing from the bug report (red
	// "OpenClaw DOWN" beside "1 working · 3 done") as unrenderable in a real
	// extension host. A genuine forced gateway outage is deliberately not
	// staged here (it would need the real hub down); the failed-gateway →
	// DEGRADED mapping itself is pinned by the unit state matrix.
	const pairingDeadline = Date.now() + SETTLE_DEADLINE_MS;
	let snapshot = testApi.getSnapshot();
	while (
		!(
			snapshot.agentStatusBarText &&
			WORKING_COUNT.test(snapshot.agentStatusBarText) &&
			snapshot.infrastructureHealthStatusText &&
			SETTLED_TEXT.test(snapshot.infrastructureHealthStatusText)
		) &&
		Date.now() < pairingDeadline
	) {
		await sleep(POLL_INTERVAL_MS);
		snapshot = testApi.getSnapshot();
	}

	const agentText = snapshot.agentStatusBarText;
	assert.ok(
		agentText && WORKING_COUNT.test(agentText),
		`Agent status bar should render the fixture working task, got: ${agentText}`,
	);
	const workingCount = Number(agentText.match(WORKING_COUNT)?.[1]);
	assert.ok(
		workingCount >= 1,
		`Fixture registry guarantees at least one working task, got: ${agentText}`,
	);

	const healthText = snapshot.infrastructureHealthStatusText;
	assert.ok(healthText, "Health item must still be rendered.");
	assert.match(
		healthText,
		SETTLED_TEXT,
		`Health item should stay settled, got: ${healthText}`,
	);
	assert.ok(
		!healthText.includes("DOWN"),
		`Health item must never render DOWN while the agent bar shows ` +
			`${workingCount} working — got "${healthText}" beside "${agentText}"`,
	);
	console.log(`  rendered pairing: "${healthText}" beside "${agentText}"`);
}
