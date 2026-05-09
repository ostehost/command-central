#!/usr/bin/env bun

import * as os from "node:os";

export type NodeExecutionContext = {
	user: string;
	home: string;
	cwd: string;
	hostname: string;
};

export type NodeExecutionGuardResult = {
	ok: boolean;
	issues: string[];
};

export function getNodeExecutionContext(): NodeExecutionContext {
	return {
		user: process.env["USER"] ?? os.userInfo().username,
		home: process.env["HOME"] ?? os.homedir(),
		cwd: process.cwd(),
		hostname: os.hostname(),
	};
}

export function validateNodeExecutionContext(
	context: NodeExecutionContext,
): NodeExecutionGuardResult {
	const issues: string[] = [];

	if (context.user !== "ostehost") {
		issues.push(`expected USER=ostehost, got ${context.user || "(empty)"}`);
	}

	if (!context.home.startsWith("/Users/ostehost")) {
		issues.push(`expected HOME under /Users/ostehost, got ${context.home}`);
	}

	if (!context.cwd.startsWith("/Users/ostehost/")) {
		issues.push(`expected cwd under /Users/ostehost, got ${context.cwd}`);
	}

	return {
		ok: issues.length === 0,
		issues,
	};
}

export function formatNodeExecutionGuardFailure(
	context: NodeExecutionContext,
	issues: string[],
): string {
	return [
		"Refusing to run node-only Command Central smoke on this machine.",
		"",
		"Real VS Code / installed-VSIX smoke must execute on the MacBook node via OpenClaw native node routing.",
		"Run it with OpenClaw dynamic exec targeting: host=node node=\"Mike MacBook Pro\".",
		"",
		"Observed execution context:",
		`  user: ${context.user}`,
		`  home: ${context.home}`,
		`  cwd: ${context.cwd}`,
		`  hostname: ${context.hostname}`,
		"",
		"Issues:",
		...issues.map((issue) => `  - ${issue}`),
	].join("\n");
}

export function assertNodeExecutionContext(): void {
	const context = getNodeExecutionContext();
	const result = validateNodeExecutionContext(context);
	if (result.ok) return;

	throw new Error(formatNodeExecutionGuardFailure(context, result.issues));
}

if (import.meta.main) {
	try {
		assertNodeExecutionContext();
		console.log("node-execution-ok");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
