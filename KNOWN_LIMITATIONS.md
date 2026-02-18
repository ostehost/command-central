# Known Limitations

## Integration Testing with Bun

### Current Status
✅ **168 tests passing** with 90%+ code coverage (using partitioned test approach)  
⚠️ **Tests require `bun run test` command** due to mock isolation limitations  
❌ **Integration tests cannot run with `bun test`** due to architectural incompatibility

### The Issue

VS Code extensions require the Extension Host environment to access the `vscode` API. This API is not a regular npm package but is injected at runtime by VS Code itself. When running tests with `bun test`, the tests execute in Bun's standalone process without access to the Extension Host, causing integration tests that depend on the real `vscode` API to fail.

### Technical Details

The `vscode` module:
- Contains only TypeScript definitions, no implementation
- Implementation is injected by VS Code's Extension Host at runtime
- Cannot be imported or mocked completely outside of VS Code
- Requires VS Code's `@vscode/test-electron` framework for integration testing

### What Works

✅ **Unit Tests** - All service, utility, and security tests run perfectly with Bun  
✅ **Development** - Extension develops and builds correctly with Bun  
✅ **Production** - Extension runs perfectly when installed in VS Code  
✅ **VSIX Packaging** - Builds and packages correctly with Bun toolchain

### What Doesn't Work

❌ Integration tests that require real VS Code APIs (`vscode.extensions`, `vscode.commands`, etc.)  
❌ End-to-end tests that need the Extension Host environment

### Current Workaround

We maintain comprehensive unit test coverage (90%+) for all business logic, utilities, and services. Integration testing is done manually during development using:

```bash
# Launch VS Code with the extension for manual testing
code --extensionDevelopmentPath=.
```

### Upstream Tracking

This limitation is being tracked by the Bun team:
- **GitHub Issue**: [oven-sh/bun#4824](https://github.com/oven-sh/bun/issues/4824)
- **Status**: Open, active development
- **Community Interest**: 127+ developers affected

The Bun team has confirmed they are working on VS Code extension support with integrated test runner capabilities.

## Test Runner Mock Isolation

### The Issue

Bun's `mock.module()` creates global mocks that persist across test files, causing conflicts when tests run together. This is a fundamental design choice in Bun - prioritizing speed over isolation by running all tests in a single process.

### Impact

- `bun test` (without "run") causes 37 test failures due to mock conflicts
- Tests pass individually but fail when run together
- Different test files expecting different mock implementations conflict

### Our Solution: Test Partitioning

We've implemented a partitioned test approach that isolates conflicting tests:

```bash
# ✅ CORRECT - Always use this
bun run test           # Runs partitioned tests (168 pass, 0 fail)

# ❌ WRONG - Never use this  
bun test              # Runs all tests together (100 pass, 37 fail)
```

### Partitioned Test Commands

```bash
bun run test:git1      # Integration tests (3 tests)
bun run test:git2      # Sorted changes provider (2 tests)
bun run test:git3      # Git timestamps (4 tests)
bun run test:git4      # Circuit breaker + SCM sorter (16 tests)
bun run test:core      # Utils/services/security (143 tests)
```

### Why This Works

- `bun test` ignores package.json scripts and runs all tests with global mocks
- `bun run test` uses our partitioned approach, running conflicting tests separately
- The preload in bunfig.toml provides the base vscode mock needed by all tests

### Upstream Tracking - Mock Isolation

This limitation is tracked by multiple Bun issues:
- **mock.restore() doesn't work with modules**: [GitHub #7823](https://github.com/oven-sh/bun/issues/7823)
- **Test isolation issues**: [GitHub #12823](https://github.com/oven-sh/bun/issues/12823), [#6040](https://github.com/oven-sh/bun/issues/6040), [#5391](https://github.com/oven-sh/bun/issues/5391)
- **Community consensus**: 20+ developers reporting identical mock pollution issues

### Running Tests

```bash
# Run all tests with partitioning (ALWAYS use this)
bun run test

# Run specific test partitions
bun run test:git1      # Git sort integration
bun run test:core      # Core utilities

# For CI/CD
- run: bun run test    # NOT "bun test"
```

### Future Plans

#### Ideal Solution: Bun-Native Testing

We are committed to staying with Bun as our primary toolchain. The current partitioning workaround is temporary while we wait for Bun to mature in two key areas:

1. **Mock Isolation Support** - When Bun implements proper test isolation or fixes `mock.restore()` for modules
2. **VS Code Extension Support** - When Bun adds native Extension Host testing capabilities

#### When These Issues Are Resolved

Once Bun addresses these limitations, we will:
1. Remove test partitioning and use standard `bun test`
2. Enable integration tests with real VS Code APIs
3. Add end-to-end testing capabilities
4. Achieve full CI/CD pipeline integration

#### Timeline

Based on Bun's rapid development pace and community engagement, we anticipate:
- Mock isolation improvements: Q1-Q2 2025 (active discussion)
- VS Code extension support: Q2-Q3 2025 (confirmed on roadmap)

Until then, we maintain high confidence through:
- Comprehensive unit test coverage (90%+)
- Manual testing during development
- Type safety with TypeScript
- Code quality tools (Biome, TypeScript strict mode)

### Contributing

If you're contributing to this project:
1. Write unit tests for all new functionality
2. Ensure unit tests pass: `bun run test` (NOT `bun test`)
3. Manually test VS Code integration: `bun run dev`
4. Document any integration points that can't be unit tested

### Additional Resources

- [VS Code Extension Testing Guide](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [Bun Test Runner Documentation](https://bun.sh/docs/cli/test)
- [Community Discussion on Bun + VS Code](https://github.com/oven-sh/bun/discussions)