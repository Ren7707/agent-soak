import fs from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class ResourceRegistry {
  constructor({ artifactDir, runId, prefix }) {
    this.artifactDir = artifactDir;
    this.runId = runId;
    this.prefix = prefix;
    this.resources = [];
  }

  register(resource) {
    if (!resource || !resource.id || !resource.type || !resource.name) throw new Error('resource_invalid');
    if (!resource.name.startsWith(this.prefix)) throw new Error('resource_prefix_mismatch');
    const entry = { ...resource, runId: this.runId, state: 'active', registeredAt: new Date().toISOString() };
    this.resources.push(entry);
    this.persistSync();
    return entry;
  }

  owns(resource) {
    return Boolean(resource && resource.runId === this.runId && typeof resource.name === 'string' && resource.name.startsWith(this.prefix));
  }

  persistSync() {
    const dir = path.join(this.artifactDir, this.runId);
    fsSyncMkdir(dir);
    fsSyncWrite(path.join(dir, 'resources.json'), JSON.stringify(this.resources, null, 2));
  }

  async persist() {
    const dir = path.join(this.artifactDir, this.runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'resources.json'), JSON.stringify(this.resources, null, 2));
  }

  async cleanup(deleteResource, { dryRun = false } = {}) {
    const results = [];
    for (const resource of this.resources.filter((item) => item.state === 'active' || item.state === 'pending')) {
      if (!this.owns(resource)) {
        results.push({ id: resource.id, ok: false, error: 'ownership_check_failed' });
        continue;
      }
      if (dryRun) {
        results.push({ id: resource.id, ok: true, dryRun: true });
        continue;
      }
      try {
        await deleteResource(resource);
        resource.state = 'cleaned';
        resource.cleanedAt = new Date().toISOString();
        results.push({ id: resource.id, ok: true });
      } catch (error) {
        resource.state = 'pending';
        results.push({ id: resource.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await this.persist();
    const pending = this.resources.filter((item) => item.state === 'pending');
    const pendingFile = path.join(this.artifactDir, this.runId, 'cleanup-pending.json');
    if (pending.length) await fs.writeFile(pendingFile, JSON.stringify(pending, null, 2));
    else await fs.rm(pendingFile, { force: true });
    return { ok: pending.length === 0, results, pending };
  }

  static async restore(artifactDir, runId, prefix) {
    const registry = new ResourceRegistry({ artifactDir, runId, prefix });
    const raw = await fs.readFile(path.join(artifactDir, runId, 'resources.json'), 'utf8');
    const resources = JSON.parse(raw);
    if (!Array.isArray(resources)) throw new Error('cleanup_invalid_registry');
    registry.resources = resources;
    return registry;
  }
}

function fsSyncMkdir(dir) { mkdirSync(dir, { recursive: true }); }
function fsSyncWrite(file, content) { writeFileSync(file, content); }

export function createRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `run-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

