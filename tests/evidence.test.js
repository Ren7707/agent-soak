import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeObserver } from '../src/evidence/index.js';

test('runtime observer scopes, redacts, and persists evidence events', async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-observations-'));
  try {
    const observer = new RuntimeObserver({ artifactDir, runId: 'run-test', now: () => new Date('2026-09-07T00:00:00.000Z') });
    const scoped = observer.scope({ scenario: 'register-device', case: 'nearby-platform' });
    const id = scoped.recordRequest({ headers: { authorization: 'Bearer secret-token' }, body: { password: 'secret', platform: 'test computer 0001' } });
    scoped.recordPage({ url: 'https://demo.test/device', title: 'Device' });
    const file = await observer.persist();
    const body = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(id, 'observation-00001');
    assert.equal(body.events[0].scope.scenario, 'register-device');
    assert.equal(body.events[0].data.headers.authorization, '[REDACTED]');
    assert.equal(body.events[0].data.body.password, '[REDACTED]');
    assert.deepEqual(observer.summary().types, { request: 1, page: 1 });
  } finally {
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});

test('observer fetch records request and response without consuming the response body', async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-fetch-observations-'));
  try {
    const observer = new RuntimeObserver({ artifactDir, runId: 'run-fetch' });
    const response = await observer.fetch('data:application/json,%7B%22ok%22%3Atrue%7D', { headers: { authorization: 'Bearer secret-token' } });
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(observer.events.map((event) => event.type), ['request', 'response']);
    assert.equal(observer.events[0].data.headers.authorization, '[REDACTED]');
    assert.equal(observer.events[1].data.ok, true);
  } finally {
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});

test('runtime observer hides URL hosts by default and supports explicit full URL mode', async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-url-privacy-'));
  try {
    const observer = new RuntimeObserver({ artifactDir, runId: 'run-path' });
    observer.recordPage({ url: 'https://private.example.test/devices?token=secret&view=all' });
    assert.equal(observer.events[0].data.url, '/devices?token=%5BREDACTED%5D&view=all');
    const full = new RuntimeObserver({ artifactDir, runId: 'run-full', urlMode: 'full' });
    full.recordPage({ url: 'https://private.example.test/devices?token=secret&view=all' });
    assert.equal(full.events[0].data.url, 'https://private.example.test/devices?token=[REDACTED]&view=all');
  } finally {
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});
