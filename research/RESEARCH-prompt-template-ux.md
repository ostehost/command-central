# RESEARCH: Prompt UX Templating Standards and Recommendation for Command Central

Date: 2026-03-26
Task ID: prompt-template-ux-research

## Scope
Research markdown-friendly prompt templating patterns for:
- reusable/common blocks
- composable templates
- standardized outputs
- default-collapsed optional sections

## Current Command Central Baseline (Evidence)
- Prompt creation is currently a direct string write: `# Task\n\n${description}` at [src/extension.ts:2008](/Users/ostemini/projects/command-central/src/extension.ts:2008) and [src/extension.ts:2009](/Users/ostemini/projects/command-central/src/extension.ts:2009).
- Existing prompt artifacts are plain markdown specs (no reusable composition layer), e.g. [prompts/terminal-routing.md:1](/Users/ostemini/projects/command-central/prompts/terminal-routing.md:1).

## Established Standards and Libraries

### Mustache
- Logic-less model; sections and partials for reuse; optional inheritance extensions (blocks/parents).
- Strength: predictable and simple.
- Tradeoff: limited expressiveness for richer composition.
- Source: https://mustache.github.io/mustache.5.html

### Handlebars
- Adds helper system on top of mustache-like syntax.
- Supports registered partials, dynamic partials, partial blocks, inline partials.
- Strength: strong composition and ecosystem maturity.
- Tradeoff: helper-heavy templates can become application logic.
- Sources:
  - https://handlebarsjs.com/guide/partials.html
  - https://handlebarsjs.com/guide/block-helpers.html

### Liquid
- `render` provides scoped template inclusion; `include` is deprecated in favor of `render`.
- Strength: clearer boundaries and maintainability from scoped rendering.
- Tradeoff: less ubiquitous for Node prompt stacks than Handlebars/Nunjucks.
- Source: https://shopify.github.io/liquid/tags/template/

### Jinja2 / Nunjucks
- Jinja2: mature inheritance, include/import/macro patterns, explicit context behavior.
- Nunjucks: JS ecosystem implementation with Jinja-style inheritance and macros.
- Strength: excellent composition ergonomics for markdown templates.
- Tradeoff: template execution safety must be controlled (Nunjucks does not sandbox user-defined templates).
- Sources:
  - https://jinja.palletsprojects.com/en/stable/templates/
  - https://mozilla.github.io/nunjucks/templating.html

### LangChain Prompt Templates
- `PromptTemplate` supports template variables and partial variables; common format guidance emphasizes careful use of Jinja.
- `ChatPromptTemplate` supports composable message templates/placeholders.
- Strength: app-level prompt composition primitives (especially for agent/chat pipelines).
- Tradeoff: not a markdown-template UX system by itself; best when integrated with an external renderer.
- Source: https://api.python.langchain.com/en/latest/core/prompts/langchain_core.prompts.prompt.PromptTemplate.html

### Promptfoo
- Supports reusable defaults (`defaultTest`), refs (`$ref`) and Nunjucks-based templated transforms.
- Defines output formats and standard result fields for consistent downstream processing.
- Strength: strong community practice for evaluation + standardized reporting.
- Tradeoff: evaluation framework first, not a runtime prompt renderer.
- Sources:
  - https://www.promptfoo.dev/docs/configuration/guide/
  - https://www.promptfoo.dev/docs/providers/http/
  - https://www.promptfoo.dev/docs/configuration/outputs/

## Markdown Collapsible Section Convention
- GitHub and broader markdown workflows commonly use HTML `<details><summary>...</summary>...</details>`.
- Default behavior is collapsed when `open` is absent; `open` expands by default.
- Source:
  - https://docs.github.com/github/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections
  - https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details

## Community Practices (Cross-Source Synthesis)
1. Keep a minimal base template and compose via partials/includes/macros.
2. Isolate shared instructions from task-specific payload.
3. Keep optional heavy context collapsed by default to reduce scanning overhead.
4. Require a machine-readable output contract with stable field names.
5. Enforce template variable completeness (fail fast on missing vars).
6. Separate rendering from evaluation/validation; use eval tooling for regression checks.

## Recommendation for Command Central

Preferred approach: Nunjucks-based markdown templates (`.md.njk`) with strict rendering policy.

Why this is the best fit:
- JS-native and Bun/Node-friendly.
- Strong composition primitives (extends/include/import/macro) for reusable blocks.
- Familiar Jinja-style syntax and ecosystem conventions.
- Aligns with Promptfoo’s Nunjucks-centric templating patterns in practical prompt workflows.

Security and reliability constraints:
- Treat templates as trusted project assets only (no user-supplied template code).
- Use strict undefined handling (fail render if required variables are missing).
- Keep template logic minimal; move business logic to TypeScript.

## Suggested Template Structure

```text
prompts/
  templates/
    base/
      prompt.md.njk
      output-contract.md.njk
    blocks/
      role-system.md.njk
      constraints.md.njk
      acceptance-criteria.md.njk
      context-collapsed.md.njk
      risks-collapsed.md.njk
    tasks/
      generic-dev-task.md.njk
      research-task.md.njk
      review-task.md.njk
```

## Suggested Prompt Layout (Default-Collapsed Sections + Standardized Output)

```md
# Task: {{ task_title }}

## Objective
{{ objective }}

## Required Deliverables
- {{ deliverable_1 }}
- {{ deliverable_2 }}

## Output Contract (Required)
Return a fenced `yaml` block with exactly:
- task_id
- status
- summary
- files_changed
- tests_passing
- next_steps

<details>
<summary>Additional Context (Optional)</summary>

{{ long_context }}

</details>

<details>
<summary>Reference Material (Optional)</summary>

{{ references_md }}

</details>
```

Notes:
- Keep `<details>` sections closed by default.
- Only use `<details open>` when a section is mandatory for first-pass execution.

## Pros/Cons of This Recommendation

Pros:
- High composability with low duplication.
- Clear separation between always-visible instructions and optional context.
- Standardized outputs integrate cleanly with orchestrator/reporting workflows.
- Easy to add prompt variants by role without rewriting shared blocks.

Cons:
- Requires renderer integration and template discipline.
- Nunjucks safety model requires strict trust boundaries.
- Overuse of template logic can reduce readability if not governed.

## Proposed Adoption Plan
1. Introduce base + shared block templates only (no behavior changes yet).
2. Switch current launch prompt generation to renderer-backed template output.
3. Add output-contract lint check (verify required keys appear in output template section).
4. Add Promptfoo eval cases to catch regressions in rendered prompt shape.

## Final Recommendation
Adopt Nunjucks markdown templates with:
- strict variable validation
- composable shared blocks
- `<details>/<summary>` for default-collapsed optional context
- a fixed YAML output contract matching orchestration fields (`task_id`, `status`, `summary`, `files_changed`, `tests_passing`, `next_steps`)

This gives Command Central a practical, established, and maintainable prompt UX templating standard while staying aligned with current JS tooling and community practices.
