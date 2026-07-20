import { applySecurityHeaders } from '../http/security-headers.js';
import type { RequestContext } from '../http/request-context.js';

const FORBIDDEN_RESPONSE_HEADERS = new Set(['server', 'x-powered-by']);

export function sanitizeBackendResponse(
  response: Response,
  requestContext: RequestContext,
): Response {
  const headers = new Headers(response.headers);
  for (const name of FORBIDDEN_RESPONSE_HEADERS) headers.delete(name);

  headers.set('x-request-id', requestContext.requestId);
  headers.set('x-correlation-id', requestContext.correlationId);
  applySecurityHeaders(headers);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
