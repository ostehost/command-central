# Contributing to Command Central

Command Central is a Bun-based VS Code extension. The repository-local contract
is authoritative for development commands; read `AGENTS.md` and `WORKFLOW.md`
before changing code.

## Prerequisites

- Bun
- a VS Code-compatible editor for interactive extension testing
- Git

## Setup

```bash
git clone https://github.com/ostehost/command-central.git
cd command-central
just install
```

## Development

```bash
just dev             # launch the extension development flow
just test            # complete repository test recipe
just format --check  # read-only format validation
just lint            # read-only static validation
just check           # fast static aggregate; excludes tests
just ci              # strict release/CI aggregate
```

Use `just format` or `just fix` only when you intend to modify files. Build an
extension artifact with `bun run build`; distribution and prerelease flows are
documented in `WORKFLOW.md`.

## Change discipline

1. Capture `git status --short` before editing and preserve unrelated work.
2. Add behavior-specific tests. New detectors need a fixture or mutation that
   proves the forbidden state turns the gate red.
3. Run the narrow test first, then the applicable repository gates.
4. Review `git diff` and stage only the intended paths.
5. Do not commit, push, publish, or edit sibling repositories without explicit
   operator authorization.

Open pull requests against the repository shown in `package.json`. Describe the
behavioral change, validation commands, and any known limitations without
hand-maintained test counts or timing claims.
