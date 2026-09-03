import fs from 'node:fs/promises';
import path from 'node:path';

const ID = /^[a-z0-9][a-z0-9-]*$/;

export async function initAdapter({ cwd, id, force = false }) {
  if (!ID.test(id || '')) throw new Error('adapter_id_invalid');
  const targetDir = path.resolve(cwd, 'adapters', id);
  if (!isInside(cwd, targetDir)) throw new Error('adapter_target_invalid');
  const exists = await fs.access(targetDir).then(() => true).catch(() => false);
  if (exists && !force) throw new Error(`adapter_target_exists: ${path.relative(cwd, targetDir)}`);
  await fs.mkdir(targetDir, { recursive: true });
  const envPrefix = id.replace(/-/g, '_').toUpperCase();
  const files = {
    'platform.manifest.yaml': manifestTemplate(id, envPrefix),
    'adapter.js': adapterTemplate(),
    '.env.example': `${envPrefix}_BASE_URL=http://127.0.0.1:4000\nALLOW_TEST_WRITES=false\n`,
    'README.md': readmeTemplate(id, envPrefix),
  };
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(targetDir, name), content, { flag: force ? 'w' : 'wx' });
  }
  return { ok: true, command: 'init-adapter', id, directory: targetDir, files: Object.keys(files) };
}

function manifestTemplate(id, envPrefix) {
  return `schema_version: 1
adapter: ./adapter.js
platform:
  id: ${id}
  name: ${title(id)}
  base_url_env: ${envPrefix}_BASE_URL
  health_path: /health
  write_gate_env: ALLOW_TEST_WRITES
  test_data_prefix: SOAK_
  require_cleanup: true
  production: false
capabilities:
  - health
scenarios:
  - id: health
    title: Health check
    mode: readonly
    capabilities:
      - health
    timeout_ms: 10000
    retries: 1
`;
}

function adapterTemplate() {
  return `export function createAdapter() {
  return {
    async preflight({ baseUrl, manifest }) {
      const response = await fetch(\`${'${baseUrl}${manifest.platform.health_path || \'/health\'}'}\`);
      return { ok: response.ok, status: response.status };
    },
    async discover({ manifest }) {
      return { capabilities: manifest.capabilities, scenarioIds: manifest.scenarios.map((item) => item.id) };
    },
    scenarios: [
      {
        id: 'health',
        async run({ baseUrl, manifest }) {
          const response = await fetch(\`${'${baseUrl}${manifest.platform.health_path || \'/health\'}'}\`);
          if (!response.ok) throw new Error(\`health_http_${'${response.status}'}\`);
          return { ok: true, status: response.status };
        },
      },
    ],
    async deleteResource(resource) {
      throw new Error(\`cleanup_unsupported_resource: ${'${resource.type}'}\`);
    },
    async scanResidue() {
      return [];
    },
  };
}
`;
}

function readmeTemplate(id, envPrefix) {
  return `# ${id} adapter

1. Copy \`.env.example\` values into your environment.
2. Keep authentication, routes, selectors, and resource cleanup in \`adapter.js\`.
3. Validate with:

\`\`\`powershell
$env:${envPrefix}_BASE_URL = "http://127.0.0.1:4000"
node ../../src/cli.js validate --manifest ./platform.manifest.yaml --mode readonly --json
\`\`\`
`;
}

function title(value) { return value.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' '); }
function isInside(root, target) { const relative = path.relative(path.resolve(root), target); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
