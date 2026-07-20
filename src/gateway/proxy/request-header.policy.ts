import type { RequestContext } from '../http/request-context.js';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const FORBIDDEN_INBOUND_HEADERS = new Set([
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'content-encoding',
  'content-length',
  'cookie',
  'forwarded',
  'host',
  'x-goog-authenticated-user-email',
  'x-goog-authenticated-user-id',
  'x-oz-edge-gateway',
  'x-oz-task-secret',
  'x-real-ip',
  'x-serverless-authorization',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

export function isForbiddenInboundHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    HOP_BY_HOP_HEADERS.has(normalized) ||
    FORBIDDEN_INBOUND_HEADERS.has(normalized) ||
    normalized.startsWith('cf-') ||
    normalized.startsWith('x-cloudtasks-') ||
    normalized.startsWith('x-goog-') ||
    normalized.startsWith('x-appengine-') ||
    normalized.startsWith('x-envoy-')
  );
}

function getClientIp(request: Request): string | null {
  const value = request.headers.get('cf-connecting-ip')?.trim() ?? '';
  return value.length > 0 && value.length <= 128 ? value : null;
}

export function buildBackendHeaders(input: {
  readonly request: Request;
  readonly invocationToken: string | null;
  readonly requestContext: RequestContext;
}): Headers {
  const headers = new Headers();

  input.request.headers.forEach((value, name) => {
    if (!isForbiddenInboundHeader(name)) headers.set(name, value);
  });

  if (input.invocationToken !== null) {
    headers.set('x-serverless-authorization', `Bearer ${input.invocationToken}`);
  }

  headers.set('x-request-id', input.requestContext.requestId);
  headers.set('x-correlation-id', input.requestContext.correlationId);
  headers.set(
    'x-forwarded-proto',
    new URL(input.request.url).protocol === 'http:' ? 'http' : 'https',
  );
  headers.set('x-oz-edge-gateway', 'cloudflare-worker');

  const clientIp = getClientIp(input.request);
  if (clientIp !== null) headers.set('x-forwarded-for', clientIp);
  return headers;
}
