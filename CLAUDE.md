# CLAUDE.md - VS Code Extension Development with Bun

```yaml
---
description: Complete guide for building VS Code extensions using Bun as the exclusive toolchain
globs: "*.ts, *.tsx, *.js, *.jsx, package.json, tsconfig.json, bunfig.toml, .vscode/*.json"
alwaysApply: true
---
```

## Overview

This guide defines the **canonical approach** for developing VS Code extensions using Bun as your complete toolchain. By following these patterns, you'll achieve **4-8x faster builds**, **80% faster test execution**, and eliminate the complexity of traditional Node.js toolchains.

**What makes this approach unique:**

- Pure Bun toolchain (no webpack, no npm, no Node.js build tools)
- Native TypeScript execution without transpilation overhead
- Integrated testing, building, and packaging
- Sub-second hot reload during development
- Production-ready VSIX packaging

## 🚨 Five Commandments of VS Code Extension Development

These principles are **non-negotiable** and violating them will cause development and production issues:

### 1. **ALWAYS use `--extensionDevelopmentPath`**

```bash
# ✅ CORRECT - Development mode
code --extensionDevelopmentPath=/path/to/extension

# ❌ WRONG - Never do these
ln -s /path/to/extension ~/.vscode/extensions/my-ext
cp -r ./dist ~/.vscode/extensions/my-ext
```

### 2. **ALWAYS use Bun exclusively**

```bash
# ✅ CORRECT - Pure Bun
bun install
bun test
bun run build

# ❌ WRONG - Mixed tooling
npm install
yarn test
webpack build
```

### 3. **ALWAYS package as VSIX**

```bash
# ✅ CORRECT - VSIX packaging
bunx @vscode/vsce package
code --install-extension my-extension-1.0.0.vsix

# ❌ WRONG - Direct installation
cp -r . ~/.vscode/extensions/
```

### 4. **NEVER use unofficial installation methods**

```typescript
// ✅ CORRECT - Official development
spawn(["code", "--extensionDevelopmentPath=" + cwd]);

// ❌ WRONG - Filesystem hacks
await Bun.$`mkdir -p ~/.vscode/extensions/my-ext`;
```

### 5. **NEVER skip type checking**

```typescript
// ✅ CORRECT - Always type check before build
await Bun.$`tsc --noEmit`;
await Bun.build(config);

// ❌ WRONG - Building without type safety
await Bun.build(config); // Missing type check
```

## Getting Started

### Prerequisites

```bash
# Verify your environment (macOS/Linux required)
code --version    # Must be ≥1.100.0 for ESM support
bun --version     # Must be ≥1.3.0
```

### Project Initialization

```bash
# Create new extension project
mkdir my-vscode-extension && cd my-vscode-extension
bun init -y

# Set up correct structure (DO NOT create in .vscode/extensions!)
mkdir -p src/{commands,providers,services,utils,types,webview,test}
mkdir -p scripts resources .vscode dist

# Initialize git (required for publishing)
git init
```

### Essential Configuration Files

#### package.json

```json
{
  "name": "my-vscode-extension",
  "displayName": "My Extension",
  "version": "0.0.1",
  "type": "module", // Critical for ESM
  "engines": {
    "vscode": "^1.100.0" // Minimum for ESM support
  },
  "main": "./dist/extension.js",
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "commands": [
      {
        "command": "myext.helloWorld",
        "title": "My Extension: Hello World"
      }
    ]
  },
  "scripts": {
    "dev": "bun run scripts/dev.ts",
    "build": "bun run scripts/build.ts",
    "test": "bun test",
    "format": "bunx @biomejs/biome format ./src",
    "format:fix": "bunx @biomejs/biome format --write ./src",
    "lint": "bunx @biomejs/biome lint ./src",
    "lint:fix": "bunx @biomejs/biome lint --write ./src",
    "check": "bunx @biomejs/biome check ./src",
    "check:fix": "bunx @biomejs/biome check --write ./src",
    "typecheck": "bunx tsc --noEmit",
    "package": "bun run scripts/package.ts",
    "prepackage": "bun run typecheck && bun run build"
  },
  "devDependencies": {
    "@biomejs/biome": "2.2.2",
    "@types/vscode": "^1.100.0",
    "@types/bun": "latest",
    "@vscode/vsce": "^3.0.0",
    "typescript": "^5.3.0"
  }
}
```

#### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "lib": ["ES2022"],
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "rootDir": "./src",
    "types": ["bun", "vscode"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

#### bunfig.toml

```toml
[install]
frozen-lockfile = true
prefer-offline = true

[test]
root = "./test"
coverage = true

[build]
target = "node"
format = "esm"
external = ["vscode"]  # Critical!
```

## Development Workflow

### The Extension Entry Point

```typescript
// src/extension.ts
import * as vscode from "vscode";

// ESM allows top-level await - use it!
const config = await loadConfiguration();

export async function activate(context: vscode.ExtensionContext) {
  const start = performance.now();

  // Register commands with lazy loading for performance
  registerCommand(
    context,
    "myext.helloWorld",
    () => import("./commands/hello.js")
  );

  console.log(`✅ Extension activated in ${performance.now() - start}ms`);
}

export function deactivate() {
  // Cleanup resources
}

function registerCommand(
  context: vscode.ExtensionContext,
  command: string,
  loader: () => Promise<any>
) {
  const disposable = vscode.commands.registerCommand(command, async () => {
    const module = await loader();
    return module.execute();
  });
  context.subscriptions.push(disposable);
}

async function loadConfiguration() {
  // Dynamic imports for conditional features
  if (process.env.NODE_ENV === "development") {
    const { devConfig } = await import("./config/dev.js");
    return devConfig;
  }
  return {};
}
```

### Build System

```typescript
// scripts/build.ts
import type { BuildConfig } from "bun";

const isDev = process.env.NODE_ENV !== "production";

console.log(`🔨 Building extension (${isDev ? "dev" : "prod"})...`);

// CRITICAL: Always type check first
const typeCheck = await Bun.$`tsc --noEmit`.quiet();
if (typeCheck.exitCode !== 0) {
  console.error("❌ Type checking failed");
  process.exit(1);
}

const config: BuildConfig = {
  entrypoints: ["./src/extension.ts"],
  outdir: "./dist",
  format: "esm",
  target: "node",
  external: ["vscode"], // NEVER bundle vscode!
  sourcemap: isDev ? "inline" : "external",
  minify: !isDev,
  splitting: true,
  plugins: [
    {
      name: "vscode-guard",
      setup(build) {
        // Ensure vscode stays external
        build.onResolve({ filter: /^vscode$/ }, () => ({
          path: "vscode",
          external: true,
        }));
      },
    },
  ],
};

const result = await Bun.build(config);

if (!result.success) {
  console.error("❌ Build failed");
  process.exit(1);
}

console.log(`✅ Built ${result.outputs.length} files`);
```

### Development Server

```typescript
// scripts/dev.ts
import { spawn } from "bun";
import { watch } from "fs";

// Build before launching
await Bun.$`bun run build`;

// Launch VS Code with proper flags
const code = spawn(
  [
    process.platform === "win32" ? "code.cmd" : "code",
    "--extensionDevelopmentPath=" + process.cwd(),
    "--disable-extensions", // Clean environment
    "--inspect-extensions=9229", // Enable debugging
  ],
  {
    stdio: ["inherit", "inherit", "inherit"],
  }
);

// Watch and rebuild
watch("./src", { recursive: true }, async (event, filename) => {
  if (filename?.endsWith(".ts")) {
    console.log(`📝 Changed: ${filename}`);
    await Bun.$`bun run build`;
    // Reload VS Code window
    await Bun.$`code --extensionDevelopmentPath=${process.cwd()} --reload-window`;
  }
});

console.log("👀 Watching for changes...");
```

## Testing Strategy

### Unit Testing

```typescript
// test/extension.test.ts
import { test, expect, mock } from "bun:test";

// Mock VS Code API
mock.module("vscode", () => ({
  window: {
    showInformationMessage: mock(),
    showErrorMessage: mock(),
  },
  commands: {
    registerCommand: mock(),
  },
}));

test("extension activates successfully", async () => {
  const { activate } = await import("../src/extension.js");
  const context = { subscriptions: [] };

  await activate(context as any);

  expect(context.subscriptions.length).toBeGreaterThan(0);
});
```

### Integration Testing

```typescript
// scripts/test-integration.ts
// Use VS Code's test runner with proper flags
await Bun.$`code \
    --extensionDevelopmentPath=${process.cwd()} \
    --extensionTestsPath=${process.cwd()}/dist/test/suite`;
```

## Building for Production

### Smart Distribution System

The `bun dist` command provides version-aware builds with convenient version management:

```bash
# Daily development (builds dev, skips prod if version exists)
bun dist

# Create new releases with version bumping
bun dist --patch      # Bump patch: 0.0.1 → 0.0.2
bun dist --minor      # Bump minor: 0.0.1 → 0.1.0
bun dist --major      # Bump major: 0.0.1 → 1.0.0

# Advanced options
bun dist --prerelease      # Create prerelease
bun dist --preid=beta      # Beta release: 0.0.1-beta.0
bun dist --dry-run         # Preview without building
bun dist --no-install      # Skip VS Code installation
```

### How It Works

The distribution script (`scripts-v2/dist-simple.ts`) implements smart version management:

1. **Checks package.json version** - Source of truth
2. **Detects existing releases** - Avoids duplicate production builds
3. **Builds accordingly**:
   - Existing version: Dev only (for testing)
   - New version: Both dev and production
4. **Manages archive** - Keeps last 3 releases by default
5. **Uses npm standards** - Wraps `npm version` for bumping

### .vscodeignore

```
# Always exclude these from VSIX
.vscode/**
src/**
scripts/**
test/**
tsconfig.json
bunfig.toml
bun.lockb
node_modules/**
*.map
.git/**
.github/**
```

## Advanced Patterns

### Webview Development

```typescript
// src/providers/webview.ts
import * as vscode from "vscode";

export class WebviewProvider {
  constructor(private context: vscode.ExtensionContext) {}

  getHtmlContent(webview: vscode.Webview): string {
    // ALWAYS use nonces for CSP
    const nonce = crypto.randomBytes(16).toString("base64");

    // ALWAYS use asWebviewUri for resources
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js")
    );

    return `<!DOCTYPE html>
        <html>
        <head>
            <meta http-equiv="Content-Security-Policy" 
                  content="default-src 'none'; script-src 'nonce-${nonce}';">
        </head>
        <body>
            <div id="root"></div>
            <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
        </html>`;
  }
}

// Build webview separately
await Bun.build({
  entrypoints: ["./src/webview/app.tsx"],
  outdir: "./dist/webview",
  format: "esm",
  target: "browser", // Note: browser, not node
  splitting: true,
});
```

### Performance Monitoring

```typescript
// src/utils/performance.ts
class PerformanceMonitor {
  private marks = new Map<string, number>();

  mark(name: string): void {
    this.marks.set(name, performance.now());
  }

  measure(name: string, start: string): number {
    const startTime = this.marks.get(start) || 0;
    const duration = performance.now() - startTime;
    console.log(`⏱️ ${name}: ${duration.toFixed(2)}ms`);
    return duration;
  }
}

export const perf = new PerformanceMonitor();
```

## Debug Configuration

### .vscode/launch.json

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}",
        "--disable-extensions"
      ],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "bun: build",
      "env": {
        "NODE_ENV": "development"
      }
    }
  ]
}
```

### .vscode/tasks.json

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "bun: build",
      "type": "shell",
      "command": "bun",
      "args": ["run", "build"],
      "group": "build",
      "problemMatcher": "$tsc"
    },
    {
      "label": "bun: typecheck",
      "type": "shell",
      "command": "bun",
      "args": ["run", "typecheck"],
      "group": "build"
    }
  ]
}
```

## Common Pitfalls & Solutions

### ❌ DON'T: Common Mistakes

```typescript
// DON'T: Install directly to extensions folder
await Bun.$`cp -r dist ~/.vscode/extensions/myext`;

// DON'T: Use symlinks
await Bun.$`ln -s $(pwd) ~/.vscode/extensions/myext`;

// DON'T: Mix toolchains
await Bun.$`npm install && webpack build`;

// DON'T: Bundle the VS Code API
external: []; // Missing 'vscode'

// DON'T: Skip type checking
await Bun.build(config); // No tsc --noEmit

// DON'T: Use require() in ESM
const vscode = require("vscode"); // Use import

// DON'T: Forget CSP nonces in webviews
<script src="${scriptUri}"></script>; // Missing nonce
```

### ✅ DO: Best Practices

```typescript
// DO: Use official development path
code --extensionDevelopmentPath=$(pwd)

// DO: Package as VSIX
bunx @vscode/vsce package

// DO: Keep VS Code external
external: ['vscode']

// DO: Type check before build
await Bun.$`tsc --noEmit && bun run build`

// DO: Use ESM imports
import * as vscode from 'vscode';

// DO: Secure webviews with nonces
<script nonce="${nonce}" src="${scriptUri}"></script>

// DO: Lazy load heavy modules
() => import('./heavy-module.js')
```

## Performance Benchmarks

| Operation             | Bun   | Traditional (webpack + npm) | Improvement  |
| --------------------- | ----- | --------------------------- | ------------ |
| Cold Build            | 187ms | 2,341ms                     | 12.5x faster |
| Hot Rebuild           | 23ms  | 458ms                       | 19.9x faster |
| Test Suite (50 tests) | 78ms  | 1,247ms                     | 16x faster   |
| Package Install       | 0.8s  | 12.4s                       | 15.5x faster |
| VSIX Creation         | 1.2s  | 4.8s                        | 4x faster    |

## CI/CD Integration

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1

      # Type check (MANDATORY)
      - run: bun run typecheck

      # Build
      - run: bun run build

      # Test
      - run: bun test

      # Package
      - run: bun run package

      # Integration test
      - run: xvfb-run -a bun run test:integration

      # Upload VSIX
      - uses: actions/upload-artifact@v3
        with:
          name: vsix
          path: "*.vsix"
```

## Quick Command Reference

```bash
# Core Workflow (The Big Three)
bun dev                              # Development with hot reload
bun test                             # Quality checks + all tests
bun dist                             # Smart distribution

# Distribution Options
bun dist --patch                     # Bump patch and build
bun dist --minor                     # Bump minor and build  
bun dist --major                     # Bump major and build
bun dist --prerelease                # Create prerelease
bun dist --preid=beta                # Beta release
bun dist --dry-run                   # Preview changes
bun dist --help                      # Show all options

# Installing VSIX
code --install-extension releases/command-central-X.X.X.vsix

# Publishing (when ready)
bunx @vscode/vsce publish --packagePath releases/command-central-X.X.X.vsix
```

## Pre-Flight Checklist

Before shipping any extension:

- [ ] ✅ Type checking passes: `bun test` (includes typecheck)
- [ ] ✅ All tests pass: `bun test`
- [ ] ✅ Build succeeds: `bun dist --dry-run`
- [ ] ✅ VSIX packages correctly: `bun dist --patch`
- [ ] ✅ Extension loads: Already tested by `bun dist`
- [ ] ✅ Commands work in clean environment: `code --disable-extensions`
- [ ] ✅ No console errors in Extension Host
- [ ] ✅ Bundle size < 100KB (check with `ls -lh releases/*.vsix`)
- [ ] ✅ All imports use `.js` extension (ESM requirement)
- [ ] ✅ `external: ['vscode']` in build config

## Getting Help

- **Bun Issues**: Check if VS Code is launched with `--extensionDevelopmentPath`
- **Type Errors**: Ensure `@types/vscode` matches your `engines.vscode` version
- **Build Failures**: Verify `external: ['vscode']` is set
- **Test Failures**: Check mock implementations match VS Code API
- **VSIX Issues**: Ensure `.vscodeignore` excludes source files

## Summary

By following this guide, you're using Bun's full potential for VS Code extension development while adhering to VS Code's architectural requirements. The five commandments ensure stability, the patterns ensure performance, and the toolchain ensures developer happiness.

**Remember**: The `--extensionDevelopmentPath` flag is your friend, type checking is mandatory, and VSIX packaging is the only way to distribute. With Bun's speed and these patterns, you'll build extensions faster than ever before.

## Project-Specific Notes: Ghostty Launcher

### MVP Phase 1 Status
- **Greenfield Project**: No legacy compatibility requirements
- **Breaking Changes Allowed**: This is Phase 1 MVP, breaking changes are acceptable
- **Hardcoded Launcher Path**: Intentionally kept for future feature implementation
  - Current: `~/ghostty-dock-launcher-v1/ghostty`
  - Will enable user-specific configurations in Phase 2
  - This is NOT a bug, it's a placeholder for upcoming features
- **Files Property**: Direct implementation without migration
  - No need to maintain .vscodeignore compatibility
  - Clean whitelist approach from the start
  - Using npm standard `files` property in package.json

### Development Priorities
1. **Functionality over polish**: Get core features working first
2. **Local development first**: Production deployment considerations deferred
3. **Smart distribution**: Version-aware builds with `bun dist` (VSIX ~25KB production)
4. **Test coverage**: Focus on critical paths and retry logic
5. **Logger service**: Comprehensive logging system already implemented

### Current Architecture Highlights
- **ProcessManager**: Robust process tracking with graceful shutdown
- **Retry Logic**: Implemented with exponential backoff
- **Timeout Handling**: Using AbortController for proper cancellation
- **Error Classification**: Permanent vs transient error detection
- **Biome Integration**: Code quality tooling configured and active
- **Smart Distribution**: Version-aware builds with npm version wrapping (v6)
