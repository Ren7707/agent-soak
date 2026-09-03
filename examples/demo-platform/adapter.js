export function createAdapter() {
  return {
    name: 'demo-platform',
    scenarios: ['health', 'list-items', 'create-delete-item'],
    contract: 'The demo adapter exposes the platform-specific routes used by the public example.'
  };
}
