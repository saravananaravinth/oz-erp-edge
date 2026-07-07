// oz-erp-edge/src/request-context.ts
const REQUEST_ID_PATTERN = /^[A-Za-z0-9:_./@-]{8,128}$/u;

export type RequestContext = Readonly<{
  requestId: string;
  correlationId: string;
  startedAtMs: number;
}>;

function getSafeHeader(headers: Headers, name: string): string | null {
  const value = headers.get(name);

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : null;
}

export function createRequestContext(request: Request): RequestContext {
  const requestId = getSafeHeader(request.headers, 'x-request-id') ?? crypto.randomUUID();
  const correlationId = getSafeHeader(request.headers, 'x-correlation-id') ?? requestId;

  return {
    requestId,
    correlationId,
    startedAtMs: Date.now(),
  };
}
