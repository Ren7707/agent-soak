export const EXIT_CODES = Object.freeze({ success: 0, input: 2, preflight: 3, scenario: 4, cancelled: 5, cleanup: 6 });

export function exitCodeForResult(result) {
  if (result.cleanup && result.cleanup.ok === false) return EXIT_CODES.cleanup;
  if (result.cancelled) return EXIT_CODES.cancelled;
  if (Array.isArray(result.scenarios) && result.scenarios.some((scenario) => !scenario.ok)) return EXIT_CODES.scenario;
  return EXIT_CODES.success;
}
