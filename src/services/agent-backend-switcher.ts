import * as vscode from "vscode";

type AgentBackend = "codex" | "gemini";

const BACKEND_CONFIG_SECTION = "commandCentral.agentStatus";
const BACKEND_CONFIG_KEY = "defaultBackend";
const BACKEND_CONFIG_PATH = `${BACKEND_CONFIG_SECTION}.${BACKEND_CONFIG_KEY}`;

function getDefaultBackend(): AgentBackend {
	const config = vscode.workspace.getConfiguration(BACKEND_CONFIG_SECTION);
	const configured = config.get<string>(BACKEND_CONFIG_KEY, "codex");
	return configured === "gemini" ? "gemini" : "codex";
}

export class AgentBackendSwitcher implements vscode.Disposable {
	private readonly statusBarItem: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			100,
		);
		this.statusBarItem.command = "commandCentral.switchAgentBackend";
		this.disposables.push(this.statusBarItem);
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration(BACKEND_CONFIG_PATH)) {
					this.update();
				}
			}),
		);
		this.update();
	}

	private update(): void {
		const backend = getDefaultBackend();
		this.statusBarItem.text = `$(hubot) ${backend === "gemini" ? "Gemini" : "Codex"}`;
		this.statusBarItem.show();
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}
