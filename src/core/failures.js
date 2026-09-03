export function classifyFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/cleanup|ownership|residue/i.test(message)) return 'cleanup';
  if (/401|403|permission|forbidden|unauthorized/i.test(message)) return 'permission';
  if (/fetch failed|ECONN|ENOTFOUND|timeout|health_http_5/i.test(message)) return 'environment';
  if (/adapter|manifest|scenario_not|configuration|schedule|duration|argument/i.test(message)) return 'script';
  return 'product';
}
