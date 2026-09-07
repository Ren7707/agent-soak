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
        async run({ testCase }) {
          // Return deterministic observations for contract assertions.
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
