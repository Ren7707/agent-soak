const SENSITIVE_KEY = /(authorization|access[_-]?key|api[_-]?key|cookie|credential|password|secret|token)/i;
const SENSITIVE_STRING = /((?:bearer|basic)\s+)[^\s,;]+/gi;

export function redact(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.replace(SENSITIVE_STRING, '$1[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  return value;
}
