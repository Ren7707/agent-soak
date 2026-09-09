export interface PlatformManifest {
  schema_version: 1;
  ruleset_version?: string;
  adapter: string;
  platform: {
    id: string;
    name?: string;
    base_url_env: string;
    health_path?: string;
    write_gate_env: string;
    test_data_prefix: string;
    require_cleanup?: boolean;
    production?: boolean;
  };
  capabilities: string[];
  scenarios: ScenarioDeclaration[];
}

export interface ScenarioDeclaration {
  id: string;
  title?: string;
  mode: 'readonly' | 'write';
  capabilities?: string[];
  timeout_ms?: number;
  retries?: number;
  cleanup?: string;
  suite?: string;
  tags?: string[];
  priority?: 'low' | 'medium' | 'high' | 'critical';
}

export type SemanticSampleKind = 'valid' | 'boundary' | 'nearby_semantic' | 'wrong_type' | 'missing' | 'normalization' | 'duplicate' | 'relationship' | 'lifecycle';

export interface SemanticField {
  path: string;
  semantic_type?: string;
  examples?: unknown[];
  negative_examples?: unknown[];
  required?: boolean;
  policy?: SemanticPolicy;
  [key: string]: unknown;
}

export type AllowedValuePolicy = 'known_only' | 'known_or_explicit_custom' | 'observed_or_explicit_custom';

export interface SemanticPolicy {
  allowed_values?: AllowedValuePolicy;
  normalize_case?: boolean;
  trim_whitespace?: boolean;
  generate_risk_cases?: boolean;
  reject_unclassified_value?: boolean;
  unique?: boolean;
  idempotent?: boolean;
  risk_expected?: { accepted?: boolean; resourceCreated?: boolean };
  [key: string]: unknown;
}

export interface ContractCase {
  id?: string;
  case_id?: string;
  case_id_source?: string;
  kind?: SemanticSampleKind;
  input?: Record<string, unknown>;
  expected?: Record<string, unknown>;
  description?: string;
  sequence?: string[];
}

export interface BusinessInvariant {
  id: string;
  description: string;
  type: 'equals' | 'not_equals' | 'in' | 'before' | 'state_transition';
  left?: string;
  right?: string;
  values?: unknown[];
  from?: string;
  to?: string;
  transitions?: Array<{ from: string; to: string }>;
  severity?: 'low' | 'medium' | 'high';
  evidence_refs?: string[];
}

export interface LifecycleTransition {
  from: string;
  to: string;
  expected?: Record<string, unknown>;
  description?: string;
}

export interface LifecycleMachine {
  states: string[];
  transitions: LifecycleTransition[];
  invalid_transitions?: LifecycleTransition[];
}

export interface ScenarioContract {
  field?: string;
  semantic_type?: string;
  policy?: SemanticPolicy;
  risk_profile?: string;
  fields?: SemanticField[];
  cases?: ContractCase[];
  expected?: Record<string, unknown>;
  description?: string;
  invariants?: BusinessInvariant[];
  lifecycle?: LifecycleMachine;
  status?: string;
  review_required?: boolean;
  approved?: boolean;
  confidence?: number;
  evidence_refs?: string[];
}

export interface SourceAnalysisResult {
  ok: boolean;
  command: 'analyze';
  root: string;
  files: string[];
  evidence: Array<Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
  output?: string;
}

export interface ModelPlanScenario {
  id: string;
  mode?: 'readonly' | 'write';
  contract_id?: string;
  evidence_refs?: string[];
  capabilities?: string[];
  suite?: string;
  tags?: string[];
  priority?: 'low' | 'medium' | 'high' | 'critical';
}

export interface ModelTestPlan {
  version: 1;
  status?: string;
  review_required?: boolean;
  approved?: boolean;
  requires_write_approval?: boolean;
  contracts: ScenarioContract[];
  scenarios: ModelPlanScenario[];
}

export interface ReplayPackage {
  version: 1;
  runId: string;
  case_id: string;
  scenario_id: string;
  case_id_source: string;
  kind: SemanticSampleKind;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  sequence: string[];
  ruleset_version: string;
  mode: 'readonly' | 'write';
  status: string;
  category?: string;
  observation_refs: string[];
}

export interface RunEnvironment {
  node: string;
  platform: string;
  arch: string;
  mode: 'readonly' | 'write';
  platform_id: string;
  base_url_configured: boolean;
}

export interface ScenarioResult {
  id: string;
  caseId?: string;
  case_id?: string;
  kind?: SemanticSampleKind;
  round?: number;
  status: string;
  ok: boolean;
  attempts?: number;
  durationMs?: number;
  category?: string;
  error?: string;
  observation_refs?: string[];
  details?: Record<string, unknown>;
  contract?: Record<string, unknown>;
  repro?: { case_id: string; file: string };
}

export interface RunResult {
  result_schema_version: 1;
  ok: boolean;
  command: 'run';
  status: string;
  runId: string;
  mode: 'readonly' | 'write';
  ruleset_version: string;
  environment: RunEnvironment;
  diagnostics: RunDiagnostics;
  rounds: number;
  cancelled: boolean;
  scenarios: ScenarioResult[];
  skipped: Array<{ id: string; reason: string }>;
  preflight: Record<string, unknown>;
  cleanup: Record<string, unknown>;
  observations: Record<string, unknown>;
}

export interface RunDiagnostics {
  status: string;
  counts: { passed: number; failed: number; skipped: number };
  categories: Record<string, number>;
  failures: Array<{ scenario_id: string; case_id?: string; category?: string; observation_refs: string[]; repro?: string }>;
}

export interface RuntimeObserver {
  record(type: string, data?: Record<string, unknown>): string;
  recordRequest(data: Record<string, unknown>): string;
  recordResponse(data: Record<string, unknown>): string;
  recordPage(data: Record<string, unknown>): string;
  recordResource(data: Record<string, unknown>): string;
  recordCleanup(data: Record<string, unknown>): string;
  recordAssertion(data: Record<string, unknown>): string;
  recordUiAction(data: Record<string, unknown>): string;
  fetch(input: unknown, init?: Record<string, unknown>): Promise<unknown>;
  scope(scope?: Record<string, unknown>): RuntimeObservationScope;
}

export interface RuntimeObservationScope extends RuntimeObserver {
  ids: string[];
}

export interface AdapterContext {
  manifest: PlatformManifest;
  baseUrl: string;
  runId?: string;
  round?: number;
  signal?: AbortSignal;
  browser?: unknown;
  registry?: ResourceRegistry;
  observer?: RuntimeObserver;
  scenario?: ScenarioDeclaration;
  testCase?: ContractCase;
  phase?: 'scenario' | 'preflight' | 'cleanup';
  result?: Record<string, unknown> | void;
}

export interface AdapterScenario {
  id: string;
  contract?: ScenarioContract;
  run(context: AdapterContext): Promise<Record<string, unknown> | void>;
  runSequence?(context: AdapterContext): Promise<Record<string, unknown> | void>;
}

export interface Resource {
  id: string;
  type: string;
  name: string;
  runId?: string;
  state?: 'active' | 'pending' | 'cleaned';
  [key: string]: unknown;
}

export interface ResourceRegistry {
  prefix: string;
  register(resource: Resource): Resource;
  owns(resource: Resource): boolean;
}

export interface Adapter {
  preflight(context: AdapterContext): Promise<Record<string, unknown> | void>;
  discover(context: AdapterContext): Promise<Record<string, unknown>>;
  scenarios: AdapterScenario[];
  contracts?: ScenarioContract[] | Record<string, ScenarioContract>;
  observe?(context: AdapterContext): Promise<Record<string, unknown> | void>;
  deleteResource(resource: Resource, context: AdapterContext): Promise<void>;
  scanResidue?(context: AdapterContext): Promise<unknown[]>;
}

export function createAdapter(context: Partial<AdapterContext>): Adapter | Promise<Adapter>;
