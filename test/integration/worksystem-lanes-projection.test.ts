/**
 * Work System lanes projection ingest — transitional bridge compatibility.
 *
 * Cross-repo gap (REVIEW-ghostty-contract-alignment-20260611): the Ghostty
 * Launcher work-system bridge in outbox mode writes the self-describing
 * lanes read-model/projection `{version: 1, kind:
 * "work-system-lanes-projection", lanes: {<lane_ref.id>: <lane_ref_update>},
 * updated_at}` to `~/.config/openclaw/lanes.json` (config@48b3fb3 §6.2),
 * but the default lane registry reader only understood the legacy
 * `{version, tasks: {...}}` registry shape — the projection parsed to zero
 * rows plus a fallback warning.
 *
 * Verifies, against fixtures mirroring the bridge's emitted shape
 * (ghostty-launcher scripts/lib/work-system-bridge.sh +
 * scripts/laneref-update-schema.json):
 *   - a valid projection document ingests without warnings or fallback;
 *   - lane_ref_update envelopes become LaneRef-backed rows grouped by
 *     project_ref.id, preserving status, lane_kind, lane_kind_source,
 *     session/task/worktree ids, source labels, and updated timestamps;
 *   - envelopes with project_ref: null (legacy / resolution-skipped lanes)
 *     stay quarantined — the projection never widens lane-records-only;
 *   - the projection is never authoritative truth: a primary registry
 *     record with the same task id wins the merge regardless of file order;
 *   - unsupported projection versions and malformed lanes collections fall
 *     back to an empty registry with an explicit warning;
 *   - the zero-config default reads the projection from
 *     `~/.config/openclaw/lanes.json`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentNode,
	ProjectGroupNode,
} from "../../src/providers/agent-status-tree-provider.js";
import {
	isValidSessionId,
	WORK_SYSTEM_LANES_PROJECTION_KIND,
} from "../../src/providers/agent-status-tree-provider.js";
import { DEFAULT_LANE_REGISTRY_FILES } from "../../src/utils/tasks-file-resolver.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

type ProviderModule =
	typeof import("../../src/providers/agent-status-tree-provider.js");
type ProviderInstance = InstanceType<ProviderModule["AgentStatusTreeProvider"]>;

const CANONICAL_DIR = "/tmp/projection-fixture/command-central";
const WORKTREE_DIR =
	"/tmp/projection-fixture/command-central-cc-projection-20260611";

/** Registered ProjectRef record as project_ref_record_registered() emits it. */
const REGISTERED_PROJECT_REF = {
	id: "command-central",
	displayName: "Command Central",
	status: "registered",
	registry_status: "active",
	repoOrigins: ["github.com/ostehost/command-central"],
	lanePolicy: null,
	resolution: { method: "directory", input: CANONICAL_DIR, detail: null },
};

/**
 * One lane_ref_update envelope exactly as work_system_lane_ref_update()
 * builds it (see ghostty-launcher scripts/laneref-update-schema.json).
 */
function createLaneRefUpdate(
	taskId: string,
	laneRefOverrides: Record<string, unknown> = {},
	envelopeOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schema_version: 1,
		kind: "lane_ref_update",
		project_ref: REGISTERED_PROJECT_REF,
		lane_ref: {
			id: `launcher:${taskId}`,
			provider: "ghostty-launcher",
			surface: "tmux",
			session: `agent-${taskId}`,
			task: taskId,
			worktree: CANONICAL_DIR,
			lane_kind: "implementation",
			lane_kind_source: null,
			status: "completed",
			updatedAt: "2026-06-11T10:00:00Z",
			...laneRefOverrides,
		},
		work_item_ref: null,
		workroom_ref: null,
		...envelopeOverrides,
	};
}

/**
 * The projection document exactly as work_system_bridge_write_outbox()
 * maintains it: version 1, self-describing kind, lanes keyed by lane_ref.id,
 * document-level updated_at from the last write.
 */
function createProjectionDocument(
	lanes: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		version: 1,
		kind: WORK_SYSTEM_LANES_PROJECTION_KIND,
		lanes,
		updated_at: "2026-06-11T10:00:00Z",
		...overrides,
	};
}

function getProjectGroups(children: AgentNode[]): ProjectGroupNode[] {
	return children.filter(
		(node): node is ProjectGroupNode => node.type === "projectGroup",
	);
}

function getStateLabels(children: AgentNode[]): string[] {
	return children
		.filter(
			(node): node is Extract<AgentNode, { type: "state" }> =>
				node.type === "state",
		)
		.map((node) => node.label);
}

describe("Work System lanes projection ingest (transitional bridge)", () => {
	let tmpDir = "";
	let provider: ProviderInstance | null = null;
	let originalNodeEnv = "";
	let originalTasksFileEnv: string | undefined;
	let originalHomeEnv: string | undefined;
	let warnSpy: ReturnType<typeof mock> | null = null;
	let originalConsoleWarn: typeof console.warn;

	beforeEach(() => {
		mock.restore();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ws-projection-"));
		originalNodeEnv = process.env["NODE_ENV"] ?? "";
		originalTasksFileEnv = process.env["TASKS_FILE"];
		delete process.env["TASKS_FILE"];
		process.env["NODE_ENV"] = "test";
		// Sandbox $HOME so the zero-config default lane registry paths resolve
		// inside the temp dir — never the operator's real registries.
		originalHomeEnv = process.env["HOME"];
		process.env["HOME"] = tmpDir;
		originalConsoleWarn = console.warn;
		warnSpy = mock(() => {});
		console.warn = warnSpy as unknown as typeof console.warn;
	});

	afterEach(() => {
		console.warn = originalConsoleWarn;
		warnSpy = null;
		provider?.dispose();
		provider = null;
		process.env["NODE_ENV"] = originalNodeEnv;
		if (originalTasksFileEnv === undefined) {
			delete process.env["TASKS_FILE"];
		} else {
			process.env["TASKS_FILE"] = originalTasksFileEnv;
		}
		if (originalHomeEnv === undefined) {
			delete process.env["HOME"];
		} else {
			process.env["HOME"] = originalHomeEnv;
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function fallbackWarnings(): string[] {
		return (warnSpy?.mock.calls ?? [])
			.map((call) => String(call[0]))
			.filter((message) => message.includes("Falling back"));
	}

	function writeProjection(
		fileName: string,
		document: Record<string, unknown>,
	): string {
		const projectionPath = path.join(tmpDir, fileName);
		fs.mkdirSync(path.dirname(projectionPath), { recursive: true });
		fs.writeFileSync(projectionPath, JSON.stringify(document));
		return projectionPath;
	}

	/** Legacy `{version, tasks}` registry with a registry-backed LaneRef row. */
	function writeLegacyRegistry(
		fileName: string,
		tasks: Record<string, Record<string, unknown>>,
	): string {
		const registryPath = path.join(tmpDir, fileName);
		fs.mkdirSync(path.dirname(registryPath), { recursive: true });
		fs.writeFileSync(registryPath, JSON.stringify({ version: 2, tasks }));
		return registryPath;
	}

	function createPrimaryLaneRecord(
		id: string,
		overrides: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			id,
			task_id: id,
			status: "completed",
			source_authority: "launcher",
			project_ref: REGISTERED_PROJECT_REF,
			lane_kind: "implementation",
			project_dir: CANONICAL_DIR,
			project_name: "Command Central",
			session_id: `agent-${id}`,
			bundle_path: "/Applications/Projects/command-central.app",
			prompt_file: "/tmp/prompt.md",
			started_at: "2026-06-11T09:00:00Z",
			attempts: 1,
			max_attempts: 3,
			model: "anthropic/claude-fable-5",
			...overrides,
		};
	}

	async function createProvider(options: {
		laneRegistryFiles?: string[];
	}): Promise<ProviderInstance> {
		const vscodeMock = setupVSCodeMock();
		vscodeMock.workspace.getConfiguration = mock((_section?: string) => ({
			get: mock((key: string, defaultValue?: unknown) => {
				if (key === "laneRegistry.files") {
					// Omitting the option simulates an unset user setting: real VS
					// Code returns the package.json default. $HOME is sandboxed to
					// tmpDir, so the default paths resolve inside the fixture dir.
					return options.laneRegistryFiles ?? [...DEFAULT_LANE_REGISTRY_FILES];
				}
				if (key === "agentTasksFile") return "";
				if (key === "legacyLauncherTasks.enabled") return false;
				if (key === "discovery.enabled") return false;
				return defaultValue;
			}),
			update: mock(() => Promise.resolve()),
			inspect: mock(() => undefined),
		}));

		const { AgentStatusTreeProvider } = await import(
			"../../src/providers/agent-status-tree-provider.js"
		);
		provider = new AgentStatusTreeProvider();
		return provider;
	}

	test("bridge-shaped projection ingests without warnings or fallback", async () => {
		const projectionFile = writeProjection(
			"lanes.json",
			createProjectionDocument({
				"launcher:cc-impl-20260611": createLaneRefUpdate("cc-impl-20260611", {
					status: "running",
				}),
				"launcher:cc-review-20260611": createLaneRefUpdate(
					"cc-review-20260611",
					{
						lane_kind: "review",
						lane_kind_source: "release-proof",
						worktree: WORKTREE_DIR,
						status: "completed",
						updatedAt: "2026-06-11T11:30:00Z",
					},
				),
			}),
		);

		const treeProvider = await createProvider({
			laneRegistryFiles: [projectionFile],
		});

		const registry = treeProvider.readRegistry();
		expect(Object.keys(registry.tasks).sort()).toEqual([
			"cc-impl-20260611",
			"cc-review-20260611",
		]);

		// Launcher-native status verbatim — display liveness inference for
		// session-less running rows is a separate concern from the reader.
		const impl = registry.tasks["cc-impl-20260611"];
		expect(impl?.status).toBe("running");
		expect(impl?.task_id).toBe("cc-impl-20260611");
		expect(impl?.session_id).toBe("agent-cc-impl-20260611");
		expect(impl?.lane_kind).toBe("implementation");
		expect(impl?.lane_kind_source).toBeNull();
		expect(impl?.execution_dir).toBe(CANONICAL_DIR);
		expect(impl?.updated_at).toBe("2026-06-11T10:00:00Z");
		expect(impl?.source_authority).toBe("ghostty-launcher");
		expect(impl?.terminal_backend).toBe("tmux");
		expect(impl?.lane_projection).toBe(true);
		expect(impl?.project_ref?.id).toBe("command-central");
		expect(impl?.project_id).toBe("command-central");
		expect(impl?.provenance).toEqual({
			source_ref: "launcher:cc-impl-20260611",
			adapter_kind: WORK_SYSTEM_LANES_PROJECTION_KIND,
		});

		// release-proof retention: canonical kind plus verbatim native kind.
		const review = registry.tasks["cc-review-20260611"];
		expect(review?.status).toBe("completed");
		expect(review?.lane_kind).toBe("review");
		expect(review?.lane_kind_source).toBe("release-proof");
		expect(review?.execution_dir).toBe(WORKTREE_DIR);
		expect(review?.updated_at).toBe("2026-06-11T11:30:00Z");

		expect(fallbackWarnings()).toEqual([]);
	});

	test("launcher attach/visibility evidence is ingested onto the row (consumer contract)", async () => {
		// cc-installed-vsix-dogfood-proof-20260614: CC must consume the launcher's
		// own attach/visibility probe (schema §attach, §visibility) so a row's
		// liveness/visibility truth comes from the executor, not from a session id
		// merely existing. These envelope-level objects were previously dropped.
		const projectionFile = writeProjection(
			"lanes.json",
			createProjectionDocument({
				"launcher:cc-detached-20260614": createLaneRefUpdate(
					"cc-detached-20260614",
					// Session-less running row — nothing for CC to probe locally.
					{ status: "running", session: null },
					{
						attach: {
							backend: "tmux",
							session: null,
							available: false,
							verified_at: "2026-06-14T10:00:00Z",
							reason_if_unavailable: "tmux-session-not-found",
						},
						visibility: {
							verified: false,
							degraded: true,
							reason: "ax_error_osascript_is_not_allowed_assistive_access",
							receipt_present: false,
						},
					},
				),
			}),
		);

		const treeProvider = await createProvider({
			laneRegistryFiles: [projectionFile],
		});
		const task = treeProvider.readRegistry().tasks["cc-detached-20260614"];
		expect(task?.status).toBe("running");
		expect(task?.launcher_attach_available).toBe(false);
		expect(task?.launcher_attach_reason).toBe("tmux-session-not-found");
		expect(task?.launcher_visibility_degraded).toBe(true);
		expect(task?.launcher_visibility_reason).toBe(
			"ax_error_osascript_is_not_allowed_assistive_access",
		);
		// Session-less envelope falls back to launcher:<task_id>, which fails
		// isValidSessionId by construction (the structural unobservable signal).
		expect(task?.session_id).toBe("launcher:cc-detached-20260614");
		expect(isValidSessionId(task?.session_id ?? "")).toBe(false);
		expect(fallbackWarnings()).toEqual([]);
	});

	test("absence of attach/visibility is forward-compatible (null fields, no fallback)", async () => {
		const projectionFile = writeProjection(
			"lanes.json",
			createProjectionDocument({
				"launcher:cc-plain-20260614": createLaneRefUpdate("cc-plain-20260614", {
					status: "running",
				}),
			}),
		);

		const treeProvider = await createProvider({
			laneRegistryFiles: [projectionFile],
		});
		const task = treeProvider.readRegistry().tasks["cc-plain-20260614"];
		expect(task?.status).toBe("running");
		expect(task?.launcher_attach_available).toBeNull();
		expect(task?.launcher_attach_reason).toBeNull();
		expect(task?.launcher_visibility_degraded).toBeNull();
		expect(task?.launcher_visibility_reason).toBeNull();
		expect(fallbackWarnings()).toEqual([]);
	});

	test("projection rows render grouped by project_ref.id", async () => {
		const projectionFile = writeProjection(
			"lanes.json",
			createProjectionDocument({
				"launcher:cc-done-1": createLaneRefUpdate("cc-done-1"),
				"launcher:cc-done-2": createLaneRefUpdate("cc-done-2", {
					lane_kind: "review",
					worktree: WORKTREE_DIR,
				}),
			}),
		);

		const treeProvider = await createProvider({
			laneRegistryFiles: [projectionFile],
		});

		const taskIds = treeProvider.getTasks().map((task) => task.id);
		expect(taskIds.sort()).toEqual(["cc-done-1", "cc-done-2"]);

		const children = treeProvider.getChildren();
		expect(getStateLabels(children)).toEqual([]);

		// Both lanes — canonical dir and worktree — join the single
		// project_ref.id group; no basename/worktree group is fabricated.
		const groups = getProjectGroups(children);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.projectName).toBe("Command Central");
		expect(groups[0]?.tasks).toHaveLength(2);
		expect(groups[0]?.tasks.map((task) => task.lane_kind).sort()).toEqual([
			"implementation",
			"review",
		]);
		expect(fallbackWarnings()).toEqual([]);
	});

	test("zero-config default reads the projection from ~/.config/openclaw/lanes.json", async () => {
		writeProjection(
			path.join(".config", "openclaw", "lanes.json"),
			createProjectionDocument({
				"launcher:cc-zero-config": createLaneRefUpdate("cc-zero-config"),
			}),
		);

		// No laneRegistryFiles: pure default settings.
		const treeProvider = await createProvider({});

		expect(treeProvider.getTasks().map((task) => task.id)).toEqual([
			"cc-zero-config",
		]);
		const groups = getProjectGroups(treeProvider.getChildren());
		expect(groups).toHaveLength(1);
		expect(groups[0]?.projectName).toBe("Command Central");
		expect(fallbackWarnings()).toEqual([]);
	});

	test("envelopes without project_ref stay quarantined — projection never widens lane-records-only", async () => {
		writeProjection(
			path.join(".config", "openclaw", "lanes.json"),
			createProjectionDocument({
				// Legacy / resolution-skipped lane: project_ref is null.
				"launcher:cc-unresolved": createLaneRefUpdate(
					"cc-unresolved",
					{},
					{ project_ref: null },
				),
				// Unregistered lane: project_ref_record_unregistered() has id: null.
				"launcher:cc-unregistered": createLaneRefUpdate(
					"cc-unregistered",
					{},
					{
						project_ref: {
							id: null,
							status: "unregistered",
							reason: "unresolved",
						},
					},
				),
			}),
		);

		const treeProvider = await createProvider({});

		expect(treeProvider.getTasks()).toEqual([]);
		expect(getStateLabels(treeProvider.getChildren())).toEqual([
			"Waiting for agents...",
		]);
	});

	test("a session-less envelope stays visible with a non-actionable placeholder session", async () => {
		const projectionFile = writeProjection(
			"lanes.json",
			createProjectionDocument({
				"launcher:cc-no-session": createLaneRefUpdate("cc-no-session", {
					session: null,
					surface: null,
					worktree: null,
					status: "contract_failure",
				}),
			}),
		);

		const treeProvider = await createProvider({
			laneRegistryFiles: [projectionFile],
		});

		const registry = treeProvider.readRegistry();
		const task = registry.tasks["cc-no-session"];
		expect(task?.status).toBe("contract_failure");
		// The lane_ref.id placeholder fails session validation by construction
		// (contains ":"), so focus actions refuse instead of acting on a
		// fabricated session name.
		expect(task?.session_id).toBe("launcher:cc-no-session");
		expect(isValidSessionId(task?.session_id ?? "")).toBe(false);
		expect(fallbackWarnings()).toEqual([]);
	});

	test("primary registry records win over projection rows for the same task id (default order)", async () => {
		// Outbox-mode dogfood: the launcher still keeps tasks.json primary and
		// mirrors the projection. Default order reads the projection first —
		// the later primary record must replace it, not duplicate it.
		writeProjection(
			path.join(".config", "openclaw", "lanes.json"),
			createProjectionDocument({
				"launcher:cc-shared": createLaneRefUpdate("cc-shared", {
					// Stale LWW artifact: the projection still claims running.
					status: "running",
				}),
			}),
		);
		writeLegacyRegistry(
			path.join(".config", "ghostty-launcher", "tasks.json"),
			{
				"cc-shared": createPrimaryLaneRecord("cc-shared"),
			},
		);

		const treeProvider = await createProvider({});

		const registry = treeProvider.readRegistry();
		expect(Object.keys(registry.tasks)).toEqual(["cc-shared"]);
		const task = registry.tasks["cc-shared"];
		expect(task?.lane_projection).toBeUndefined();
		expect(task?.status).toBe("completed");
		expect(task?.model).toBe("anthropic/claude-fable-5");
		expect(task?.bundle_path).toBe(
			"/Applications/Projects/command-central.app",
		);
	});

	test("projection rows never displace primary records regardless of file order", async () => {
		const primaryFile = writeLegacyRegistry("tasks.json", {
			"cc-shared": createPrimaryLaneRecord("cc-shared"),
		});
		const projectionFile = writeProjection(
			"lanes.json",
			createProjectionDocument({
				"launcher:cc-shared": createLaneRefUpdate("cc-shared", {
					status: "running",
				}),
			}),
		);

		const treeProvider = await createProvider({
			laneRegistryFiles: [primaryFile, projectionFile],
		});

		const registry = treeProvider.readRegistry();
		expect(Object.keys(registry.tasks)).toEqual(["cc-shared"]);
		expect(registry.tasks["cc-shared"]?.lane_projection).toBeUndefined();
		expect(registry.tasks["cc-shared"]?.status).toBe("completed");
	});

	test("unsupported projection versions fall back to empty with a warning", async () => {
		const projectionFile = writeProjection(
			"lanes.json",
			createProjectionDocument(
				{ "launcher:cc-future": createLaneRefUpdate("cc-future") },
				{ version: 2 },
			),
		);

		const treeProvider = await createProvider({
			laneRegistryFiles: [projectionFile],
		});

		expect(treeProvider.readRegistry().tasks).toEqual({});
		// Constructor + explicit readRegistry() both read the file, so assert
		// content, not count.
		const warnings = fallbackWarnings();
		expect(warnings.length).toBeGreaterThan(0);
		for (const warning of warnings) {
			expect(warning).toContain(
				`unsupported ${WORK_SYSTEM_LANES_PROJECTION_KIND} version: 2`,
			);
		}
	});

	test("a projection without a lanes collection falls back to empty with a warning", async () => {
		const projectionFile = writeProjection("lanes.json", {
			version: 1,
			kind: WORK_SYSTEM_LANES_PROJECTION_KIND,
			updated_at: "2026-06-11T10:00:00Z",
		});

		const treeProvider = await createProvider({
			laneRegistryFiles: [projectionFile],
		});

		expect(treeProvider.readRegistry().tasks).toEqual({});
		const warnings = fallbackWarnings();
		expect(warnings.length).toBeGreaterThan(0);
		for (const warning of warnings) {
			expect(warning).toContain("missing a valid lanes collection");
		}
	});

	test("malformed envelopes are skipped without dropping valid siblings", async () => {
		const projectionFile = writeProjection(
			"lanes.json",
			createProjectionDocument({
				"launcher:cc-valid": createLaneRefUpdate("cc-valid"),
				// Not a lane_ref_update envelope.
				"launcher:cc-wrong-kind": { kind: "something-else" },
				// Envelope without a task id.
				"launcher:cc-no-task": createLaneRefUpdate("cc-no-task", {
					task: null,
				}),
				// Not even an object.
				"launcher:cc-scalar": "bogus",
			}),
		);

		const treeProvider = await createProvider({
			laneRegistryFiles: [projectionFile],
		});

		const registry = treeProvider.readRegistry();
		expect(Object.keys(registry.tasks)).toEqual(["cc-valid"]);
		expect(fallbackWarnings()).toEqual([]);
	});
});
