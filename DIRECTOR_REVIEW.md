# Director Review: Test Suite Overhaul

**Date:** February 18, 2026  
**Project:** Command Central VS Code Extension  
**Review Scope:** TEST_EXECUTION_PLAN.md and supporting audit documents  

---

## DECISION: **CONDITIONAL GO**

The test overhaul plan is sound in principle but requires specific safeguards to mitigate execution risk. The strategy correctly prioritizes bug-catching capability over test quantity, but the scale of changes demands careful execution.

---

## CONDITIONS FOR APPROVAL

### 1. **SEQUENCED COMMITS (NON-NEGOTIABLE)**

The execution plan proposes a single commit. **This is too risky.** Break into phases:

**Phase 1:** Mock foundation fix only
```bash
git commit -m "Fix registerCommand mock to return Disposable

- Updates vscode-mock.ts registerCommand to return proper Disposable
- Fixes any tests broken by mock returning Disposable instead of undefined
- This is the critical foundation fix that everything else depends on"
```

**Phase 2:** Add new tests without deletions
```bash 
git commit -m "Add 17 new tests targeting real production bugs

- ProviderFactory test coverage (8 tests)
- ProjectViewManager reload tests (3 tests) 
- SortedGitChangesProvider race condition tests (3 tests)
- Extension activation resilience tests (3 tests)"
```

**Phase 3:** Systematic test cuts by category
```bash
git commit -m "Remove 234 redundant tests - command boilerplate

- Remove duplicate error handling patterns from command tests (76 cuts)
- Keep success path + one error test per command"

git commit -m "Remove 234 redundant tests - service mock theater  

- Remove mock-focused tests from service files (89 cuts)
- Keep behavior-focused tests"

git commit -m "Remove 234 redundant tests - utilities and types

- Remove trivial validation and formatting tests (52 cuts)
- Remove TypeScript-redundant type system tests (16 cuts)"
```

**Rationale:** If Phase 3 introduces regressions, we can revert specific categories without losing the valuable work from Phases 1-2.

### 2. **SPECIFIC TEST CUTS TO REVERSE**

Based on my analysis, **keep these "trivial" tests** that may guard against subtle regressions:

- `test/git-sort/circuit-breaker.test.ts` - **Keep the warning message test** (line 48-58). Circuit breaker user feedback is critical.
- `test/services/launcher/strategies.test.ts` - **Keep platform validation tests** (lines 97-107, 131-141). Cross-platform bugs are hard to catch.
- `test/commands/*/exception path - re-throws terminal-related errors` - **Keep ONE instance** across all command files as a regression guard, delete the rest.

Total tests saved: ~8. Manageable deviation from the 234 cut target.

### 3. **ADDITIONAL TESTS REQUIRED**

The 17 new tests are excellent but add one more:

**Cross-workspace file resolution edge case test:**
```typescript
// In test/factories/provider-factory.test.ts
test("handles workspace root vs nested project distinction", async () => {
  // VS Code workspace: /Users/dev/monorepo
  // Project config: /Users/dev/monorepo/packages/frontend  
  // File request: /Users/dev/monorepo/packages/backend/src/file.ts
  
  // Should return undefined (file outside configured project)
  // Not the monorepo provider (common bug in path matching)
});
```

This catches a class of bugs where broad workspace paths incorrectly claim ownership of files outside their actual project scope.

### 4. **PROCESS SAFEGUARDS**

- **Test coverage threshold:** Maintain >85% line coverage after cuts
- **Integration test preservation:** The 52 integration tests are the most valuable - don't touch them
- **Manual regression test:** Run the extension manually in a multi-workspace setup after each phase
- **Mike review trigger:** If any phase reveals >5 broken tests beyond the expected mock fixes, pause for review

---

## RISK ASSESSMENT

**Probability of false security:** **Medium (30%)** - The audit correctly identifies most tests as low-value, but some "trivial" tests may prevent subtle regressions we don't anticipate.

**Worst case scenario:** A significant user-facing regression ships because a deleted test was the only guard against an edge case we didn't consider. The sequenced approach mitigates this - we can quickly identify which phase introduced a problem.

**Risk mitigation:** The new bug-catching tests are more valuable than the deleted redundant tests. Even if we lose some regression protection, we gain significantly better failure detection.

**Confidence level:** **High** that this improves the test suite's effectiveness despite some risk.

---

## SPECIFIC FEEDBACK ON EXECUTION PLAN

### ✅ **What's Excellent:**
1. **Mock foundation fix first** - Correct priority, everything depends on this
2. **17 new tests map to real bugs** - Perfect prioritization, these would have prevented actual production failures
3. **Conservative on integration tests** - Correctly identifies them as highest value and leaves them alone
4. **Clear success criteria** - Measurable goals with specific metrics

### ⚠️ **Areas of Concern:**
1. **Single commit approach** - Too risky for 234 deletions, needs phasing
2. **Mock-heavy vs behavior focus** - Good direction but some low-level tests may still have value
3. **No coverage baseline** - Need to establish coverage metrics before cuts to ensure no significant regression

### 💡 **Strategic Insights:**
The plan correctly identifies that the current suite has **high false confidence** from mock theater. This overhaul trades some regression protection for significantly better bug detection. That's the right strategic trade-off for a maturing codebase.

---

## IMPLEMENTATION RECOMMENDATION

1. **Execute in phases** as outlined above
2. **Mike should review** the mock foundation fix (Phase 1) since it affects all tests
3. **Automated gates:** Pre-commit hooks should run full test suite after each phase
4. **Ship incrementally:** Each phase should be deployable to catch any issues early

## FINAL APPROVAL CONDITIONS

- [ ] Commit to phased approach (4-5 commits instead of 1)  
- [ ] Keep the 8 tests I identified above
- [ ] Add the cross-workspace resolution test
- [ ] Establish coverage baseline before cuts
- [ ] Mike reviews Phase 1 (mock fix)

**With these conditions met: FULL GO for execution.**

---

*This overhaul correctly prioritizes bug detection over test quantity. The audit work is thorough and the execution plan is strategically sound. The modifications above simply add appropriate safeguards for managing execution risk.*