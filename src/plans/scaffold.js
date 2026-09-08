import fs from 'node:fs/promises';
import path from 'node:path';
import { validateManifest } from '../manifest.js';
import { validateModelPlan } from './model.js';

const ID = /^[a-z0-9][a-z0-9-]*$/;

export async function scaffoldFromPlanFile({ cwd = process.cwd(), inputPath, outputDir, id, force = false } = {}) {
  if (!inputPath) throw new Error('scaffold_input_required');
  if (!id || !ID.test(id)) throw new Error('scaffold_id_invalid');
  const root = path.resolve(cwd);
  const input = path.resolve(inputPath);
  const plan = JSON.parse(await fs.readFile(input, 'utf8'));
  validateModelPlan(plan);
  assertApproved(plan);
  const target = path.resolve(outputDir || path.join(root, 'adapters', id));
  if (!isInside(root, target)) throw new Error('scaffold_output_invalid');
  const exists = await fs.access(target).then(() => true).catch(() => false);
  if (exists && !force) throw new Error(`scaffold_target_exists: ${path.relative(root, target)}`);

  const manifest = buildManifest(id, plan);
  validateManifest(manifest);
  const contracts = plan.contracts.map(sanitizeContract);
  await fs.mkdir(target, { recursive: true });
  const files = {
    'platform.manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'adapter.js': adapterTemplate(manifest, plan.scenarios, contracts),
    'contracts.json': `${JSON.stringify({ version: 1, status: 'approved', contracts }, null, 2)}\n`,
    'README.md': readmeTemplate(id),
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(target, name), content, { flag: force ? 'w' : 'wx' });
  return { ok: true, command: 'scaffold', id, directory: target, files: Object.keys(files), mode: 'skeleton', executes: false };
}

function assertApproved(plan) {
  if (plan.status !== 'approved' || plan.review_required !== false || plan.approved !== true) throw new Error('scaffold_plan_not_approved');
  for (const contract of plan.contracts) if (contract.status !== 'approved' || contract.review_required !== false || contract.approved !== true) throw new Error(`scaffold_contract_not_approved: ${contract.id || '<missing>'}`);
}

function buildManifest(id, plan) {
  const capabilities = [...new Set(plan.scenarios.flatMap((scenario) => Array.isArray(scenario.capabilities) ? scenario.capabilities : []))];
  return {
    schema_version: 1,
    adapter: './adapter.js',
    platform: { id, name: title(id), base_url_env: `${envName(id)}_BASE_URL`, health_path: '/health', write_gate_env: 'ALLOW_TEST_WRITES', test_data_prefix: 'SOAK_', require_cleanup: true, production: false },
    capabilities,
    scenarios: plan.scenarios.map((scenario) => ({ id: scenario.id, mode: scenario.mode || 'readonly' })),
  };
}

function adapterTemplate(manifest, planScenarios, contracts) {
  const declarations = JSON.stringify(planScenarios.map((scenario) => ({ ...scenario, mode: scenario.mode || 'readonly' })), null, 2);
  const contractMap = JSON.stringify(Object.fromEntries(contracts.filter((contract) => contract.id).map((contract) => [contract.id, contract])), null, 2);
  return `const declarations = ${declarations};\nconst contracts = ${contractMap};\n\nexport function createAdapter() {\n  return {\n    contracts,\n    async preflight() { return { ok: false, issues: [{ error: 'adapter_preflight_not_implemented' }] }; },\n    async discover() { return { capabilities: ${JSON.stringify(manifest.capabilities)}, scenarioIds: declarations.map((item) => item.id) }; },\n    scenarios: declarations.map((declaration) => ({\n      id: declaration.id,\n      contract: declaration.contract_id ? contracts[declaration.contract_id] : undefined,\n      async run() { throw new Error(\`scenario_not_implemented: \${declaration.id}\`); },\n    })),\n    async deleteResource(resource) { throw new Error(\`cleanup_not_implemented: \${resource?.type || 'resource'}\`); },\n    async scanResidue() { return []; },\n  };\n}\n`;
}

function sanitizeContract(contract) { return sanitizeValue(contract, ''); }
function sanitizeValue(value, key) {
  if (/(authorization|access[_-]?key|api[_-]?key|cookie|credential|password|secret|token|source|evidence|private|tenant|organization|account)/i.test(key)) return undefined;
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s"']+/gi, '[REDACTED_URL]').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]');
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey)]).filter(([, childValue]) => childValue !== undefined));
  return value;
}

function readmeTemplate(id) {
  return `# ${id} 测试适配器骨架\n\n这是由已审核测试计划生成的通用骨架。它不会连接目标平台，也不会伪造测试通过结果。\n\n## 完成清单\n\n1. 在 adapter.js 中实现认证、路由、页面定位器和业务断言。\n2. 为每个场景补充真实操作、状态观察和资源登记。\n3. 实现清理与残留扫描，并确认测试数据前缀隔离。\n4. 先执行只读校验，再按需通过 CLI 和环境变量双重授权启用写入。\n\n生成的 Manifest 默认使用 ${envName(id)}_BASE_URL 和 ALLOW_TEST_WRITES。\n`;
}

function envName(id) { return id.replace(/-/g, '_').toUpperCase(); }
function title(value) { return value.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' '); }
function isInside(root, target) { const relative = path.relative(root, target); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
