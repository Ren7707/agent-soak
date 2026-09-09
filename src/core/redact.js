const SENSITIVE_KEY = /(authorization|access[_-]?key|api[_-]?key|cookie|credential|password|secret|token)/i;
const SENSITIVE_STRING = /((?:bearer|basic)\s+)[^\s,;]+/gi;
const SENSITIVE_QUERY = /([?&](?:token|password|secret|key)=)[^&#\s]+/gi;
const SENSITIVE_URL = /\bhttps?:\/\/[^\s<>'"`]+/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gi;

export function redact(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  return value;
}

export function redactString(value, { urls = true } = {}) {
  return String(value)
    .replace(PRIVATE_KEY, '[REDACTED_PRIVATE_KEY]')
    .replace(SENSITIVE_STRING, '$1[REDACTED]')
    .replace(SENSITIVE_QUERY, '$1[REDACTED]')
    .replace(EMAIL, '[REDACTED_EMAIL]')
    .replace(urls ? SENSITIVE_URL : /$^/g, '[REDACTED_URL]');
}
