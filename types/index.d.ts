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
  policy?: Record<string, unknown>;
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
  policy?: Record<string, unknown>;
  fields?: SemanticField[];
  cases?: ContractCase[];
  expected?: Record<string, unknown>;
}

export interface SourceAnalysisResult {
  ok: boolean;
  command: 'analyze';
  root: string;
  files: string[];
  evidence: Array<Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
}

export interface AdapterContext {
  manifest: PlatformManifest;
  baseUrl: string;
  runId?: string;
  round?: number;
  signal?: AbortSignal;
  browser?: unknown;
  registry?: ResourceRegistry;
  scenario?: ScenarioDeclaration;
  testCase?: ContractCase;
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
  deleteResource(resource: Resource, context: AdapterContext): Promise<void>;
  scanResidue?(context: AdapterContext): Promise<unknown[]>;
}

export function createAdapter(context: Partial<AdapterContext>): Adapter | Promise<Adapter>;
