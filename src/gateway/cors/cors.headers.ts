import type { WorkerConfig } from '../../config/index.js';

const CORS_RESPONSE_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
  'access-control-allow-private-network',
] as const;
const WILDCARD_ORIGIN = '*';

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get('vary');
  if (existing === null || existing.trim().length === 0) {
    headers.set('vary', value);
    return;
  }
  if (existing.trim() === '*') return;

  const values = existing
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!values.includes(value.toLowerCase())) headers.set('vary', `${existing}, ${value}`);
}

function deleteCorsHeaders(headers: Headers): void {
  for (const name of CORS_RESPONSE_HEADERS) headers.delete(name);
}

function hasWildcardOrigin(config: WorkerConfig): boolean {
  return config.ALLOWED_ORIGINS.includes(WILDCARD_ORIGIN);
}

export function isOriginAllowed(origin: string | null, config: WorkerConfig): boolean {
  return origin === null || hasWildcardOrigin(config) || config.ALLOWED_ORIGINS.includes(origin);
}

function resolveAllowOrigin(origin: string | null, config: WorkerConfig): string | null {
  if (origin === null || !isOriginAllowed(origin, config)) return null;
  return hasWildcardOrigin(config) ? WILDCARD_ORIGIN : origin;
}

function applyCorsHeaders(
  headers: Headers,
  origin: string | null,
  config: WorkerConfig,
  preflight: boolean,
): void {
  deleteCorsHeaders(headers);
  appendVary(headers, 'Origin');
  if (preflight) {
    appendVary(headers, 'Access-Control-Request-Method');
    appendVary(headers, 'Access-Control-Request-Headers');
  }

  headers.set('access-control-allow-methods', config.ALLOWED_METHODS.join(','));
  headers.set('access-control-allow-headers', config.ALLOWED_HEADERS.join(','));
  headers.set('access-control-expose-headers', config.EXPOSED_HEADERS.join(','));
  headers.set('access-control-max-age', String(config.CORS_MAX_AGE_SECONDS));

  const allowOrigin = resolveAllowOrigin(origin, config);
  if (allowOrigin !== null) headers.set('access-control-allow-origin', allowOrigin);
  if (config.CORS_ALLOW_CREDENTIALS && !hasWildcardOrigin(config)) {
    headers.set('access-control-allow-credentials', 'true');
  }
}

export function buildCorsHeaders(
  origin: string | null,
  config: WorkerConfig,
  options: Readonly<{ preflight?: boolean }> = {},
): Headers {
  const headers = new Headers();
  applyCorsHeaders(headers, origin, config, options.preflight === true);
  return headers;
}

export function withCorsHeaders(
  response: Response,
  origin: string | null,
  config: WorkerConfig,
  options: Readonly<{ preflight?: boolean }> = {},
): Response {
  const headers = new Headers(response.headers);
  applyCorsHeaders(headers, origin, config, options.preflight === true);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isExactHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname === '/' &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

function rawAllowlistContains(origin: string, rawAllowedOrigins: string | undefined): boolean {
  if (!isExactHttpOrigin(origin)) return false;
  return (rawAllowedOrigins ?? '')
    .split(',')
    .map((value) => value.trim())
    .some((value) => value !== WILDCARD_ORIGIN && value === origin);
}

export function withConfigFailureCorsHeaders(
  response: Response,
  origin: string | null,
  rawAllowedOrigins: string | undefined,
): Response {
  const headers = new Headers(response.headers);
  deleteCorsHeaders(headers);
  appendVary(headers, 'Origin');
  if (origin !== null && rawAllowlistContains(origin, rawAllowedOrigins)) {
    headers.set('access-control-allow-origin', origin);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
