export interface PlatformManifest {
  schema_version: 1;
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
}

export type SemanticSampleKind = 'valid' | 'boundary' | 'nearby_semantic' | 'wrong_type' | 'missing' | 'normalization' | 'duplicate' | 'relationship';

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
  risk_expected?: { accepted?: boolean; resourceCreated?: boolean };
  [key: string]: unknown;
}

export interface ContractCase {
  id?: string;
  kind?: SemanticSampleKind;
  input?: Record<string, unknown>;
  expected?: Record<string, unknown>;
  description?: string;
}

export interface ScenarioContract {
  field?: string;
  semantic_type?: string;
  policy?: SemanticPolicy;
  risk_profile?: string;
  fields?: SemanticField[];
  cases?: ContractCase[];
  expected?: Record<string, unknown>;
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
