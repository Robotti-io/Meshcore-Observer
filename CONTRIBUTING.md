# Contributing

Thanks for helping improve Robotti MeshCore Observer. Keep changes focused on
the issue or plan being addressed, and update the relevant documentation when
behavior or operator guidance changes.

## Requirements

- Node.js 22.13.0 or newer (required for the built-in `node:sqlite` store).
- npm, using the repository's `package-lock.json` for reproducible installs.

Install dependencies with:

```sh
npm ci
```

For local operation, copy `.env.example` to the ignored `.env.local` and copy
the broker and bot examples to their ignored local config files as needed. Use
placeholder credentials only in examples and tests. Never commit `.env.local`,
`brokers.config.json`, `bots.config.json`, metrics databases, or real broker
secrets.

## Before opening a pull request

Run the repository checks that apply to your change:

```sh
npm run lint
npm test
npm run test:ci
```

`npm run test:ci` runs the suite with the repository's coverage thresholds.
GitHub Actions runs lint separately and runs the coverage suite on Windows and
Ubuntu with Node 22.x and 24.x for pull requests targeting `main`.

Add or update focused tests for behavior changes. Keep radio, broker, and
filesystem interactions behind the existing seams; automated tests should not
need real radio traffic or broker credentials. Use the existing strict AJV
schemas for structured configuration and externally sourced data.

## Project conventions

- JavaScript ES modules only; do not add TypeScript or Python.
- Keep configuration reads centralized in `src/config/index.js`.
- Follow the repository's structured logging and secret-redaction rules.
- Do not add dependencies without explicit maintainer approval.
- Keep persistence changes behind `MetricsStore`; storage/schema changes need
  explicit approval and migration coverage.
- Preserve the documented Windows runtime and container-friendly deployment
  boundaries. CI validation is handled by GitHub Actions; container build and
  deployment work is a separate concern.

Check the issue and its implementation plan for the intended scope and target
branch before opening a pull request. Keep the pull request description tied
to that scope and include relevant validation results.
