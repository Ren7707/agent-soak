# agent-soak

AI-ready universal soak testing for CLI tools and web agents.

## Quick Start

```powershell
npm install
$env:DEMO_PLATFORM_BASE_URL = "http://127.0.0.1:4317"
node examples/demo-platform/server.js
```

In another terminal:

```powershell
node src/cli.js inspect --json
node src/cli.js validate --mode readonly --json
node src/cli.js run --rounds 3 --mode readonly --json
$env:ALLOW_TEST_WRITES = "true"
node src/cli.js run --rounds 2 --mode write --allow-writes --json
node src/cli.js residue --json
```

Scenario entries may set `timeout_ms` and `retries` (0-10). A timeout aborts
the scenario signal; a retry is attempted only when the scenario fails.
Reports record the final status and number of attempts.

Reports are written under `artifacts/<run-id>/`. They include JSON, Markdown,
JUnit XML, and HTML. Write runs create only run-prefixed Demo items and clean
them before the run finishes.

## Platform Contract

A platform provides `platform.manifest.json` and an adapter. The manifest
contains the base URL environment variable, health path, capabilities, test
data prefix, write gate, and scenario declarations. Platform-specific routes,
authentication, selectors, and resource state transitions belong in the
adapter, not in the core scheduler or resource registry.

See `templates/adapter.md` for the adapter shape and
`docs/design/2026-09-03-universal-soak-framework.md` for the design boundary.

Use `node src/cli.js init-adapter <id>` to create an isolated YAML manifest,
adapter starter, environment example, and platform README under `adapters/`.

## Safety

Read-only is the default. Write mode requires both `--allow-writes` and the
manifest's write gate environment variable set to `true`. Production manifests
are rejected. Cleanup only operates on resources owned by the current run and
matching its generated prefix. Failed cleanup produces `cleanup-pending.json`.

## Privacy Boundary

This repository is an independent personal project. It contains public
framework code, a local Demo platform, fictional data, and tests only. Do not
add private URLs, credentials, customer data, internal API contracts, traces,
screenshots, or production reports.

## License

MIT. See `LICENSE`.
