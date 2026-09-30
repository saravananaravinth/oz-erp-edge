// oz-erp-edge/src/gateway/http/request-context.ts
const REQUEST_ID_PATTERN = /^[A-Za-z0-9:_./@-]{8,128}$/u;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u;
const ZERO_TRACE_ID = '00000000000000000000000000000000';
const ZERO_PARENT_ID = '0000000000000000';

export type RequestContext = Readonly<{
  requestId: string;
  correlationId: string;
  traceparent: string | null;
  startedAtMs: number;
}>;

function getSafeHeader(headers: Headers, name: string): string | null {
  const value = headers.get(name)?.trim() ?? '';
  return REQUEST_ID_PATTERN.test(value) ? value : null;
}

export function normalizeTraceparent(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  const match = TRACEPARENT_PATTERN.exec(normalized);
  if (match === null) return null;

  const traceId = match[1];
  const parentId = match[2];
  if (traceId === undefined || parentId === undefined) return null;
  if (traceId === ZERO_TRACE_ID || parentId === ZERO_PARENT_ID) return null;
  return normalized;
}

export function createRequestContext(request: Request): RequestContext {
  const requestId = getSafeHeader(request.headers, 'x-request-id') ?? crypto.randomUUID();
  const correlationId = getSafeHeader(request.headers, 'x-correlation-id') ?? requestId;
  const traceparent = normalizeTraceparent(request.headers.get('traceparent'));

  return { requestId, correlationId, traceparent, startedAtMs: Date.now() };
}
