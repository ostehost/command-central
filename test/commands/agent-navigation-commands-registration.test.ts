/**
 * Registration-shape test for the agent navigation activation module.
 *
 * Encodes the extraction contract for
 * src/activation/register-agent-navigation-commands.ts: the exact command-ID
 * set (each contributed in package.json), one disposable per command, and
 * real-handler delegation through the lazy getter deps —
 * AgentStatusTreeProvider and TerminalManager are resettable module state in
 * extension.ts, so handlers must re-resolve the getters on every invocation
 * and degrade gracefully while a dependency is missing.
 *
 * Routing commands (defaultAgentAction, toggleProjectGroupingFlat,
 * focusNextRunningAgent, agentStatus.focus) are proven against the real
 * handlers via the executeCommand spy, and listWorktrees runs against a real
 * temp git repository. Supersedes the former focusNextRunningAgent /
 * openAgentDashboard / openAgentDirectory / changeProjectIcon /
 * defaultAgentAction simulation blocks in extension-commands.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../../package.json";
import { createVSCodeMock } from "../helpers/vscode-mock.js";

const vscodeMock = createVSCodeMock();
mock.module("vscode", () => vscodeMock);

// Earlier suites in a mixed run install process-global
// mock.module("node:child_process") / ("node:fs") overrides that survive
// mock.restore() (e.g. test/utils/port-detector.test.ts fakes execFile with
// empty output). listWorktrees runs real git and the suite builds real temp
// repos, so re-pin the preload-stashed real modules before every test (see
// test/setup/global-test-cleanup.ts).
const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");
const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof import("node:fs");

beforeEach(() => {
	mock.module("node:child_process", () => realChildProcess);
	mock.module("node:fs", () => realFs);
});

const { registerAgentNavigationCommands } = await import(
	"../../src/activation/register-agent-navigation-commands.js"
);
type AgentNavigationCommandDeps = Parameters<
	typeof registerAgentNavigationCommands
>[0];

const EXPECTED_COMMAND_IDS = [
	"commandCentral.openAgentDashboard",
	"commandCentral.defaultAgentAction",
	"commandCentral.agentStatus.focus",
	"commandCentral.refreshAgentStatus",
	"commandCentral.showDiscoveryDiagnostics",
	"commandCentral.changeProjectIcon",
	"commandCentral.toggleProjectGrouping",
	"commandCentral.toggleProjectGroupingFlat",
	"commandCentral.filterToProject",
	"commandCentral.filterCurrentProject",
	"commandCentral.clearProjectFilter",
	"commandCentral.selectProjectFilter",
	"commandCentral.focusNextRunningAgent",
	"commandCentral.openAgentDirectory",
	"commandCentral.listWorktrees",
];

interface ProviderMock {
	getDisplayRegistryTasks: ReturnType<typeof mock>;
	getTasks: ReturnType<typeof mock>;
	reload: ReturnType<typeof mock>;
	getDiscoveryDiagnosticsReport: ReturnType<typeof mock>;
	projectFilter: string | null;
	filterToProject: ReturnType<typeof mock>;
	filterToCurrentProject: ReturnType<typeof mock>;
	getKnownProjectDirs: ReturnType<typeof mock>;
}

function makeProvider(overrides: Partial<ProviderMock> = {}): ProviderMock {
	return {
		getDisplayRegistryTasks: mock(() => ({})),
		getTasks: mock(() => []),
		reload: mock(),
		getDiscoveryDiagnosticsReport: mock(() => "diagnostics report"),
		projectFilter: null,
		filterToProject: mock(),
		filterToCurrentProject: mock(),
		getKnownProjectDirs: mock(() => []),
		...overrides,
	};
}

describe("registerAgentNavigationCommands", () => {
	let registered: Map<string, (...args: unknown[]) => unknown>;
	let provider: ProviderMock | undefined;
	let terminalManager:
		| {
				isLauncherInstalled: ReturnType<typeof mock>;
				createProjectTerminal: ReturnType<typeof mock>;
		  }
		| undefined;
	let projectIconManager: {
		getIconForProject: ReturnType<typeof mock>;
		setCustomIcon: ReturnType<typeof mock>;
	};
	let agentDashboardPanel: { show: ReturnType<typeof mock> };
	let discoveryDiagnosticsChannel: {
		clear: ReturnType<typeof mock>;
		appendLine: ReturnType<typeof mock>;
		show: ReturnType<typeof mock>;
	};
	let syncAgentStatusViewContexts: ReturnType<typeof mock>;
	let logger: { warn: ReturnType<typeof mock> };
	let deps: AgentNavigationCommandDeps;
	let tmpDirs: string[];
	let savedWorkspaceFolders: typeof vscodeMock.workspace.workspaceFolders;

	beforeEach(() => {
		registered = new Map();
		vscodeMock.commands.registerCommand = mock(
			(id: string, handler: (...args: unknown[]) => unknown) => {
				registered.set(id, handler);
				return { dispose: mock() };
			},
		);
		vscodeMock.commands.executeCommand = mock((..._args: unknown[]) =>
			Promise.resolve(),
		);
		vscodeMock.window.showErrorMessage = mock();
		vscodeMock.window.showWarningMessage = mock(() =>
			Promise.resolve(undefined),
		);
		vscodeMock.window.showInformationMessage = mock(() =>
			Promise.resolve(undefined),
		);
		vscodeMock.window.showInputBox = mock(() => Promise.resolve(undefined));
		vscodeMock.window.showQuickPick = mock(() => Promise.resolve(undefined));
		savedWorkspaceFolders = vscodeMock.workspace.workspaceFolders;
		provider = undefined;
		terminalManager = undefined;
		projectIconManager = {
			getIconForProject: mock(() => "🔧"),
			setCustomIcon: mock(() => Promise.resolve()),
		};
		agentDashboardPanel = { show: mock() };
		discoveryDiagnosticsChannel = {
			clear: mock(),
			appendLine: mock(),
			show: mock(),
		};
		syncAgentStatusViewContexts = mock(() => Promise.resolve());
		logger = { warn: mock() };
		deps = {
			getAgentStatusProvider: () => provider,
			getTerminalManager: () => terminalManager,
			projectIconManager,
			agentDashboardPanel,
			discoveryDiagnosticsChannel,
			syncAgentStatusViewContexts,
			logger,
		} as unknown as AgentNavigationCommandDeps;
		tmpDirs = [];
	});

	afterEach(() => {
		vscodeMock.workspace.workspaceFolders = savedWorkspaceFolders;
		for (const dir of tmpDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function handler(id: string): (...args: unknown[]) => unknown {
		const h = registered.get(id);
		if (!h) throw new Error(`Command not registered: ${id}`);
		return h;
	}

	function makeGitRepo(): string {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "agent-navigation-commands-test-"),
		);
		tmpDirs.push(dir);
		const env = {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		};
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
		execFileSync(
			"git",
			[
				"-c",
				"user.email=test@test.invalid",
				"-c",
				"user.name=test",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"init",
			],
			{ cwd: dir, env },
		);
		return dir;
	}

	test("registers exactly the agent navigation command IDs, in order, one disposable each", () => {
		const disposables = registerAgentNavigationCommands(deps);

		expect([...registered.keys()]).toEqual(EXPECTED_COMMAND_IDS);
		expect(disposables).toHaveLength(EXPECTED_COMMAND_IDS.length);
		for (const disposable of disposables) {
			expect(typeof disposable.dispose).toBe("function");
		}
	});

	test("every registered command is contributed in package.json", () => {
		registerAgentNavigationCommands(deps);

		const contributed = packageJson.contributes.commands.map(
			(c: { command: string }) => c.command,
		);
		for (const id of registered.keys()) {
			expect(contributed).toContain(id);
		}
	});

	test("openAgentDashboard shows an empty registry while the provider is missing — lazy getter contract", () => {
		registerAgentNavigationCommands(deps);

		handler("commandCentral.openAgentDashboard")();

		expect(agentDashboardPanel.show).toHaveBeenCalledWith({});
	});

	test("openAgentDashboard shows the provider's display registry tasks", () => {
		// Register while the getter still returns undefined; assign afterwards
		// to prove the handler re-resolves it at invocation time.
		registerAgentNavigationCommands(deps);
		const tasks = { "task-1": { id: "task-1", status: "running" } };
		provider = makeProvider({
			getDisplayRegistryTasks: mock(() => tasks),
		});

		handler("commandCentral.openAgentDashboard")();

		expect(agentDashboardPanel.show).toHaveBeenCalledWith(tasks);
	});

	test("defaultAgentAction is a no-op when no node is provided", async () => {
		registerAgentNavigationCommands(deps);

		await handler("commandCentral.defaultAgentAction")();

		expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
	});

	test("defaultAgentAction routes discovered agents (no task) to focusAgentTerminal", async () => {
		registerAgentNavigationCommands(deps);
		const node = {
			type: "discovered",
			agent: { projectDir: "/tmp/project", sessionId: "sess-1" },
		};

		await handler("commandCentral.defaultAgentAction")(node);

		expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
			"commandCentral.focusAgentTerminal",
			node,
		);
	});

	test("defaultAgentAction routes running tasks to focusAgentTerminal", async () => {
		registerAgentNavigationCommands(deps);
		const node = { type: "task", task: { id: "t1", status: "running" } };

		await handler("commandCentral.defaultAgentAction")(node);

		expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
			"commandCentral.focusAgentTerminal",
			node,
		);
	});

	for (const status of [
		"completed",
		"completed_dirty",
		"completed_stale",
		"failed",
		"stopped",
		"killed",
		"contract_failure",
	]) {
		test(`defaultAgentAction routes ${status} tasks to viewAgentDiff`, async () => {
			registerAgentNavigationCommands(deps);
			const node = { type: "task", task: { id: "t1", status } };

			await handler("commandCentral.defaultAgentAction")(node);

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"commandCentral.viewAgentDiff",
				node,
			);
		});
	}

	test("agentStatus.focus focuses the Command Central view container", () => {
		registerAgentNavigationCommands(deps);

		handler("commandCentral.agentStatus.focus")();

		expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
			"workbench.view.extension.commandCentral",
		);
	});

	test("refreshAgentStatus reloads the provider and is a no-op while it is missing", () => {
		registerAgentNavigationCommands(deps);

		// Provider missing: graceful no-op, no crash.
		handler("commandCentral.refreshAgentStatus")();

		provider = makeProvider();
		handler("commandCentral.refreshAgentStatus")();

		expect(provider.reload).toHaveBeenCalledTimes(1);
	});

	test("showDiscoveryDiagnostics is a no-op while the provider is missing", () => {
		registerAgentNavigationCommands(deps);

		handler("commandCentral.showDiscoveryDiagnostics")();

		expect(discoveryDiagnosticsChannel.clear).not.toHaveBeenCalled();
		expect(discoveryDiagnosticsChannel.show).not.toHaveBeenCalled();
	});

	test("showDiscoveryDiagnostics writes the provider report to the channel", () => {
		registerAgentNavigationCommands(deps);
		provider = makeProvider({
			getDiscoveryDiagnosticsReport: mock(() => "report body"),
		});

		handler("commandCentral.showDiscoveryDiagnostics")();

		expect(discoveryDiagnosticsChannel.clear).toHaveBeenCalled();
		expect(discoveryDiagnosticsChannel.appendLine).toHaveBeenCalledWith(
			"report body",
		);
		expect(discoveryDiagnosticsChannel.show).toHaveBeenCalledWith(true);
	});

	test("changeProjectIcon warns when no node is provided", async () => {
		registerAgentNavigationCommands(deps);

		await handler("commandCentral.changeProjectIcon")();

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No project selected. Right-click a project group in the tree.",
		);
	});

	test("changeProjectIcon errors when the group has no project directory", async () => {
		registerAgentNavigationCommands(deps);

		await handler("commandCentral.changeProjectIcon")({
			projectName: "mystery",
			projectDir: "",
			tasks: [],
		});

		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Unable to determine project directory for this group.",
		);
	});

	test("changeProjectIcon validates input with the real icon validator", async () => {
		registerAgentNavigationCommands(deps);
		let capturedOptions:
			| { validateInput?: (value: string) => string | undefined }
			| undefined;
		vscodeMock.window.showInputBox = mock((options: unknown) => {
			capturedOptions = options as typeof capturedOptions;
			return Promise.resolve(undefined);
		});

		await handler("commandCentral.changeProjectIcon")({
			projectName: "proj",
			projectDir: "/tmp/proj",
			tasks: [],
		});

		const validate = capturedOptions?.validateInput;
		if (!validate) throw new Error("validateInput not passed to showInputBox");
		expect(validate("🚀")).toBeUndefined();
		expect(validate("AI")).toBeUndefined();
		expect(validate("API")).toBe(
			"Enter an emoji, or a 1-2 character short icon.",
		);
		expect(validate("  ")).toBe(
			"Enter an emoji, or a 1-2 character short icon.",
		);
		// Dismissed input box: no mutation happened.
		expect(projectIconManager.setCustomIcon).not.toHaveBeenCalled();
	});

	test("changeProjectIcon persists the icon and reloads the provider — getters resolved at invocation", async () => {
		registerAgentNavigationCommands(deps);
		provider = makeProvider();
		vscodeMock.window.showInputBox = mock(() => Promise.resolve("🚀"));

		await handler("commandCentral.changeProjectIcon")({
			projectName: "proj",
			projectDir: "/tmp/proj",
			tasks: [],
		});

		expect(projectIconManager.getIconForProject).toHaveBeenCalledWith(
			"/tmp/proj",
		);
		expect(projectIconManager.setCustomIcon).toHaveBeenCalledWith(
			"/tmp/proj",
			"🚀",
		);
		// terminalManager missing → bundle refresh is silently skipped.
		expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
		expect(provider.reload).toHaveBeenCalled();
	});

	test("changeProjectIcon surfaces a launcher-unavailable warning from the real bundle refresh", async () => {
		registerAgentNavigationCommands(deps);
		provider = makeProvider();
		terminalManager = {
			isLauncherInstalled: mock(() => Promise.resolve(false)),
			createProjectTerminal: mock(() => Promise.resolve()),
		};
		vscodeMock.window.showInputBox = mock(() => Promise.resolve("🚀"));

		await handler("commandCentral.changeProjectIcon")({
			projectName: "proj",
			projectDir: "/tmp/proj",
			tasks: [],
		});

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"Project icon was saved, but Ghostty launcher is unavailable, so the .app bundle icon was not refreshed.",
		);
		expect(logger.warn).toHaveBeenCalled();
		expect(provider.reload).toHaveBeenCalled();
	});

	test("changeProjectIcon rejects an invalid trimmed icon after input", async () => {
		registerAgentNavigationCommands(deps);
		provider = makeProvider();
		vscodeMock.window.showInputBox = mock(() => Promise.resolve("ABCD"));

		await handler("commandCentral.changeProjectIcon")({
			projectName: "proj",
			projectDir: "/tmp/proj",
			tasks: [],
		});

		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Icon must be an emoji, or a 1-2 character short icon.",
		);
		expect(projectIconManager.setCustomIcon).not.toHaveBeenCalled();
	});

	test("toggleProjectGrouping flips the setting, syncs contexts, and reloads", async () => {
		registerAgentNavigationCommands(deps);
		provider = makeProvider();
		const update = mock(() => Promise.resolve());
		vscodeMock.workspace.getConfiguration = mock(() => ({
			get: mock((_key: string, defaultValue?: unknown) => defaultValue),
			update,
		})) as typeof vscodeMock.workspace.getConfiguration;

		await handler("commandCentral.toggleProjectGrouping")();

		expect(update).toHaveBeenCalledWith(
			"agentStatus.groupByProject",
			false,
			vscodeMock.ConfigurationTarget.Global,
		);
		expect(syncAgentStatusViewContexts).toHaveBeenCalled();
		expect(provider.reload).toHaveBeenCalled();
	});

	test("toggleProjectGroupingFlat delegates to toggleProjectGrouping", async () => {
		registerAgentNavigationCommands(deps);

		await handler("commandCentral.toggleProjectGroupingFlat")();

		expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
			"commandCentral.toggleProjectGrouping",
		);
	});

	test("filterToProject is a no-op while the provider is missing", () => {
		registerAgentNavigationCommands(deps);

		handler("commandCentral.filterToProject")({
			projectName: "proj",
			projectDir: "/tmp/proj",
			tasks: [],
		});
		// No provider → nothing to assert beyond "did not crash".
	});

	test("filterToProject toggles the project filter on and off", () => {
		registerAgentNavigationCommands(deps);
		provider = makeProvider({ projectFilter: null });
		const node = { projectName: "proj", projectDir: "/tmp/proj", tasks: [] };

		handler("commandCentral.filterToProject")(node);
		expect(provider.filterToProject).toHaveBeenCalledWith("/tmp/proj");

		provider = makeProvider({ projectFilter: "/tmp/proj" });
		handler("commandCentral.filterToProject")(node);
		expect(provider.filterToProject).toHaveBeenCalledWith(null);
	});

	test("filterCurrentProject delegates to the provider and tolerates it missing", () => {
		registerAgentNavigationCommands(deps);

		handler("commandCentral.filterCurrentProject")();

		provider = makeProvider();
		handler("commandCentral.filterCurrentProject")();

		expect(provider.filterToCurrentProject).toHaveBeenCalledTimes(1);
	});

	test("clearProjectFilter clears the filter via the provider", () => {
		registerAgentNavigationCommands(deps);
		provider = makeProvider();

		handler("commandCentral.clearProjectFilter")();

		expect(provider.filterToProject).toHaveBeenCalledWith(null);
	});

	test("selectProjectFilter reports when no agent projects are known", async () => {
		registerAgentNavigationCommands(deps);
		provider = makeProvider({ getKnownProjectDirs: mock(() => []) });

		await handler("commandCentral.selectProjectFilter")();

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"No agent projects found.",
		);
		expect(vscodeMock.window.showQuickPick).not.toHaveBeenCalled();
	});

	test("selectProjectFilter applies the picked project filter", async () => {
		registerAgentNavigationCommands(deps);
		provider = makeProvider({
			getKnownProjectDirs: mock(() => ["/tmp/alpha", "/tmp/beta"]),
		});
		vscodeMock.window.showQuickPick = mock(
			(items: Array<{ projectDir: string | null }>) =>
				Promise.resolve(items[2]),
		) as typeof vscodeMock.window.showQuickPick;

		await handler("commandCentral.selectProjectFilter")();

		expect(provider.filterToProject).toHaveBeenCalledWith("/tmp/beta");
	});

	test("focusNextRunningAgent focuses the first running task's terminal", async () => {
		registerAgentNavigationCommands(deps);
		const running = { id: "t2", status: "running" };
		provider = makeProvider({
			getTasks: mock(() => [{ id: "t1", status: "completed" }, running]),
		});

		await handler("commandCentral.focusNextRunningAgent")();

		expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
			"commandCentral.focusAgentTerminal",
			{ type: "task", task: running },
		);
	});

	test("focusNextRunningAgent reports when nothing is running — including provider missing", async () => {
		registerAgentNavigationCommands(deps);

		await handler("commandCentral.focusNextRunningAgent")();

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"No running agents",
		);
		expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
	});

	test("openAgentDirectory warns when no node is provided", async () => {
		registerAgentNavigationCommands(deps);

		await handler("commandCentral.openAgentDirectory")();

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No agent selected. Right-click an agent in the tree.",
		);
	});

	test("openAgentDirectory reveals the project directory in the OS file manager", async () => {
		registerAgentNavigationCommands(deps);

		await handler("commandCentral.openAgentDirectory")({
			type: "task",
			task: { id: "t1", project_dir: "/tmp/agent-dir" },
		});

		expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
			"revealFileInOS",
			expect.objectContaining({ fsPath: "/tmp/agent-dir" }),
		);
	});

	test("listWorktrees warns when no workspace folder is open", async () => {
		registerAgentNavigationCommands(deps);
		vscodeMock.workspace.workspaceFolders = [];

		await handler("commandCentral.listWorktrees")();

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No workspace folder open.",
		);
	});

	test("listWorktrees lists worktrees of a real git repository", async () => {
		registerAgentNavigationCommands(deps);
		const repo = makeGitRepo();
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: repo }, name: "repo", index: 0 },
		];
		let capturedItems:
			| Array<{ label: string; description: string }>
			| undefined;
		vscodeMock.window.showQuickPick = mock((items: unknown) => {
			capturedItems = items as typeof capturedItems;
			return Promise.resolve(undefined);
		}) as typeof vscodeMock.window.showQuickPick;

		await handler("commandCentral.listWorktrees")();

		expect(capturedItems).toBeDefined();
		expect(capturedItems).toHaveLength(1);
		expect(capturedItems?.[0]?.label).toBe("main");
		expect(capturedItems?.[0]?.description).toBe(fs.realpathSync(repo));
		expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
		// Picker dismissed → no folder open.
		expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
	});

	test("listWorktrees surfaces git failures as a user-facing error", async () => {
		registerAgentNavigationCommands(deps);
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/nonexistent/not-a-repo" }, name: "repo", index: 0 },
		];

		await handler("commandCentral.listWorktrees")();

		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("Failed to list git worktrees:"),
		);
	});
});
