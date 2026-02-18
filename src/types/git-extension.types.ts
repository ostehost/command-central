/**
 * Git Extension API Types
 *
 * These are minimal type definitions for the VS Code Git extension API.
 * Based on the actual usage in this codebase.
 *
 * The official Git extension doesn't publish types, so we define the minimal
 * interface we actually use.
 */

import type * as vscode from "vscode";

/**
 * The API exposed by the Git extension
 */
export interface GitExtensionAPI {
	getAPI(version: 1): GitAPI;
}

/**
 * The main Git API interface
 */
export interface GitAPI {
	readonly repositories: Repository[];

	onDidChangeState(callback: () => void): vscode.Disposable;
	onDidOpenRepository(callback: (repo: Repository) => void): vscode.Disposable;
	onDidCloseRepository(callback: () => void): vscode.Disposable;
}

/**
 * A Git repository
 */
export interface Repository {
	readonly state: RepositoryState;
	readonly rootUri: vscode.Uri;

	// Methods
	status(): Promise<void>;
	diffWithHEAD(): Promise<Change[]>;
	diffWith(ref: string): Promise<Change[]>;
	// Additional methods may be available depending on Git extension version
}

/**
 * The state of a Git repository
 */
export interface RepositoryState {
	readonly HEAD: Branch | undefined;
	readonly refs: Ref[];
	readonly remotes: Remote[];
	readonly submodules: Submodule[];
	readonly rebaseCommit: Commit | undefined;
	readonly mergeChanges: Change[];
	readonly indexChanges: Change[];
	readonly workingTreeChanges: Change[];

	onDidChange(callback: () => void): vscode.Disposable;

	// Allow index access for change groups
	[key: string]: unknown;
}

/**
 * A Git change (VS Code 1.40+)
 *
 * Note: Older versions (pre-1.40) had a 'resource' property which has been removed.
 * We require VS Code 1.100+, so only the modern API is supported.
 */
export interface Change {
	readonly uri: vscode.Uri;
	readonly originalUri: vscode.Uri;
	readonly renameUri: vscode.Uri | undefined;
	readonly status: Status;
}

/**
 * Git status codes
 */
export enum Status {
	INDEX_MODIFIED,
	INDEX_ADDED,
	INDEX_DELETED,
	INDEX_RENAMED,
	INDEX_COPIED,

	MODIFIED,
	DELETED,
	UNTRACKED,
	IGNORED,
	ADDED_BY_US,
	ADDED_BY_THEM,
	DELETED_BY_US,
	DELETED_BY_THEM,
	BOTH_ADDED,
	BOTH_DELETED,
	BOTH_MODIFIED,
}

export interface Branch {
	readonly name: string;
	readonly commit: string | undefined;
	readonly type: RefType;
	readonly remote: string | undefined;
	readonly upstream: Branch | undefined;
}

export interface Ref {
	readonly type: RefType;
	readonly name: string;
	readonly commit: string | undefined;
}

export interface Remote {
	readonly name: string;
	readonly fetchUrl: string | undefined;
	readonly pushUrl: string | undefined;
}

export interface Submodule {
	readonly name: string;
	readonly path: string;
	readonly url: string;
}

export interface Commit {
	readonly hash: string;
	readonly message: string;
	readonly parents: string[];
}

export enum RefType {
	Head,
	RemoteHead,
	Tag,
}
