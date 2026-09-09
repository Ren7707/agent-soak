import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function resolveRunProvenance({ manifestPath, manifest } = {}) {
  const root = manifestPath ? path.dirname(path.resolve(manifestPath)) : undefined;
  const adapterPath = root && manifest?.adapter ? path.resolve(root, manifest.adapter) : undefined;
  return {
    plan_fingerprint: await fingerprintPlan(root, manifest?.plan_file),
    conflict_report_fingerprint: await fingerprintFile(root, manifest?.conflict_report_file),
    adapter_fingerprint: adapterPath ? await fingerprintFile(undefined, adapterPath) : null,
  };
}

async function fingerprintPlan(root, file) {
  if (!file) return null;
  const resolved = path.resolve(root || process.cwd(), file);
  const raw = await fs.readFile(resolved, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (raw === null) return null;
  try {
    const plan = JSON.parse(raw);
    return plan?.approval?.plan_fingerprint || sha256(raw);
  } catch {
    return sha256(raw);
  }
}

async function fingerprintFile(root, file) {
  if (!file) return null;
  const resolved = root ? path.resolve(root, file) : path.resolve(file);
  const raw = await fs.readFile(resolved).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  return raw === null ? null : sha256(raw);
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }