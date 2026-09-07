export function createAdapter() {
  return {
    async preflight({ baseUrl, manifest, observer }) {
      const request = observer?.fetch?.bind(observer) || fetch;
      const response = await request(`${baseUrl}${manifest.platform.health_path || '/health'}`);
      return { ok: response.ok, endpoint: manifest.platform.health_path || '/health', status: response.status };
    },

    async discover({ baseUrl, manifest, observer }) {
      const request = observer?.fetch?.bind(observer) || fetch;
      const response = await request(`${baseUrl}/items`);
      const body = response.ok ? await response.json() : null;
      return { capabilities: manifest.capabilities, scenarioIds: manifest.scenarios.map((item) => item.id), itemCount: body?.items?.length ?? null };
    },

    scenarios: [
      {
        id: 'health',
        async run({ baseUrl, manifest, observer }) {
          const request = observer?.fetch?.bind(observer) || fetch;
          const response = await request(`${baseUrl}${manifest.platform.health_path || '/health'}`);
          if (!response.ok) throw new Error(`health_http_${response.status}`);
          return { ok: true, status: response.status };
        },
      },
      {
        id: 'list-items',
        async run({ baseUrl, observer }) {
          const request = observer?.fetch?.bind(observer) || fetch;
          const response = await request(`${baseUrl}/items`);
          if (!response.ok) throw new Error(`items_http_${response.status}`);
          const body = await response.json();
          return { ok: true, count: body.items.length };
        },
      },
      {
        id: 'create-delete-item',
        async run({ baseUrl, round, registry, observer }) {
          const name = `${registry.prefix}item-${round}`;
          const request = observer?.fetch?.bind(observer) || fetch;
          const response = await request(`${baseUrl}/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
          if (!response.ok) throw new Error(`create_http_${response.status}`);
          const item = await response.json();
          registry.register({ id: item.id, type: 'item', name });
          return { ok: true, id: item.id };
        },
      },
      {
        id: 'register-device-semantic',
        contract: {
          field: 'platform',
          semantic_type: 'operating_system_platform',
          status: 'approved',
          approved: true,
          fields: [{
            path: 'platform',
            semantic_type: 'operating_system_platform',
            examples: ['Linux'],
            negative_examples: ['test computer 0001'],
            policy: { allowed_values: 'known_only', reject_unclassified_value: true, generate_risk_cases: true },
          }],
        },
        async run({ baseUrl, round, registry, testCase, observer }) {
          const name = `${registry.prefix}device-${round}-${testCase.id}`;
          const request = observer?.fetch?.bind(observer) || fetch;
          const response = await request(`${baseUrl}/devices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, platform: testCase.input.platform }) });
          const body = await response.json().catch(() => null);
          const created = Boolean(body?.id);
          if (created) registry.register({ id: body.id, type: 'device', name, platform: body.platform });
          return { accepted: response.ok, resourceCreated: created, statusCode: response.status, resource: body };
        },
      },
      {
        id: 'browser-home',
        async run({ baseUrl, browser }) {
          if (!browser) throw new Error('browser_not_available');
          await browser.goto(`${baseUrl}/`);
          const heading = await browser.text('[data-testid="demo-title"]');
          if (heading !== 'Public Demo Platform') throw new Error(`browser_heading_unexpected: ${heading}`);
          await browser.screenshot('home');
          return { ok: true, title: await browser.title(), heading };
        },
      },
    ],

    async deleteResource(resource, { baseUrl, observer }) {
      if (!['item', 'device'].includes(resource.type)) throw new Error(`cleanup_unsupported_resource: ${resource.type}`);
      const request = observer?.fetch?.bind(observer) || fetch;
      const response = await request(`${baseUrl}/${resource.type === 'device' ? 'devices' : 'items'}/${encodeURIComponent(resource.id)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw new Error(`cleanup_http_${response.status}`);
    },

    async scanResidue({ baseUrl, prefix, observer }) {
      const request = observer?.fetch?.bind(observer) || fetch;
      const [itemsResponse, devicesResponse] = await Promise.all([
        request(`${baseUrl}/items?prefix=${encodeURIComponent(prefix)}`),
        request(`${baseUrl}/devices?prefix=${encodeURIComponent(prefix)}`),
      ]);
      if (!itemsResponse.ok) throw new Error(`residue_items_http_${itemsResponse.status}`);
      if (!devicesResponse.ok) throw new Error(`residue_devices_http_${devicesResponse.status}`);
      const [items, devices] = await Promise.all([itemsResponse.json(), devicesResponse.json()]);
      return [...(items.items || []), ...(devices.devices || [])];
    },
  };
}
