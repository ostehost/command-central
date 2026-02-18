# Contributing to Ghostty Launcher VS Code Extension

Thank you for your interest in contributing to the Ghostty Launcher extension! This guide will help you get started with development.

## Prerequisites

- **Bun** ≥ 1.1.0 - [Install Bun](https://bun.sh)
- **VS Code** ≥ 1.100.0
- **macOS/Linux** (Windows support coming)
- **Ghostty Dock Launcher** - [Install from GitHub](https://github.com/ghostty-dock-launcher)
- **Biome** 2.2.2 - Installed automatically with `bun install`

## Development Setup

1. Clone the repository:
```bash
git clone https://github.com/mike/ghostty-launcher.git
cd ghostty-launcher
```

2. Install dependencies:
```bash
bun install
```

3. Build the extension:
```bash
bun run build
```

## Development Workflow

### Running the Development Environment

The `dev` script launches VS Code with the extension loaded in development mode:

```bash
# Test with current directory as workspace
bun run dev

# Test with a specific project directory
bun run dev /path/to/test/project

# Test with environment variable
GHOSTTY_TEST_WORKSPACE=/path/to/project bun run dev
```

#### Common Test Scenarios:

```bash
# Test with the launcher project itself
bun run dev ~/ghostty-dock-launcher-v1

# Test with a sample project
bun run dev ../my-test-project

# Test with current extension directory
bun run dev .
```

### Testing the Extension

Once VS Code opens in development mode:

1. **Open Command Palette**: Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Linux)
2. **Find Commands**: Type "Visual Studio Code Extension" to see all commands
3. **Test Launch**: Run "Launch Project Terminal"
4. **Verify**: Check `/Applications/Projects/` for created launcher

### Hot Reload

The dev server watches for changes and automatically rebuilds:
- Make changes to any `.ts` file in `src/`
- Wait for "✅ Rebuild successful" message
- Reload VS Code window with `Cmd+R` to test changes

## Project Structure

```
ghostty-launcher/
├── src/
│   ├── extension.ts           # Extension entry point
│   ├── commands/              # Command handlers
│   ├── services/              # Core services
│   │   └── ghostty-service.ts # Launcher integration
│   ├── security/              # Security utilities
│   └── utils/                 # Helper utilities
├── scripts/
│   ├── dev.ts                 # Development server
│   ├── build.ts               # Build script
│   └── package.ts             # VSIX packaging
├── test/                      # Test files
└── dist/                      # Built extension (gitignored)
```

## Running Tests

```bash
# Run all tests
bun test

# Watch mode for TDD
bun test --watch

# Run with coverage
bun test --coverage

# Run specific test suite
bun test test/security
```

## Code Quality

We use [Biome](https://biomejs.dev) for code formatting and linting. Biome is configured to maintain consistent code style across the project.

### Available Commands

| Command | Description |
|---------|-------------|
| `bun run format` | Check code formatting |
| `bun run format:fix` | Auto-fix formatting issues |
| `bun run lint` | Check linting rules |
| `bun run lint:fix` | Fix linting issues (safe fixes only) |
| `bun run check` | Run all checks (format + lint + organize imports) |
| `bun run check:fix` | Fix all issues automatically |
| `bun run typecheck` | TypeScript type checking |

### Before Committing

Always run checks before committing:
```bash
bun run check
bun run typecheck
```

If there are issues, fix them with:
```bash
bun run check:fix
```

### Configuration

Biome configuration is in `biome.json`. The project uses:
- Tab indentation (2 spaces width)
- Double quotes for strings
- Trailing commas
- Semicolons
- 80 character line width

## Building for Production

```bash
# Create VSIX package for distribution
bun run package
```

## Debugging Tips

### VS Code Extension Host

1. Set breakpoints in your TypeScript files
2. Use the Debug Console in the development VS Code instance
3. Check the Output panel: View → Output → "Ghostty Terminal Launcher"

### Common Issues

**Extension not loading?**
- Check the Output panel for activation errors
- Ensure `bun run build` completed successfully
- Verify the launcher script path in settings

**Commands not appearing?**
- Reload the window: `Cmd+R`
- Check `package.json` for command registration
- Verify activation events in `package.json`

**Launcher script not found?**
- Update `ghostty.launcherPath` setting
- Ensure the script has execute permissions: `chmod +x /path/to/ghostty`

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b my-feature`
3. Make your changes and test thoroughly
4. Run tests and linting: `bun test && bun run lint`
5. Commit with clear messages
6. Push and create a Pull Request

## Security Considerations

- Always validate and sanitize user inputs
- Use the `SecurityService` for command execution
- Never execute user-provided strings directly
- Follow the security patterns in existing code

## Questions?

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
- Join discussions in pull requests

Happy coding! 🚀