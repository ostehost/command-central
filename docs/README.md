# Command Central Documentation

**Welcome to Command Central's developer documentation.**

This is your navigation hub for understanding, developing, and contributing to Command Central - the AI-powered mission control for VS Code.

---

## 🚀 Quick Start

### New to Command Central?
1. **[Developer Onboarding](./development/ONBOARDING.md)** - Get up and running in 5 minutes
2. **[Architecture Overview](./architecture/OVERVIEW.md)** - Understand how the system works
3. **[Testing Guide](./development/TESTING_GUIDE.md)** - Learn our testing patterns

### Contributing Code?
1. **[Contributing Guide](../CONTRIBUTING.md)** - How to contribute
2. **[Code Style Guide](./standards/CODE_STYLE.md)** - Our coding conventions
3. **[API Guide](./development/API_GUIDE.md)** - Internal APIs and extension points

---

## 📚 Available Documentation

### Architecture & Design
- **[Architecture Overview](./architecture/OVERVIEW.md)** - High-level system design and 3-layer DI pattern
- **[Full Architecture](../ARCHITECTURE.md)** - Comprehensive architecture document (704 lines)

### Development
- **[Onboarding Guide](./development/ONBOARDING.md)** - New developer getting started (5 minutes)
- **[API Documentation](./development/API_GUIDE.md)** - Internal APIs, services, and interfaces
- **[Testing Guide](./development/TESTING_GUIDE.md)** - Observable effects testing patterns

### Standards & Practices
- **[Code Style](./standards/CODE_STYLE.md)** - Coding conventions (Biome, TypeScript, patterns)

### Performance
- **[Benchmarks](./performance/BENCHMARKS.md)** - Performance baselines and metrics

### Roadmap & Vision
- **[Product Vision](./roadmap/VISION.md)** - Long-term direction through v1.0+

---

## 📖 Root Documentation

These important docs live in the project root:

- **[README.md](../README.md)** - User-facing documentation and feature overview
- **[ARCHITECTURE.md](../ARCHITECTURE.md)** - Comprehensive architecture (704 lines)
- **[WORKFLOW.md](../WORKFLOW.md)** - Development workflow and commands (authoritative)
- **[CHANGELOG.md](../CHANGELOG.md)** - Version history and changes
- **[CONTRIBUTING.md](../CONTRIBUTING.md)** - How to contribute to the project
- **[CLAUDE.md](../CLAUDE.md)** - Bun + VS Code extension development guide

---

## 🗂️ Historical Documentation

Historical handoff documents and feature implementation logs are preserved in:
- **[archive/handoffs/](../archive/handoffs/)** - 134 historical documents organized by topic

These docs provide valuable context about how features were built and decisions made, but are not required reading for day-to-day development.

---

## 🔍 Finding What You Need

### Quick Search Tips

**By Feature:**
- Git Sort → [Architecture Overview](./architecture/OVERVIEW.md) + [Full Architecture](../ARCHITECTURE.md)
- Multi-workspace → [Architecture Overview](./architecture/OVERVIEW.md)
- Extension Filtering → [API Guide](./development/API_GUIDE.md)
- Active File Tracking → [Architecture Overview](./architecture/OVERVIEW.md)

**By Task:**
- Adding command → [API Guide](./development/API_GUIDE.md)
- Writing tests → [Testing Guide](./development/TESTING_GUIDE.md)
- Performance → [Benchmarks](./performance/BENCHMARKS.md)
- Coding standards → [Code Style](./standards/CODE_STYLE.md)

**By Question:**
- "How does X work?" → [Architecture Overview](./architecture/OVERVIEW.md)
- "Why did we choose Y?" → [Full Architecture](../ARCHITECTURE.md)
- "What's the pattern for Z?" → [Code Style](./standards/CODE_STYLE.md) or [API Guide](./development/API_GUIDE.md)
- "Where are we going?" → [Product Vision](./roadmap/VISION.md)

---

## 📊 Quality Metrics

Current project health (v0.0.35):
- **Test Coverage:** 87.50%
- **Tests:** 461 passing, 0 failing
- **Dead Code:** 0% (100% knip clean)
- **Build Time:** ~1.1s
- **Activation Time:** ~200ms

---

## 🚧 Coming Soon

The following docs are planned but not yet created. Contributions welcome!

### Architecture
- **Tree View Patterns** - VS Code TreeView implementation patterns
- **Data Flow** - How data flows through the system
- **Dependency Injection** - Deep dive into DI patterns

### Development
- **Debugging Guide** - Common debugging scenarios

### Standards
- **Error Handling** - Error patterns and user messaging
- **Logging Standards** - What and how to log
- **Security Practices** - Security guidelines and threat model

### Performance
- **Optimization Guide** - Performance patterns and tips

### Roadmap
- **Current Priorities** - What we're building now
- **Technical Debt** - Known issues and improvement areas

**Want to help?** See [FOUNDATION_HANDOFF.md](../FOUNDATION_HANDOFF.md) for detailed instructions on creating these docs.

---

## 🤝 Contributing to Documentation

Found something unclear? Want to improve a doc?

1. All documentation follows [Markdown best practices](https://www.markdownguide.org/basic-syntax/)
2. Keep it concise - developers want answers, not essays
3. Include examples - code speaks louder than words
4. Link generously - help readers navigate
5. Update this navigation hub when adding new docs

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full contribution process.

---

## 📞 Getting Help

- **Questions?** Start with [Onboarding Guide](./development/ONBOARDING.md)
- **Found a bug?** See [CONTRIBUTING.md](../CONTRIBUTING.md)
- **Feature idea?** See [VISION.md](./roadmap/VISION.md) and [CONTRIBUTING.md](../CONTRIBUTING.md)

---

*Last Updated: 2025-10-25 | Command Central v0.0.35*
