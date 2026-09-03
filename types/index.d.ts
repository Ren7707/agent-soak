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

export interface AdapterContext {
  manifest: PlatformManifest;
  baseUrl: string;
  runId?: string;
  round?: number;
  signal?: AbortSignal;
  browser?: unknown;
  registry?: ResourceRegistry;
  scenario?: ScenarioDeclaration;
}

export interface AdapterScenario {
  id: string;
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
  deleteResource(resource: Resource, context: AdapterContext): Promise<void>;
  scanResidue?(context: AdapterContext): Promise<unknown[]>;
}

export function createAdapter(context: Partial<AdapterContext>): Adapter | Promise<Adapter>;
