import fs from 'node:fs/promises';
import path from 'node:path';
import { redact } from '../core/redact.js';

const SENSITIVE_KEY = /(authorization|access[_-]?key|api[_-]?key|cookie|credential|password|secret|token)/i;
const MAX_STRING_LENGTH = 2000;
const MAX_ARRAY_ITEMS = 100;
const MAX_DEPTH = 5;

export class RuntimeObserver {
  constructor({ artifactDir, runId, now = () => new Date() } = {}) {
    if (!artifactDir || !runId) throw new Error('observation_context_required');
    this.artifactDir = artifactDir;
    this.runId = runId;
    this.now = now;
    this.sequence = 0;
    this._events = [];
  }

  get events() {
    return this._events.map((event) => ({ ...event }));
  }

  record(type, data = {}, scope = undefined) {
    if (!/^[a-z][a-z0-9_.-]*$/.test(String(type))) throw new Error('observation_type_invalid');
    const event = {
      id: `observation-${String(++this.sequence).padStart(5, '0')}`,
      timestamp: this.now().toISOString(),
      type: String(type),
      ...(scope && Object.keys(scope).length ? { scope: sanitize(scope) } : {}),
      data: sanitize(data),
    };
    this._events.push(event);
    return event.id;
  }

  scope(scope = {}) {
    return new RuntimeObservationScope(this, scope);
  }

  recordRequest(data) { return this.record('request', data); }
  recordResponse(data) { return this.record('response', data); }
  recordPage(data) { return this.record('page', data); }
  recordResource(data) { return this.record('resource', data); }
  recordCleanup(data) { return this.record('cleanup', data); }
  recordAssertion(data) { return this.record('assertion', data); }
  recordUiAction(data) { return this.record('ui_action', data); }

  async fetch(input, init = {}) {
    return this._fetch(input, init);
  }

  summary() {
    const types = {};
    for (const event of this._events) types[event.type] = (types[event.type] || 0) + 1;
    return { count: this._events.length, types };
  }

  async persist() {
    const directory = path.join(this.artifactDir, this.runId);
    const file = path.join(directory, 'observations.json');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ version: 1, runId: this.runId, events: this._events }, null, 2)}\n`, 'utf8');
    return file;
  }

  async _fetch(input, init = {}, scope = undefined, ids = undefined) {
    const request = input instanceof Request ? input : null;
    const method = String(init.method || request?.method || 'GET').toUpperCase();
    const url = request?.url || String(input);
    const requestId = this.recordScoped('request', {
      method,
      url,
      headers: headersToObject(init.headers || request?.headers),
      body: bodyForObservation(init.body),
    }, scope);
    ids?.push(requestId);
    const started = Date.now();
    try {
      const response = await fetch(input, init);
      const body = await response.clone().text().catch(() => undefined);
      const responseId = this.recordScoped('response', {
        requestId,
        method,
        url,
        status: response.status,
        ok: response.ok,
        headers: headersToObject(response.headers),
        body,
        durationMs: Date.now() - started,
      }, scope);
      ids?.push(responseId);
      return response;
    } catch (error) {
      const responseId = this.recordScoped('response', {
        requestId,
        method,
        url,
        status: null,
        ok: false,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      }, scope);
      ids?.push(responseId);
      throw error;
    }
  }

  recordScoped(type, data, scope) {
    const event = {
      id: `observation-${String(++this.sequence).padStart(5, '0')}`,
      timestamp: this.now().toISOString(),
      type: String(type),
      ...(scope && Object.keys(scope).length ? { scope: sanitize(scope) } : {}),
      data: sanitize(data),
    };
    this._events.push(event);
    return event.id;
  }
}

class RuntimeObservationScope {
  constructor(parent, scope) {
    this.parent = parent;
    this.scopeData = { ...scope };
    this.ids = [];
  }

  record(type, data = {}) {
    const id = this.parent.recordScoped(type, data, this.scopeData);
    this.ids.push(id);
    return id;
  }

  recordRequest(data) { return this.record('request', data); }
  recordResponse(data) { return this.record('response', data); }
  recordPage(data) { return this.record('page', data); }
  recordResource(data) { return this.record('resource', data); }
  recordCleanup(data) { return this.record('cleanup', data); }
  recordAssertion(data) { return this.record('assertion', data); }
  recordUiAction(data) { return this.record('ui_action', data); }

  async fetch(input, init = {}) {
    const ids = [];
    const response = await this.parent._fetch(input, init, this.scopeData, ids);
    this.ids.push(...ids);
    return response;
  }

  summary() { return { count: this.ids.length, observation_refs: [...this.ids] }; }
}

function headersToObject(headers) {
  if (!headers) return undefined;
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  if (typeof headers === 'object') return { ...headers };
  return undefined;
}

function bodyForObservation(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return body; }
  }
  if (body instanceof URLSearchParams) return body.toString();
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  return body;
}

function sanitize(value, key = '', depth = 0, seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redact(value).slice(0, MAX_STRING_LENGTH);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, '', depth + 1, seen));
  return Object.fromEntries(Object.entries(value).slice(0, MAX_ARRAY_ITEMS).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey, depth + 1, seen)]));
}
