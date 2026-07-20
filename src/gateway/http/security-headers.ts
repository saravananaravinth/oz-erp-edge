const API_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

export function applySecurityHeaders(headers: Headers): Headers {
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('x-dns-prefetch-control', 'off');
  headers.set('x-permitted-cross-domain-policies', 'none');
  headers.set('permissions-policy', 'camera=(), microphone=(), payment=(), usb=()');

  if (!headers.has('content-security-policy')) {
    headers.set('content-security-policy', API_CONTENT_SECURITY_POLICY);
  }
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');

  headers.delete('server');
  headers.delete('x-powered-by');
  return headers;
}
