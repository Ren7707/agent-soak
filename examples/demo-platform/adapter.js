export function createAdapter() {
  return {
    async preflight({ baseUrl, manifest }) {
      const response = await fetch(`${baseUrl}${manifest.platform.health_path || '/health'}`);
      return { ok: response.ok, endpoint: manifest.platform.health_path || '/health', status: response.status };
    },

    async discover({ baseUrl, manifest }) {
      const response = await fetch(`${baseUrl}/items`);
      const body = response.ok ? await response.json() : null;
      return { capabilities: manifest.capabilities, scenarioIds: manifest.scenarios.map((item) => item.id), itemCount: body?.items?.length ?? null };
    },

    scenarios: [
      {
        id: 'health',
        async run({ baseUrl, manifest }) {
          const response = await fetch(`${baseUrl}${manifest.platform.health_path || '/health'}`);
          if (!response.ok) throw new Error(`health_http_${response.status}`);
          return { ok: true, status: response.status };
        },
      },
      {
        id: 'list-items',
        async run({ baseUrl }) {
          const response = await fetch(`${baseUrl}/items`);
          if (!response.ok) throw new Error(`items_http_${response.status}`);
          const body = await response.json();
          return { ok: true, count: body.items.length };
        },
      },
      {
        id: 'create-delete-item',
        async run({ baseUrl, round, registry }) {
          const name = `${registry.prefix}item-${round}`;
          const response = await fetch(`${baseUrl}/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
          if (!response.ok) throw new Error(`create_http_${response.status}`);
          const item = await response.json();
          registry.register({ id: item.id, type: 'item', name });
          return { ok: true, id: item.id };
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

    async deleteResource(resource, { baseUrl }) {
      if (resource.type !== 'item') throw new Error(`cleanup_unsupported_resource: ${resource.type}`);
      const response = await fetch(`${baseUrl}/items/${encodeURIComponent(resource.id)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw new Error(`cleanup_http_${response.status}`);
    },

    async scanResidue({ baseUrl, prefix }) {
      const response = await fetch(`${baseUrl}/items?prefix=${encodeURIComponent(prefix)}`);
      if (!response.ok) throw new Error(`residue_http_${response.status}`);
      const body = await response.json();
      return body.items || [];
    },
  };
}
