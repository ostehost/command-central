/**
 * Knip Configuration for Command Central
 * Dead code detection tailored to VS Code extension with Bun
 *
 * @see https://knip.dev/reference/configuration
 */

import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // ──────────────────────────────────────────────────────────
  // ENTRY POINTS - Where the analysis starts
  // ──────────────────────────────────────────────────────────

  entry: [
    // Main extension entry point
    "src/extension.ts",

    // All test files
    "test/**/*.test.ts",

    // Active scripts (v2) - new architecture
    "scripts-v2/**/*.ts",
    "scripts-v2/lib/**/*.ts",
  ],

  // ──────────────────────────────────────────────────────────
  // PROJECT FILES - What to analyze
  // ──────────────────────────────────────────────────────────

  project: ["src/**/*.ts", "scripts-v2/**/*.ts"],

  // ──────────────────────────────────────────────────────────
  // IGNORE PATTERNS - Files/dirs to skip
  // ──────────────────────────────────────────────────────────

  ignore: [
    // Build output and distribution
    "dist/**",
    "out/**",
    "releases/**",
    "*.vsix",

    // Archived code and documentation
    "archive/**",
    "legacy/**", // Deprecated/unused code (moved 2025-10-19)
    "_deleted/**", // Deleted/archived code (not in active codebase)
    "scripts/**", // OLD scripts (v1) - may have unused code
    "scripts-v2/archive/**", // Archived v2 scripts (has broken imports)

    // Backup and temporary files
    "src/extension.ts.backup-*",
    "*.backup",
    "**/*.backup",

    // Type definitions (generated or external)
    "**/*.d.ts",

    // Package manager
    "**/node_modules/**",
    "**/bun.lockb",

    // Documentation (intentional, not code)
    "**/*.md",
    "**/*.json.refresh-bak",
    "**/*.json.toggle-bak",
  ],

  // ──────────────────────────────────────────────────────────
  // TYPE EXPORTS - Keep exported types/interfaces
  // ──────────────────────────────────────────────────────────

  ignoreExportsUsedInFile: {
    interface: true, // Keep exported interfaces
    type: true, // Keep exported types
    enum: true, // Keep exported enums
  },

  // ──────────────────────────────────────────────────────────
  // DEPENDENCIES - Packages Knip might not detect
  // ──────────────────────────────────────────────────────────

  ignoreDependencies: [
    // VS Code extension types
    // Code quality tools (CLI only)
    "@biomejs/biome", // Formatter/linter
    "@vscode/sqlite3", // Dynamic require - provided by VS Code runtime
  ],

  // ──────────────────────────────────────────────────────────
  // VS CODE EXTENSION SPECIFIC
  // ──────────────────────────────────────────────────────────

  // Note: Path mappings (@/* etc.) are automatically read from tsconfig.json

  // Commands registered in package.json are detected via:
  // - Command imports in src/extension.ts
  // - Dynamic imports in tree-view-utils.ts
  // - Provider registrations

  // Known false positives to expect:
  // - Dynamic slot commands (slot1-slot10): Template-based, intentional
  // - Resource files (icons, media): Loaded at runtime
  // - SQLite adapters: May appear unused but loaded dynamically
};

export default config;
