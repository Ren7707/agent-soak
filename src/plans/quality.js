const OPERATIONS = new Set(['create', 'read', 'update', 'delete', 'transition', 'search', 'authenticate', 'custom']);
const TRANSPORTS = new Set(['api', 'browser', 'cli', 'adapter', 'observation']);
const ACTIONS = new Set(['submit', 'observe', 'assert', 'cleanup', 'navigate', 'authenticate', 'query', 'update', 'delete', 'custom']);
const RISK_TYPES = new Set(['valid', 'boundary', 'nearby_semantic', 'wrong_type', 'missing', 'normalization', 'duplicate', 'relationship', 'lifecycle']);

export function assessPlanQuality(plan, { evidenceIds = [], conflictFindings = [], allowAmbiguous = false } = {}) {
  const issues = [];
  const evidence = new Set(evidenceIds);
  const contracts = Array.isArray(plan?.contracts) ? plan.contracts : [];
  const scenarios = Array.isArray(plan?.scenarios) ? plan.scenarios : [];
  const contractIds = new Set(contracts.map((contract) => contract?.id).filter(Boolean));
  const referencedContracts = new Set();
  const coveredEvidence = new Set();
  const coveredRisks = new Set();
  const requiredRisks = new Set();
  const operations = new Set();
  const entities = new Set();

  for (const scenario of scenarios) {
    if (scenario?.contract_id) referencedContracts.add(scenario.contract_id);
    for (const ref of [...(scenario?.evidence_refs || []), ...(scenario?.coverage?.evidence_refs || [])]) coveredEvidence.add(ref);
    for (const risk of scenario?.coverage?.risk_types || []) coveredRisks.add(risk);
    if (scenario?.operation) operations.add(scenario.operation);
    if (scenario?.target) entities.add(scenario.target);
    assessScenario(scenario, issues, evidence, contractIds);
  }
  for (const contract of contracts) {
    for (const risk of contract?.required_risks || []) requiredRisks.add(risk);
    for (const ref of contract?.evidence_refs || []) if (!evidence.size || evidence.has(ref)) coveredEvidence.add(ref);
    if (contract?.id && !referencedContracts.has(contract.id)) issues.push({ code: 'contract_unreferenced', severity: 'blocking', contract_id: contract.id, message: `契约未被任何测试场景引用: ${contract.id}` });
  }
  for (const finding of conflictFindings) {
    const field = finding?.field;
    const reviewed = scenarios.some((scenario) => (scenario?.review?.reasons || []).some((reason) => String(reason).includes(field || '__missing__')));
    if (finding?.status === 'review_required' && !reviewed && !allowAmbiguous) issues.push({ code: 'conflict_unacknowledged', severity: 'blocking', field, message: `规则冲突未在测试计划中记录处理意见: ${field || 'unknown'}` });
  }
  for (const ref of coveredEvidence) if (evidence.size && !evidence.has(ref)) issues.push({ code: 'evidence_reference_missing', severity: 'blocking', evidence_ref: ref, message: `计划引用了不存在的证据: ${ref}` });
  for (const risk of coveredRisks) if (!RISK_TYPES.has(risk)) issues.push({ code: 'risk_type_invalid', severity: 'blocking', risk_type: risk, message: `未知风险类型: ${risk}` });
  for (const risk of requiredRisks) if (!coveredRisks.has(risk)) issues.push({ code: 'required_risk_uncovered', severity: 'blocking', risk_type: risk, message: `源码证据要求覆盖但计划未覆盖风险类型: ${risk}` });

  const blocking = issues.some((issue) => issue.severity === 'blocking');
  const score = Math.max(0, Math.round(100 - issues.reduce((total, issue) => total + (issue.severity === 'blocking' ? 20 : 8), 0)));
  return {
    status: blocking ? 'blocked' : issues.length ? 'review_required' : 'pass',
    score,
    blocking,
    issues,
    coverage: {
      contracts: { total: contracts.length, covered: [...referencedContracts].filter((id) => contractIds.has(id)), missing: [...contractIds].filter((id) => !referencedContracts.has(id)) },
      evidence: { declared: [...evidence], covered: [...coveredEvidence], missing: [...evidence].filter((id) => !coveredEvidence.has(id)) },
      operations: [...operations],
      entities: [...entities],
      risks: { required: [...requiredRisks], covered: [...coveredRisks], missing: [...requiredRisks].filter((risk) => !coveredRisks.has(risk)), optional_missing: [...RISK_TYPES].filter((risk) => !coveredRisks.has(risk) && !requiredRisks.has(risk)) },
    },
  };
}

export function assertPlanQuality(plan, options = {}) {
  const quality = assessPlanQuality(plan, options);
  if (quality.blocking) throw new Error(`plan_quality_blocked: ${quality.issues.map((issue) => issue.code).join(',')}`);
  return quality;
}

function assessScenario(scenario, issues, evidence, contractIds) {
  if (!scenario || typeof scenario !== 'object') return;
  const id = scenario.id || '<missing>';
  if (scenario.operation !== undefined && !OPERATIONS.has(scenario.operation)) issues.push({ code: 'operation_invalid', severity: 'blocking', scenario_id: id, message: `场景操作类型无效: ${id}` });
  if (scenario.contract_id && !contractIds.has(scenario.contract_id)) issues.push({ code: 'contract_missing', severity: 'blocking', scenario_id: id, message: `场景引用了不存在的契约: ${scenario.contract_id}` });
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) issues.push({ code: 'steps_missing', severity: 'blocking', scenario_id: id, message: `场景缺少可执行步骤: ${id}` });
  else for (const step of scenario.steps) {
    if (!step || typeof step !== 'object' || typeof step.action !== 'string' || !ACTIONS.has(step.action)) issues.push({ code: 'step_invalid', severity: 'blocking', scenario_id: id, message: `场景包含无效步骤: ${id}` });
    if (step?.transport !== undefined && !TRANSPORTS.has(step.transport)) issues.push({ code: 'step_transport_invalid', severity: 'blocking', scenario_id: id, message: `场景步骤 transport 无效: ${id}` });
  }
  if (!Array.isArray(scenario.assertions) || scenario.assertions.length === 0) issues.push({ code: 'assertions_missing', severity: 'blocking', scenario_id: id, message: `场景缺少业务断言: ${id}` });
  const writes = scenario.mode === 'write' || ['create', 'update', 'delete', 'transition'].includes(scenario.operation);
  const createsResources = scenario.creates_resources !== false && ['create', 'update', 'transition'].includes(scenario.operation);
  const hasCleanup = (scenario.steps || []).some((step) => step?.action === 'cleanup') || scenario.creates_resources === false;
  if (writes && createsResources && !hasCleanup) issues.push({ code: 'cleanup_missing', severity: 'blocking', scenario_id: id, message: `写入场景缺少清理步骤或无资源声明: ${id}` });
  if (!Array.isArray(scenario.evidence_refs) && !Array.isArray(scenario.coverage?.evidence_refs)) issues.push({ code: 'evidence_missing', severity: 'blocking', scenario_id: id, message: `场景缺少源码证据引用: ${id}` });
  for (const ref of [...(scenario.evidence_refs || []), ...(scenario.coverage?.evidence_refs || [])]) if (evidence.size && !evidence.has(ref)) issues.push({ code: 'evidence_reference_missing', severity: 'blocking', scenario_id: id, evidence_ref: ref, message: `场景引用了不存在的证据: ${ref}` });
  if (!Array.isArray(scenario.coverage?.risk_types) || scenario.coverage.risk_types.length === 0) issues.push({ code: 'risk_coverage_missing', severity: 'warning', scenario_id: id, message: `场景没有声明风险覆盖类型: ${id}` });
  if (scenario.mode === 'readonly' && (scenario.steps || []).some((step) => ['submit', 'update', 'delete', 'cleanup'].includes(step?.action) && step?.writes === true)) issues.push({ code: 'readonly_write_step', severity: 'blocking', scenario_id: id, message: `只读场景包含写入步骤: ${id}` });
}
