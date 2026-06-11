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
});
