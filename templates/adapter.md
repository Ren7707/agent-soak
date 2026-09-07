# Adapter template

Implement the adapter contract expected by `agent-soak`:

```js
export function createAdapter({ manifest, baseUrl, registry }) {
  return {
    async preflight({ observer }) {
      const request = observer?.fetch?.bind(observer) || fetch;
      const response = await request(`${baseUrl}/health`);
      return { ok: response.ok, status: response.status };
    },
    async discover() { return { capabilities: manifest.capabilities }; },
    async observe({ observer, result }) {
      // Return authoritative state after the action. Do not treat HTTP 2xx alone as success.
      observer?.recordAssertion({ name: 'domain-state', actual: result, status: 'observed' });
      return result;
    },
    scenarios: [
      {
        id: 'example-read',
        mode: 'readonly',
        // timeout_ms and retries are declared in platform.manifest.yaml.
        async run(context) { return { ok: true, details: context.runId }; }
      },
      {
        id: 'register-domain-entity',
        mode: 'write',
        contract: {
          fields: [{
            path: 'value',
            semantic_type: 'domain_specific_value',
            examples: ['valid-example'],
            negative_examples: ['nearby-but-wrong-semantic-value'],
            policy: { normalize_case: true, trim_whitespace: true }
          }]
        },
        async run({ testCase, observer }) {
          // Return deterministic observations for contract assertions.
          observer?.recordRequest({ method: 'POST', url: '/domain-entities', body: testCase.input });
          return { accepted: true, resourceCreated: false, input: testCase.input };
        }
      }
      }
    ],
    async deleteResource(resource, context) {
      // 只删除当前运行登记且匹配测试前缀的资源。
      throw new Error(`cleanup_unsupported_resource: ${resource.type}`);
    },
    async scanResidue() { return []; }
  };
}
```

Keep authentication, selectors, routes, and platform state machines in this
adapter. Do not add them to the framework core.

Use `observer.fetch()` for HTTP calls when request/response evidence is needed.
The runner writes the redacted event stream to `observations.json`; scenario
results contain `observation_refs` so an Agent can trace a conclusion back to
the exact request, response, page state, resource state, and cleanup event.
