import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	buildWorkflowRunActionEnvelope,
	getWorkflowRunActionOwner,
} from "../../src/commands/workflow-run-actions.js";
import type { WorkflowRunView } from "../../src/types/codex-run-types.js";

function workflowRun(
	overrides: Partial<WorkflowRunView> = {},
): WorkflowRunView {
	return {
		runId: "run-1",
		title: "Run 1",
		source: { kind: "launcher", id: "launcher-1", path: "/tmp/project-a" },
		mergedFrom: [],
		status: "running",
		ownerKind: "launcher",
		taskId: "task-1",
		flowId: "flow-1",
		sessionKey: "agent:main:main",
		execMode: "spoke",
		execNodeId: "node-1",
		execNodeName: "Mike MacBook Pro",
		callbackPresent: true,
		fieldSources: {},
		...overrides,
	};
}

describe("workflow run action envelopes", () => {
	test("builds a launcher-owned focus terminal envelope from projected run truth", () => {
		const envelope = buildWorkflowRunActionEnvelope(
			workflowRun(),
			"focusTerminal",
		);

		expect(envelope).toEqual({
			sourceRef: { kind: "launcher", id: "launcher-1", path: "/tmp/project-a" },
			action: "focusTerminal",
			ownerKind: "launcher",
			runId: "run-1",
			taskId: "task-1",
			flowId: "flow-1",
			sessionKey: "agent:main:main",
			execMode: "spoke",
			execNodeId: "node-1",
			execNodeName: "Mike MacBook Pro",
		});
		expect(getWorkflowRunActionOwner(envelope)).toBe("launcher");
	});

	test("builds an OpenClaw-owned cancel envelope without direct task-file mutation data", () => {
		const envelope = buildWorkflowRunActionEnvelope(
			workflowRun({
				source: { kind: "openclaw-task", id: "oc-1" },
				ownerKind: "openclaw",
				taskId: "oc-1",
				sessionKey: undefined,
				execMode: "hub",
				execNodeId: undefined,
				execNodeName: undefined,
			}),
			"cancel",
		);

		expect(envelope).toEqual({
			sourceRef: { kind: "openclaw-task", id: "oc-1" },
			action: "cancel",
			ownerKind: "openclaw",
			runId: "run-1",
			taskId: "oc-1",
			flowId: "flow-1",
			execMode: "hub",
		});
		expect(JSON.stringify(envelope)).not.toContain("callback");
		expect(JSON.stringify(envelope)).not.toContain("tasks.json");
	});

	test("rejects ownerless projected rows", () => {
		expect(() =>
			buildWorkflowRunActionEnvelope(
				workflowRun({ ownerKind: undefined }),
				"requestReview",
			),
		).toThrow(/ownerKind/);
	});

	test("rejects unsupported owner/action pairs", () => {
		expect(() =>
			buildWorkflowRunActionEnvelope(
				workflowRun({ ownerKind: "openclaw" }),
				"focusTerminal",
			),
		).toThrow(/focusTerminal/);
	});

	test("action layer remains projection-only and does not write owner state files", () => {
		const source = fs.readFileSync(
			path.join(process.cwd(), "src/commands/workflow-run-actions.ts"),
			"utf8",
		);

		expect(source).not.toContain("writeFile");
		expect(source).not.toContain("tasks.json");
		expect(source).not.toContain("pending-review");
		expect(source).not.toContain("pending-fixup");
	});
});
