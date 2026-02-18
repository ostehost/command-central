/**
 * Minimal VS Code type definitions for testing
 * These match the actual VS Code API structure but avoid importing the module
 */

export interface WorkspaceConfiguration {
	get<T>(section: string, defaultValue?: T): T | undefined;
	has(section: string): boolean;
	update(section: string, value: unknown, target?: boolean): Thenable<void>;
}

export interface WorkspaceFolder {
	uri: Uri;
	name: string;
	index: number;
}

export interface Uri {
	fsPath: string;
	path: string;
	scheme: string;
	authority: string;
	query: string;
	fragment: string;
	with(change: {
		scheme?: string;
		authority?: string;
		path?: string;
		query?: string;
		fragment?: string;
	}): Uri;
	toJSON(): object;
}

export interface OutputChannel {
	append(value: string): void;
	appendLine(value: string): void;
	clear(): void;
	show(preserveFocus?: boolean): void;
	hide(): void;
	dispose(): void;
}

export interface Disposable {
	dispose(): void;
}

export interface ConfigurationChangeEvent {
	affectsConfiguration(section: string, scope?: Uri): boolean;
}

export interface ConfigurationScope {
	uri?: Uri;
	languageId?: string;
}

export type VSCodeWorkspace = {
	getConfiguration(
		section?: string,
		scope?: ConfigurationScope | Uri | null,
	): WorkspaceConfiguration;
	workspaceFolders?: readonly WorkspaceFolder[];
	onDidChangeConfiguration(
		listener: (e: ConfigurationChangeEvent) => void,
	): Disposable;
	isTrusted?: boolean;
};

export interface MessageOptions {
	modal?: boolean;
	detail?: string;
}

export interface InputBoxOptions {
	prompt?: string;
	value?: string;
	placeHolder?: string;
	password?: boolean;
	ignorefocusOut?: boolean;
	validateInput?: (
		value: string,
	) => string | undefined | null | Thenable<string | undefined | null>;
}

export interface QuickPickItem {
	label: string;
	description?: string;
	detail?: string;
	picked?: boolean;
	alwaysShow?: boolean;
}

export interface QuickPickOptions {
	placeHolder?: string;
	ignorefocusOut?: boolean;
	matchOnDescription?: boolean;
	matchOnDetail?: boolean;
	canPickMany?: boolean;
}

export type VSCodeWindow = {
	showErrorMessage(
		message: string,
		...items: Array<MessageOptions | string>
	): Thenable<string | undefined>;
	showWarningMessage(
		message: string,
		...items: Array<MessageOptions | string>
	): Thenable<string | undefined>;
	showInformationMessage(
		message: string,
		...items: Array<MessageOptions | string>
	): Thenable<string | undefined>;
	showInputBox(options?: InputBoxOptions): Thenable<string | undefined>;
	showQuickPick<T extends QuickPickItem>(
		items: T[],
		options?: QuickPickOptions,
	): Thenable<T | undefined>;
	createOutputChannel(name: string, languageId?: string): OutputChannel;
};

export type VSCodeCommands = {
	executeCommand<T = unknown>(command: string, ...args: unknown[]): Thenable<T>;
	registerCommand(
		command: string,
		callback: (...args: unknown[]) => unknown,
	): Disposable;
};
