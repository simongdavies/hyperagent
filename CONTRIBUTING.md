# Contributing to Hyperagent

This project welcomes contributions. Most contributions require you to signoff on your commits via the Developer Certificate of Origin (DCO).

## Issues

Before submitting:
- Search existing issues to avoid duplicates
- Use issue templates when available

### Bug Reports

Include:
- Hyperagent version (`hyperagent --version`)
- Operating system and hypervisor (KVM/MSHV/WHP)
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs or error messages

### Feature Proposals

Describe:
- Use case and motivation
- Proposed solution
- Alternatives considered

## Contributing Code

1. Fork the repository
2. Create a feature branch from `main`
3. Make changes with tests
4. Run `npm run check` (must pass)
5. Submit PR against `main`

### Commit Signing

Commits must be signed-off via DCO:

```bash
git commit -s -m "Description of change"
```

This adds a `Signed-off-by` line certifying you wrote or have the right to submit the code.

### Pull Request Checklist

- [ ] Tests pass (`npm test`)
- [ ] Type check passes (`npm run typecheck`)
- [ ] Code formatted (`npm run fmt`)
- [ ] Commits are signed-off (DCO)

### CI Validation

PRs run tests on multiple platforms:
- Linux with KVM
- Azure Linux with MSHV
- Windows 11 with WHP (Hyper-V)

## Development Setup

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for:
- Prerequisites (Node.js, Rust, hypervisor)
- Build commands
- Project structure
- Testing guidelines

## Code Style

- **Formatting**: Prettier (run `npm run fmt`)
- **TypeScript**: Strict mode enabled
- **Plugins**: Must be TypeScript files (enforced by tests)

## License

By contributing, you agree that your contributions will be licensed under the [Apache 2.0 License](LICENSE.txt).
