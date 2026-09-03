import fs from 'node:fs/promises';
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
    if (!resource || !resource.id || !resource.type) throw new Error('resource_invalid');
    if (!String(resource.name || '').startsWith(this.prefix)) throw new Error('resource_prefix_mismatch');
    const entry = { ...resource, runId: this.runId, state: 'active', registeredAt: new Date().toISOString() };
    this.resources.push(entry);
    return entry;
  }

  owns(resource) {
    return Boolean(resource && resource.runId === this.runId && String(resource.name || '').startsWith(this.prefix));
  }

  async persist() {
    const dir = path.join(this.artifactDir, this.runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'resources.json'), JSON.stringify(this.resources, null, 2));
  }

  async cleanup(deleteResource, { dryRun = false } = {}) {
    const results = [];
    for (const resource of this.resources.filter((item) => item.state === 'active')) {
      if (!this.owns(resource)) {
        results.push({ id: resource.id, ok: false, error: 'ownership_check_failed' });
        continue;
      }
      if (dryRun) { results.push({ id: resource.id, ok: true, dryRun: true }); continue; }
      try {
        await deleteResource(resource);
        resource.state = 'cleaned';
        resource.cleanedAt = new Date().toISOString();
        results.push({ id: resource.id, ok: true });
      } catch (error) {
        resource.state = 'pending';
        results.push({ id: resource.id, ok: false, error: error.message });
      }
    }
    await this.persist();
    const pending = this.resources.filter((item) => item.state === 'pending');
    const dir = path.join(this.artifactDir, this.runId);
    if (pending.length) await fs.writeFile(path.join(dir, 'cleanup-pending.json'), JSON.stringify(pending, null, 2));
    return { ok: pending.length === 0, results, pending };
  }
}

export function createRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `run-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}
