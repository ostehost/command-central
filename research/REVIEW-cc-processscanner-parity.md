# REVIEW: ProcessScanner Codex/Gemini Parity

## Verdict
NO-GO

## Findings

### WARNING
`src/discovery/process-scanner.ts` uses broad path-segment hints for Codex/Gemini that can produce false positives:
- `CODEX_CLI_HINT_RE` includes `/codex(?:-cli)?/` ([src/discovery/process-scanner.ts](/Users/ostemini/projects/command-central/src/discovery/process-scanner.ts:30))
- `GEMINI_CLI_HINT_RE` includes `/gemini(?:-cli)?/` ([src/discovery/process-scanner.ts](/Users/ostemini/projects/command-central/src/discovery/process-scanner.ts:32))

Because these are matched against the full `ps` command string, any non-agent process whose script path includes `/codex/` or `/gemini/` (for example, a regular Node app in such a directory) can be misclassified as an agent. This conflicts with the low-noise requirement.

### WARNING
The scanner tests validate Codex/Gemini positives, but do not lock in Codex/Gemini-specific false-positive behavior:
- Positives exist in [test/discovery/process-scanner.test.ts](/Users/ostemini/projects/command-central/test/discovery/process-scanner.test.ts:41) and [test/discovery/process-scanner.test.ts](/Users/ostemini/projects/command-central/test/discovery/process-scanner.test.ts:113).
- The negative test set ([test/discovery/process-scanner.test.ts](/Users/ostemini/projects/command-central/test/discovery/process-scanner.test.ts:59)) does not include near-miss commands containing `/codex/` or `/gemini/` paths for non-agent processes.

Without these near-miss tests, the current regex noise risk is not protected against regression.

## Checked Items
- Detection patterns: parity present, but Codex/Gemini path hints are too broad.
- Backend/model parsing vs UI icon logic: consistent. `parseClaudeArgs()` sets `agent_backend` + `cli_name`, and tree detection prioritizes those explicit hints ([src/discovery/process-scanner.ts](/Users/ostemini/projects/command-central/src/discovery/process-scanner.ts:185), [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:210)).
- Test coverage: Codex + Gemini positives are covered; Codex/Gemini false-positive near-misses are missing.
