# Contributing to Electric Shepherd

Thanks for helping improve Electric Shepherd.

Electric Shepherd is the policy layer for memory consolidation on top of MemPalace. This repository is TypeScript-first and OpenCode-focused.

## Getting Started

```bash
# Fork the repository on GitHub first, then clone your fork
git clone https://github.com/<your-username>/electric-shepherd.git
cd electric-shepherd
git remote add upstream https://github.com/edwardmakesthings/electric-shepherd.git

# Install dependencies
npm install
```

## Development Workflow

1. Create a branch for your change.
2. Make focused commits.
3. Validate locally (see below).
4. Open a pull request against the default branch.

## Local Validation

Minimum checks before opening a PR:

```bash
# Ensure package contents are correct
npm pack --dry-run
```

For runtime or adapter changes, also run one or more policy scripts in an environment with MemPalace tools available:

```bash
npm run policy:example
npm run policy:consolidate-validate:example
npm run policy:mem-core:load -- --format markdown
```

If a command requires local environment variables (for example MCP endpoint/tool prefix), document what you used in the PR description.

## PR Guidelines

1. Keep PRs small and reviewable.
2. Include context: what changed, why, and risk level.
3. Include verification notes: exact commands run and key outcomes.
4. Update docs (`README.md`, `QUICKSTART.md`, or `docs/`) when behavior changes.
5. Never include secrets, personal absolute paths, machine names, or private hostnames.

### Commit Message Style

Use Conventional Commits where possible:

- `feat: add scoped merge review option`
- `fix: guard missing MCP endpoint in capture script`
- `docs: update quickstart instruction paths`
- `chore: add issue templates`

## Code and Design Conventions

- Prefer clear, explicit TypeScript over clever abstractions.
- Keep MemPalace substrate mechanics separate from policy decisions.
- Preserve deterministic behavior where required by policy runtime.
- Keep docs machine-neutral: no user-specific paths, hosts, or credentials.

## Security and Privacy

- Do not commit credentials, API keys, tokens, or private URLs.
- Treat `.electric-shepherd/`, `.opencode-plugin-health/`, and rendered memory files as generated/private artifacts.
- Follow `SECURITY.md` for vulnerability reporting.

## Questions

If you are planning a larger design change, open an issue first to align on approach and boundaries.
