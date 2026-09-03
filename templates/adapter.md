# Adapter template

Implement the adapter contract expected by `agent-soak`:

```js
export function createAdapter({ manifest, baseUrl, fetchImpl, registry }) {
  return {
    async preflight() {},
    async discover() { return { capabilities: manifest.capabilities }; },
    scenarios: [
      {
        id: 'example-read',
        mode: 'readonly',
        // timeout_ms and retries are declared in platform.manifest.yaml.
        async run(context) { return { ok: true, details: context.runId }; }
      }
    ],
    async cleanup() { return { ok: true }; }
  };
}
```

Keep authentication, selectors, routes, and platform state machines in this
adapter. Do not add them to the framework core.
