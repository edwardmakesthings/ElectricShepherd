# Security Policy

## Supported Versions

Electric Shepherd is currently in early `0.x` development.

| Version | Supported |
| --- | --- |
| 0.x | Yes |
| < 0.1.0 | No |

## Reporting a Vulnerability

Please do not disclose vulnerabilities publicly before a fix is available.

Preferred reporting path:

1. Use GitHub's private vulnerability reporting (Security Advisory / "Report a vulnerability") for this repository.

If private reporting is unavailable, open a minimal GitHub issue requesting a private channel and do not include exploit details.

Include:

- Affected version/commit
- Impact summary
- Reproduction steps
- Any known mitigations

## Response Targets

- Initial acknowledgement: within 72 hours
- Triage decision: within 7 days
- Fix or mitigation plan: within 30 days (when feasible)

## Scope Notes

In-scope examples:

- Secret exposure in code, docs, or templates
- Unsafe defaults that can leak private memory content
- Command/documentation patterns that encourage insecure deployment

Out-of-scope examples:

- Vulnerabilities only present in third-party dependencies with no practical impact here
- Missing optional hardening that does not create an exploit path

## Security Hygiene for Contributors

- Never commit credentials, tokens, or private hostnames.
- Avoid absolute local paths in docs and scripts.
- Keep endpoint/tool URLs configurable through environment variables.
