#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { initAdapter } from './adapters/init.js';
import { loadAdapter } from './adapters/loader.js';
import { ERROR_CODES, EXIT_CODES, exitCodeForResult, resultCode } from './core/exit-codes.js';
import { loadManifest, manifestPathFrom, resolveBaseUrl } from './manifest.js';
import { ResourceRegistry } from './resources/registry.js';
import { runSoak } from './runner/run.js';

const PACKAGE_VERSION = JSON.parse(await fs.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')).version;
const HELP = `agent-soak <command> [options]

Commands:
  inspect                 Read and print a manifest without contacting a target
  init-adapter <id>       Create a new adapter, manifest, and README template
  discover                Ask the adapter for capabilities and live metadata
  validate                Run configuration and service preflight checks
  doctor                  Check runtime, manifest, adapter, and local prerequisites
  run                     Run scenarios by round count or duration
  cleanup                 Retry cleanup for a previous run
  residue                 Find pending cleanup records in an artifact directory

Options:
  --manifest <path>       Manifest path (default: platform.manifest.json)
  --mode <readonly|write> Run mode (default: readonly)
  --rounds <number>       Number of rounds
  --duration <value>      Duration such as 30s, 10m, or 2h
  --interval <value>      Delay between rounds
  --run-id <id>           Reuse a safe run identifier for recovery
  --artifacts <path>      Artifact directory (default: artifacts)
  --allow-writes          Explicitly authorize write or cleanup operations
  --browser               Include browser-capable scenarios
  --supervise             Show the browser and install the supervision marker
  --dry-run               Preview cleanup without deleting resources
  --remote                Include adapter-backed residue scanning
  --force                 Overwrite files created by init-adapter
  --version               Show the package version
  --json                  Emit one-line machine-readable JSON
  --help                  Show this help
`;

export async function main(argv = process.argv.slice(2)) {
  const wantsJson = argv.includes('--json');
  try {
    const args = parseArgs(argv);
    if (args.version) return print({ ok: true, command: 'version', version: PACKAGE_VERSION }, wantsJson);
    if (args.help || !args.command) return print({ ok: true, command: 'help', usage: HELP }, wantsJson);
    const manifestPath = manifestPathFrom(process.cwd(), String(args.manifest || 'platform.manifest.json'));
    if (args.command === 'init-adapter') return finish(await initAdapter({ cwd: process.cwd(), id: args.positionals[0], force: args.force === true }), wantsJson);
    if (args.positionals.length) throw new Error(`argument_unknown: ${args.positionals[0]}`);
    const manifest = await loadManifest(manifestPath);
    if (args.command === 'inspect') return print({ ok: true, command: 'inspect', manifest }, wantsJson);
    if (args.command === 'residue' && args.remote !== true) return finish(await residue(args), wantsJson);
    const adapter = await loadAdapter(manifestPath, manifest);
    if (args.command === 'doctor') return finish(await doctor(manifestPath, manifest, adapter, args), wantsJson);
    if (args.command === 'discover') return finish({ ok: true, command: 'discover', ...(await adapter.discover({ manifest, baseUrl: resolveBaseUrl(manifest) })) }, wantsJson);
    if (args.command === 'validate') return finish(await validate(manifest, adapter, args), wantsJson);
    if (args.command === 'run') return finish(await runSoak({ manifest, adapter, args, artifactDir: path.resolve(String(args.artifacts || 'artifacts')) }), wantsJson);
    if (args.command === 'cleanup') return finish(await cleanup(manifest, adapter, args), wantsJson);
    if (args.command === 'residue') return finish(await residue(args, manifest, adapter), wantsJson);
    throw new Error(`command_unknown: ${args.command}`);
  } catch (error) {
    print({ ok: false, code: ERROR_CODES.INPUT_INVALID, error: error instanceof Error ? error.message : String(error), detail_code: codeFromError(error) }, wantsJson);
    return EXIT_CODES.input;
  }
}

async function validate(manifest, adapter, args) {
  const mode = modeFrom(args);
  if (mode === 'write') assertWriteAllowed(manifest, args);
  const baseUrl = resolveBaseUrl(manifest);
  const preflight = await runPreflight(adapter, manifest, baseUrl);
  return { ok: preflight.ok, command: 'validate', mode, preflight, writeScenarios: manifest.scenarios.filter((item) => item.mode === 'write').map((item) => item.id) };
}

async function doctor(manifestPath, manifest, adapter, args) {
  const checks = [{ id: 'node-version', ok: Number(process.versions.node.split('.')[0]) >= 20, detail: process.version, expected: '>=20' }, { id: 'manifest', ok: true, detail: manifestPath }, { id: 'adapter', ok: Boolean(adapter), detail: manifest.adapter }, { id: 'base-url-env', ok: Boolean(process.env[manifest.platform.base_url_env]), detail: manifest.platform.base_url_env }];
  if (args.browser) { try { await import('playwright'); checks.push({ id: 'playwright', ok: true }); } catch (error) { checks.push({ id: 'playwright', ok: false, detail: error instanceof Error ? error.message : String(error) }); } }
  return { ok: checks.every((check) => check.ok), command: 'doctor', checks };
}

async function cleanup(manifest, adapter, args) {
  const runId = safeRunId(args.runId);
  const dryRun = args.dryRun === true;
  if (!dryRun) assertWriteAllowed(manifest, args);
  const artifactDir = path.resolve(String(args.artifacts || 'artifacts'));
  const baseUrl = resolveBaseUrl(manifest);
  const registry = await ResourceRegistry.restore(artifactDir, runId, `${manifest.platform.test_data_prefix}${runId}-`);
  return { ...(await registry.cleanup((resource) => adapter.deleteResource(resource, { baseUrl, runId, manifest }), { dryRun })), command: 'cleanup', runId, dryRun };
}

async function residue(args, manifest, adapter) {
  const artifactDir = path.resolve(String(args.artifacts || 'artifacts'));
  const entries = await fs.readdir(artifactDir, { withFileTypes: true }).catch(() => []);
  const pending = [];
  for (const entry of entries) if (entry.isDirectory()) { const file = path.join(artifactDir, entry.name, 'cleanup-pending.json'); if (await fs.access(file).then(() => true).catch(() => false)) pending.push(file); }
  const result = { ok: pending.length === 0, command: 'residue', pending };
  if (!manifest || !adapter) return result;
  if (typeof adapter.scanResidue !== 'function') return { ...result, ok: false, error: 'adapter_scan_residue_required' };
  try { result.remote = await adapter.scanResidue({ manifest, baseUrl: resolveBaseUrl(manifest), prefix: String(args.prefix || manifest.platform.test_data_prefix) }); if (!Array.isArray(result.remote)) throw new Error('adapter_scan_residue_invalid_result'); result.ok = result.ok && result.remote.length === 0; return result; }
  catch (error) { return { ...result, ok: false, remoteError: error instanceof Error ? error.message : String(error) }; }
}

async function runPreflight(adapter, manifest, baseUrl) { try { const result = await adapter.preflight({ manifest, baseUrl }); return result && typeof result === 'object' ? { ok: result.ok !== false, ...result } : { ok: true }; } catch (error) { return { ok: false, issues: [{ error: error instanceof Error ? error.message : String(error) }] }; } }
function modeFrom(args) { const mode = String(args.mode || 'readonly'); if (!['readonly', 'write'].includes(mode)) throw new Error(`mode_invalid: ${mode}`); return mode; }
function assertWriteAllowed(manifest, args) { if (manifest.platform.production === true) throw new Error('write_rejected_production_target'); if (args.allowWrites !== true || process.env[manifest.platform.write_gate_env] !== 'true') throw new Error(`write_gate_required: use --allow-writes and ${manifest.platform.write_gate_env}=true`); }
function safeRunId(value) { if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(String(value))) throw new Error('run_id_invalid'); return String(value); }
function codeFromError(error) { return (error instanceof Error ? error.message : String(error)).split(':')[0]; }
function finish(result, json) { const code = resultCode(result); print({ ...result, ...(code ? { code } : {}) }, json); if (result.ok !== false) return EXIT_CODES.success; if (['validate', 'discover', 'doctor'].includes(result.command) || result.status === 'preflight_failed') return EXIT_CODES.preflight; if (['cleanup', 'residue'].includes(result.command)) return EXIT_CODES.cleanup; return exitCodeForResult(result); }
function parseArgs(values) { const out = { command: undefined, positionals: [] }; const booleans = new Set(['json', 'allowWrites', 'dryRun', 'supervise', 'browser', 'help', 'remote', 'force', 'version']); const valueFlags = new Set(['manifest', 'mode', 'rounds', 'duration', 'interval', 'runId', 'artifacts', 'prefix']); for (let index = 0; index < values.length; index += 1) { const token = values[index]; if (index === 0 && !token.startsWith('--')) { out.command = token; continue; } if (!token.startsWith('--')) { out.positionals.push(token); continue; } const [rawName, inlineValue] = token.slice(2).split('=', 2); const name = rawName.replace(/-([a-z])/g, (_, char) => char.toUpperCase()); if (booleans.has(name)) { if (inlineValue !== undefined) throw new Error(`argument_boolean_value: --${rawName}`); out[name] = true; continue; } if (!valueFlags.has(name)) throw new Error(`argument_unknown: --${rawName}`); const value = inlineValue ?? values[++index]; if (!value || value.startsWith('--')) throw new Error(`argument_value_required: --${rawName}`); out[name] = value; } return out; }
function print(value, json) { console.log(json ? JSON.stringify(value) : JSON.stringify(value, null, 2)); return EXIT_CODES.success; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
