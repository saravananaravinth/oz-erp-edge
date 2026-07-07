// oz-erp-edge/src/problem.ts
export type ProblemStatus = 400 | 401 | 403 | 404 | 405 | 413 | 415 | 502 | 503 | 504;

export type ProblemDetails = Readonly<{
  type: string;
  title: string;
  status: ProblemStatus;
  detail: string;
  code: string;
  request_id: string;
  timestamp: string;
}>;

export function problemJson(input: {
  readonly status: ProblemStatus;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly requestId: string;
  readonly headers?: HeadersInit;
}): Response {
  const body: ProblemDetails = {
    type: `https://api.ozotec.example/problems/${input.code.toLowerCase()}`,
    title: input.title,
    status: input.status,
    detail: input.detail,
    code: input.code,
    request_id: input.requestId,
    timestamp: new Date().toISOString(),
  };

  const headers = new Headers(input.headers);
  headers.set('content-type', 'application/problem+json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-request-id', input.requestId);

  return new Response(JSON.stringify(body), {
    status: input.status,
    headers,
  });
}
