# Universal Soak Framework Design

Date: 2026-09-03

## Goal

`agent-soak` is a standalone, public framework for repeatable long-running
tests of CLI tools and web agents. A platform supplies a small manifest and an
adapter; the framework owns scheduling, safety gates, browser lifecycle,
resource cleanup, and machine-readable reports.

This repository is an independent personal project. It contains no private
service code, credentials, production URLs, customer data, screenshots, or
internal API contracts.

## MVP Scope

- Node.js and TypeScript CLI.
- Local demo platform with mock HTTP API and browser UI.
- Read-only and explicitly authorized write modes.
- Run by duration or round count, with safe cancellation.
- Run-scoped resource registry, cleanup, pending recovery, and residue scan.
- Preflight checks for configuration and service health.
- JSON, JUnit, Markdown, and HTML reports.
- Playwright Chromium support, including optional supervised display.
- GitHub Actions workflow for unit and demo smoke tests.

The MVP does not attempt zero-configuration testing of arbitrary websites,
automatic selector generation, production operation, cloud orchestration, or a
hosted control plane.

## Architecture

The first release is one package with strict internal module boundaries. It can
be split into packages later without changing the adapter contract.

```text
src/
  core/        run context, events, scheduler, exit codes
  browser/     Playwright lifecycle and audited operations
  resources/   registration, cleanup, residue detection
  adapters/    manifest validation and adapter loading
  reporters/   JSON, JUnit, Markdown, HTML
  cli/         inspect, discover, validate, run, cleanup, residue
examples/
  demo-platform/  local mock API and browser application
templates/         manifest and adapter starter files
```

The core never imports a platform-specific adapter. Adapters receive a run
context and expose `preflight`, `authenticate`, `discover`, `scenarios`, and
resource lifecycle methods. Scenarios declare whether they are read-only or
write-capable and which platform capabilities they require.

## Safety Model

- Read-only is the default mode.
- Write scenarios require both a manifest write gate and an explicit CLI/env
  authorization.
- Every created resource receives a run-specific prefix and is registered
  before further mutation.
- Cleanup can delete only resources registered by the current run and matching
  the expected test prefix.
- Failed cleanup writes `cleanup-pending.json` and makes the run fail.
- `cleanup --dry-run` is available for inspection before deletion.
- Secrets are read from environment variables and redacted from reports.
- Production-like targets are rejected unless the adapter explicitly marks the
  environment as a permitted test target.

## CLI Contract

```text
agent-soak inspect --manifest platform.manifest.json --json
agent-soak discover --manifest platform.manifest.json --json
agent-soak validate --mode readonly
agent-soak run --rounds 3 --mode readonly
agent-soak run --duration 10m --mode write --allow-writes
agent-soak cleanup --run-id <run-id> --dry-run
agent-soak residue --json
```

Commands return stable non-zero exit codes for invalid input, preflight
failure, scenario failure, cancellation, and cleanup failure. `--json` emits a
single structured result suitable for an Agent.

## Verification

The test suite covers manifest validation, mode and write-gate handling,
resource ownership and cleanup recovery, scheduler cancellation, report
generation, and a local demo end-to-end run. CI runs the same checks on Linux;
the CLI uses Node APIs and PowerShell-compatible scripts for Windows users.
