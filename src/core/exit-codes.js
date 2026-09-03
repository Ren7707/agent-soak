export const EXIT_CODES = Object.freeze({ success: 0, input: 2, preflight: 3, scenario: 4, cancelled: 5, cleanup: 6 });

export const ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'INPUT_INVALID',
  PREFLIGHT_FAILED: 'PREFLIGHT_FAILED',
  SCENARIO_FAILED: 'SCENARIO_FAILED',
  RUN_CANCELLED: 'RUN_CANCELLED',
  CLEANUP_FAILED: 'CLEANUP_FAILED',
});

export function exitCodeForResult(result) {
  if (result.cleanup && result.cleanup.ok === false) return EXIT_CODES.cleanup;
  if (result.cancelled) return EXIT_CODES.cancelled;
  if (result.status === 'no_scenarios_selected' || result.status === 'runner_failed') return EXIT_CODES.scenario;
  if (Array.isArray(result.scenarios) && result.scenarios.some((scenario) => !scenario.ok)) return EXIT_CODES.scenario;
  return EXIT_CODES.success;
}

export function resultCode(result) {
  if (result.cleanup?.ok === false) return ERROR_CODES.CLEANUP_FAILED;
  if (result.cancelled) return ERROR_CODES.RUN_CANCELLED;
  if (result.status === 'preflight_failed') return ERROR_CODES.PREFLIGHT_FAILED;
  if (['validate', 'discover', 'doctor'].includes(result.command) && result.ok === false) return ERROR_CODES.PREFLIGHT_FAILED;
  if (result.status === 'no_scenarios_selected' || result.status === 'runner_failed' || result.scenarios?.some((scenario) => !scenario.ok)) return ERROR_CODES.SCENARIO_FAILED;
  return undefined;
}
