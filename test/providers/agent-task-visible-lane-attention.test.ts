/**
 * PAR-323: project OpenClaw/Symphony-native visible-lane attention receipts.
 *
 * symphony-daemon owns a durable receipt vocabulary for a visible lane's
 * attention state (`visible_lane.awaiting_input` / `visible_lane.attention`).
 * Command Central PROJECTS that verdict — it is never the source of truth for
 * lane lifecycle state — through the `visible_lane_attention` field on
 * AgentTask.
 *
 * This suite pins the PURE seam (no VS Code, no provider): the ingest
 * normalizers carry the native field across both registry shapes (launcher
 * `{tasks}` rows and `work-system-lanes-projection` envelopes), fail-closed on
 * unrecognized tokens, and the {@link classifyVisibleLaneAttention} projector
 * maps them to the two deliberately-distinct render surfaces. The provider-level
 * rendering semantics are pinned separately in
 * test/tree-view/agent-status-native-lane-attention.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { classifyVisibleLaneAttention } from "../../src/providers/agent-task-classification.js";
import {
	normalizeProjectionLanes,
	normalizeTask,
} from "../../src/providers/agent-task-normalize.js";

describe("PAR-323 — classifyVisibleLaneAttention (pure projector)", () => {
	test("projects the daemon's awaiting_input verdict verbatim", () => {
		expect(
			classifyVisibleLaneAttention({
				visible_lane_attention: "awaiting_input",
			}),
		).toBe("awaiting_input");
	});

	test("projects the daemon's attention verdict verbatim", () => {
		expect(
			classifyVisibleLaneAttention({ visible_lane_attention: "attention" }),
		).toBe("attention");
	});

	test("no claim (null / undefined) projects nothing — pane heuristic stays the fallback", () => {
		expect(
			classifyVisibleLaneAttention({ visible_lane_attention: null }),
		).toBeNull();
		expect(classifyVisibleLaneAttention({})).toBeNull();
	});

	test("an unrecognized token fails closed — never invents attention", () => {
		expect(
			classifyVisibleLaneAttention({
				visible_lane_attention: "launched" as unknown as never,
			}),
		).toBeNull();
	});
});

describe("PAR-323 — launcher registry ingest carries the native field", () => {
	test("a valid awaiting_input receipt + reason round-trips through normalizeTask", () => {
		const normalized = normalizeTask("lane-1", {
			id: "lane-1",
			session_id: "session-1",
			status: "running",
			project_dir: "/repo",
			visible_lane_attention: "awaiting_input",
			visible_lane_attention_reason: "permission_prompt:bash",
		});
		expect(normalized?.visible_lane_attention).toBe("awaiting_input");
		expect(normalized?.visible_lane_attention_reason).toBe(
			"permission_prompt:bash",
		);
	});

	test("an attention receipt round-trips distinctly from awaiting_input", () => {
		const normalized = normalizeTask("lane-2", {
			id: "lane-2",
			session_id: "session-2",
			status: "running",
			project_dir: "/repo",
			visible_lane_attention: "attention",
			visible_lane_attention_reason: "ax_error_focus_lost",
		});
		expect(normalized?.visible_lane_attention).toBe("attention");
		expect(normalized?.visible_lane_attention_reason).toBe(
			"ax_error_focus_lost",
		);
	});

	test("no native field → null (absent, not fabricated)", () => {
		const normalized = normalizeTask("lane-3", {
			id: "lane-3",
			session_id: "session-3",
			status: "running",
			project_dir: "/repo",
		});
		expect(normalized?.visible_lane_attention).toBeNull();
		expect(normalized?.visible_lane_attention_reason).toBeNull();
	});

	test("an unrecognized upstream token is quarantined to null on ingest", () => {
		const normalized = normalizeTask("lane-4", {
			id: "lane-4",
			session_id: "session-4",
			status: "running",
			project_dir: "/repo",
			visible_lane_attention: "totally_bogus",
		});
		expect(normalized?.visible_lane_attention).toBeNull();
	});
});

describe("PAR-323 — projection-envelope ingest carries the native field", () => {
	function projectionEnvelope(
		attention: Record<string, unknown>,
	): Record<string, unknown> {
		return {
			"launcher:lane-p": {
				kind: "lane_ref_update",
				lane_ref: {
					id: "launcher:lane-p",
					task: "lane-p",
					status: "running",
					session: "session-p",
					worktree: "/repo",
					updatedAt: "2026-07-03T18:00:00.000Z",
				},
				project_ref: { id: "project-p" },
				...attention,
			},
		};
	}

	test("flat visible_lane_attention + reason on the envelope", () => {
		const lanes = normalizeProjectionLanes(
			projectionEnvelope({
				visible_lane_attention: "awaiting_input",
				visible_lane_attention_reason: "numbered_permission_selector",
			}),
		);
		const row = lanes?.["launcher:lane-p"];
		expect(row?.lane_projection).toBe(true);
		expect(row?.visible_lane_attention).toBe("awaiting_input");
		expect(row?.visible_lane_attention_reason).toBe(
			"numbered_permission_selector",
		);
	});

	test("structured { kind, reason } attention object on the envelope", () => {
		const lanes = normalizeProjectionLanes(
			projectionEnvelope({
				visible_lane_attention: {
					kind: "attention",
					reason: "tmux_stream_stale",
				},
			}),
		);
		const row = lanes?.["launcher:lane-p"];
		expect(row?.visible_lane_attention).toBe("attention");
		expect(row?.visible_lane_attention_reason).toBe("tmux_stream_stale");
	});

	test("no attention claim on the envelope → null (projection is not authoritative for lifecycle)", () => {
		const lanes = normalizeProjectionLanes(projectionEnvelope({}));
		const row = lanes?.["launcher:lane-p"];
		expect(row?.visible_lane_attention).toBeNull();
		expect(row?.visible_lane_attention_reason).toBeNull();
	});
});
