// oz-erp-edge/src/security.ts
export function applySecurityHeaders(headers: Headers): Headers {
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
  headers.set('cross-origin-resource-policy', 'same-site');

  if (!headers.has('cache-control')) {
    headers.set('cache-control', 'no-store');
  }

  headers.delete('server');
  headers.delete('x-powered-by');

  return headers;
}
