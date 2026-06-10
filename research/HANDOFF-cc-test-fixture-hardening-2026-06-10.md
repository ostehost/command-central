# Fable Lane — Command Central test/fixture hardening

Task ID: cc-test-fixture-hardening-20260610
Role: test
Model: fable

## Context
Command Central rc50 is cut and locally committed. Test files around Agent Status are very large and noisy; hardening should improve maintainability without destabilizing behavior.

## Objective
Reduce test bloat or duplication in one focused area, while preserving coverage and making future refactors safer.

## Scope
Allowed scope:
- `test/tree-view/`
- `test/helpers/`
- fixture files under `test/fixtures/`
- source changes only if a tiny exported test helper type is necessary; avoid production behavior changes.

## Requirements
- Identify one repeated fixture/setup pattern in large Agent Status tests.
- Extract a helper or fixture builder, or split an overgrown test into clearer units.
- Run the affected tests and `just test-unit` if feasible.
- Commit locally if and only if tests pass.
- Write a receipt at `research/RESULT-cc-test-fixture-hardening-2026-06-10.md` with before/after rationale and test evidence.

## Constraints
No release churn, no push/tag/publish, no dependencies, no `--no-verify`.
