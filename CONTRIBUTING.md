# Contributing to VectorDB

We welcome contributions from the community! Here's how you can help improve VectorDB.

## Table of Contents
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Contribution Guidelines](#contribution-guidelines)
- [Code Style](#code-style)
- [Testing](#testing)
- [Documentation](#documentation)
- [Pull Request Process](#pull-request-process)
- [Code Review](#code-review)
- [Community](#community)
- [License](#license)

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your forked repository:
   ```bash
   git clone https://github.com/pguso/embedded-vector-db.git
   ```
3. Create a **feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Setup

### Prerequisites
- Node.js 16.x or higher
- npm 7.x or higher
- Python 3.x (for hnswlib-node compilation)

### Installation
1. Install dependencies:
   ```bash
   npm install
   ```
2. Build the project:
   ```bash
   npm run build
   ```

## Contribution Guidelines

### Before You Start
1. Check existing [issues](https://github.com/pguso/embedded-vector-db/issues) for similar proposals
2. For major changes, open an issue first to discuss the proposed changes

### Contribution Areas
- Core functionality improvements
- Performance optimizations
- Additional test coverage
- Documentation improvements
- Bug fixes
- New features (please discuss first)

## Code Style
- Follow TypeScript best practices
- Use async/await for asynchronous operations
- Prefer functional programming patterns where appropriate
- Keep methods focused and single-responsibility

### Linting
We use ESLint and Prettier for code consistency:
```bash
npm run lint   # Check code style
npm run format # Auto-format code
```

## Testing

### Writing Tests
- Use Jest testing framework
- Place tests in `__tests__` directory
- Follow naming convention: `*.test.ts`
- Include unit tests and integration tests as appropriate

### Running Tests
```bash
npm test       # Run all tests
npm run test:watch # Watch mode
```

### Test Coverage
We aim to maintain high test coverage:
```bash
npm run test:coverage
```

## Documentation
- Update README.md for significant changes
- Add JSDoc comments for new public methods
- Keep TypeDoc documentation updated
- Document new configuration options

## Pull Request Process
1. Ensure all tests pass
2. Update documentation if needed
3. Describe your changes in the PR description:
   - Motivation for changes
   - Technical approach
   - Any breaking changes
4. Reference related issues using #issue-number
5. Allow maintainers to make changes to your branch

## Code Review
- All PRs require maintainer approval
- Reviews typically completed within 3 business days
- Address review comments by pushing new commits
- Use meaningful commit messages:
  ```
  feat: add compactNamespace method
  fix: handle null metadata in search
  docs: update persistence section
  ```

## Community

### Reporting Issues
- Use the GitHub issue tracker
- Include:
  - VectorDB version
  - Node.js version
  - Reproduction steps
  - Expected vs actual behavior

### Discussion
Join our community discussions:
- GitHub Discussions
- Discord Channel (link in repo description)

## License
By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).