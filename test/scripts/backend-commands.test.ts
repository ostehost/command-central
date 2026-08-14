import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const backendCommandsPath = path.join(
	repoRoot,
	"resources/bin/scripts/lib/backend-commands.sh",
);

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function runBackendCommands(script: string) {
	return spawnSync(
		"bash",
		["-lc", `source ${shellQuote(backendCommandsPath)}\n${script}`],
		{
			cwd: repoRoot,
			encoding: "utf-8",
			env: { ...process.env, OSTE_CLAUDE_EFFORT: "xhigh" },
		},
	);
}

describe("backend-commands shell hardening", () => {
	test("quotes prompt, model, project, and sidecar paths in generated codex command", () => {
		const result = runBackendCommands(`
build_agent_command \\
  --backend codex \\
  --prompt-file "/tmp/prompt'file; echo bad" \\
  --task-id "task'one; echo bad" \\
  --model "gpt-5.5' ; echo bad" \\
  --project-dir "/tmp/project'one" \\
  --script-dir "${repoRoot}/resources/bin/scripts"
`);

		expect(result.status).toBe(0);
		const stdout = result.stdout.trim();
		expect(stdout).toContain("cat '/tmp/prompt'\\''file; echo bad'");
		expect(stdout).toContain("--model 'gpt-5.5'\\'' ; echo bad'");
		expect(stdout).toContain("--cd '/tmp/project'\\''one'");
		expect(stdout).toContain("--add-dir '/tmp/project'\\''one/.git'");
		expect(stdout).toContain(
			"2>>'/tmp/codex-stderr-task'\\''one; echo bad.log'",
		);
		expect(stdout).toContain(
			"tee '/tmp/codex-stream-task'\\''one; echo bad.jsonl'",
		);
	});

	test("quotes prompt, model, and session id in generated claude command", () => {
		const result = runBackendCommands(`
build_agent_command \\
  --backend claude \\
  --interactive \\
  --prompt-file "/tmp/claude'prompt; echo bad" \\
  --task-id task-one \\
  --model "opus' ; echo bad" \\
  --session-id "session' ; echo bad"
`);

		expect(result.status).toBe(0);
		const stdout = result.stdout.trim();
		expect(stdout).toContain("$(cat '/tmp/claude'\\''prompt; echo bad')");
		expect(stdout).toContain("--model 'opus'\\'' ; echo bad'");
		expect(stdout).toContain("--session-id 'session'\\'' ; echo bad'");
	});

	test("rejects injected numeric claude limits", () => {
		const result = runBackendCommands(`
build_agent_command \\
  --backend claude \\
  --interactive \\
  --prompt-file /tmp/prompt \\
  --task-id task-one \\
  --max-turns "1; echo bad" \\
  --thinking-budget "2000$(echo bad)"
`);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"build_agent_command: invalid --max-turns (expected: non-negative integer)",
		);
	});

	// The ACP model guards. This file exercises the VENDORED mirror at
	// resources/bin/scripts/lib/backend-commands.sh, which `just sync-launcher`
	// copies from ghostty-launcher and which `just ci` does not currently
	// --check. A mirror that silently drifts past the canonical copy is exactly
	// how the stripping regresses here while the upstream repo stays green, so
	// the assertions live in both places on purpose.
	test("acp-codex strips an Anthropic model instead of forwarding it", () => {
		const result = runBackendCommands(`
build_agent_command \\
  --backend acp-codex \\
  --interactive \\
  --prompt-file /tmp/prompt \\
  --task-id task-acp-codex \\
  --model "anthropic/claude-sonnet-4-6"
`);

		expect(result.status).toBe(0);
		const stdout = result.stdout.trim();
		expect(stdout).not.toContain("anthropic/claude-sonnet-4-6");
		expect(stdout).not.toContain("--model");
		expect(result.stderr).toContain("skipping incompatible model");
		expect(result.stderr).toContain("acp-codex");
	});

	test("acp-codex strips a bare Anthropic tier alias", () => {
		const result = runBackendCommands(`
build_agent_command \\
  --backend acp-codex \\
  --interactive \\
  --prompt-file /tmp/prompt \\
  --task-id task-acp-alias \\
  --model opus
`);

		expect(result.status).toBe(0);
		// 'opus' carries no claude- prefix, so a prefix-only guard would leak it.
		expect(result.stdout.trim()).not.toContain("--model");
	});

	test("acp backends still forward a compatible model", () => {
		const codex = runBackendCommands(`
build_agent_command \\
  --backend acp-codex \\
  --interactive \\
  --prompt-file /tmp/prompt \\
  --task-id task-acp-ok \\
  --model o3-mini
`);
		expect(codex.status).toBe(0);
		expect(codex.stdout.trim()).toContain("--model 'o3-mini'");

		const gemini = runBackendCommands(`
build_agent_command \\
  --backend acp-gemini \\
  --interactive \\
  --prompt-file /tmp/prompt \\
  --task-id task-acp-gemini-ok \\
  --model gemini-2.5-pro
`);
		expect(gemini.status).toBe(0);
		expect(gemini.stdout.trim()).toContain("--model 'gemini-2.5-pro'");
	});
});
