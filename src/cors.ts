// oz-erp-edge/src/cors.ts
import type { Context, MiddlewareHandler, Next } from 'hono';

import type { WorkerConfig, WorkerEnv } from './config.js';
import { shouldRequireOrigin } from './origin-policy.js';
import { resolveBackendPath } from './route-policy.js';
import { problemJson } from './problem.js';
import type { RequestContext } from './request-context.js';

type HonoBindings = Readonly<WorkerEnv>;

type HonoVariables = Readonly<{
  requestContext: RequestContext;
  workerConfig: WorkerConfig;
}>;

type HonoContext = Context<{
  Bindings: HonoBindings;
  Variables: HonoVariables;
}>;

type CorsFailureInput = Readonly<{
  context: HonoContext;
  status: 400 | 403 | 405;
  code: string;
  title: string;
  detail: string;
  origin: string | null;
  config: WorkerConfig;
}>;

const CORS_RESPONSE_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
  'access-control-allow-private-network',
] as const;

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const WILDCARD_ORIGIN = '*' as const;
const VARY_ORIGIN = 'Origin' as const;
const VARY_ACCESS_CONTROL_REQUEST_METHOD = 'Access-Control-Request-Method' as const;
const VARY_ACCESS_CONTROL_REQUEST_HEADERS = 'Access-Control-Request-Headers' as const;

function hasWildcardOrigin(config: WorkerConfig): boolean {
  return config.ALLOWED_ORIGINS.includes(WILDCARD_ORIGIN);
}

function normalizeOptionalHeader(value: string | undefined): string | null {
  const normalized = value?.trim() ?? '';

  return normalized.length > 0 ? normalized : null;
}

function normalizeMethod(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const normalized = value.trim().toUpperCase();

  return normalized.length > 0 ? normalized : null;
}

function isOriginAllowed(origin: string | null, config: WorkerConfig): boolean {
  if (origin === null) {
    return true;
  }

  if (hasWildcardOrigin(config)) {
    return true;
  }

  return config.ALLOWED_ORIGINS.includes(origin);
}

function resolveAllowOriginValue(origin: string | null, config: WorkerConfig): string | null {
  if (origin === null || !isOriginAllowed(origin, config)) {
    return null;
  }

  return hasWildcardOrigin(config) ? WILDCARD_ORIGIN : origin;
}

function createLowercaseSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

function parseAccessControlRequestHeaders(value: string | null): readonly string[] | null {
  if (value === null) {
    return [];
  }

  const names = value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);

  if (names.some((name) => !HEADER_NAME_PATTERN.test(name))) {
    return null;
  }

  return names;
}

function areRequestedHeadersAllowed(
  requestedHeaders: readonly string[],
  allowedHeaders: readonly string[],
): boolean {
  const allowedHeaderSet = createLowercaseSet(allowedHeaders);

  return requestedHeaders.every((name) => allowedHeaderSet.has(name));
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get('vary');

  if (existing === null || existing.trim().length === 0) {
    headers.set('vary', value);
    return;
  }

  if (existing.trim() === '*') {
    return;
  }

  const normalizedExistingValues = existing
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

  if (!normalizedExistingValues.includes(value.toLowerCase())) {
    headers.set('vary', `${existing}, ${value}`);
  }
}

function deleteExistingCorsHeaders(headers: Headers): void {
  for (const headerName of CORS_RESPONSE_HEADERS) {
    headers.delete(headerName);
  }
}

function applyCorsHeaders(
  headers: Headers,
  origin: string | null,
  config: WorkerConfig,
  options: Readonly<{ preflight: boolean }>,
): void {
  const allowOrigin = resolveAllowOriginValue(origin, config);

  deleteExistingCorsHeaders(headers);
  appendVary(headers, VARY_ORIGIN);

  if (options.preflight) {
    appendVary(headers, VARY_ACCESS_CONTROL_REQUEST_METHOD);
    appendVary(headers, VARY_ACCESS_CONTROL_REQUEST_HEADERS);
  }

  headers.set('access-control-allow-methods', config.ALLOWED_METHODS.join(','));
  headers.set('access-control-allow-headers', config.ALLOWED_HEADERS.join(','));
  headers.set('access-control-expose-headers', config.EXPOSED_HEADERS.join(','));
  headers.set('access-control-max-age', String(config.CORS_MAX_AGE_SECONDS));

  if (allowOrigin !== null) {
    headers.set('access-control-allow-origin', allowOrigin);
  }

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

  applyCorsHeaders(headers, origin, config, {
    preflight: options.preflight === true,
  });

  return headers;
}

export function withCorsHeaders(
  response: Response,
  origin: string | null,
  config: WorkerConfig,
  options: Readonly<{ preflight?: boolean }> = {},
): Response {
  const headers = new Headers(response.headers);

  applyCorsHeaders(headers, origin, config, {
    preflight: options.preflight === true,
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsFailure(input: CorsFailureInput): Response {
  const requestContext = input.context.get('requestContext');

  const response = problemJson({
    status: input.status,
    code: input.code,
    title: input.title,
    detail: input.detail,
    requestId: requestContext.requestId,
  });

  return withCorsHeaders(response, input.origin, input.config);
}

function validatePreflightRequest(
  context: HonoContext,
  origin: string | null,
  config: WorkerConfig,
): Response | null {
  const requestedMethod = normalizeMethod(
    normalizeOptionalHeader(context.req.header('access-control-request-method') ?? undefined),
  );

  if (requestedMethod !== null && !config.ALLOWED_METHODS.includes(requestedMethod)) {
    return corsFailure({
      context,
      status: 405,
      code: 'EDGE_CORS_METHOD_NOT_ALLOWED',
      title: 'CORS method not allowed',
      detail: 'The requested CORS method is not allowed by the edge gateway.',
      origin,
      config,
    });
  }

  const requestedHeaders = parseAccessControlRequestHeaders(
    normalizeOptionalHeader(context.req.header('access-control-request-headers') ?? undefined),
  );

  if (requestedHeaders === null) {
    return corsFailure({
      context,
      status: 400,
      code: 'EDGE_CORS_HEADERS_INVALID',
      title: 'Invalid CORS request headers',
      detail: 'The CORS preflight request includes invalid header names.',
      origin,
      config,
    });
  }

  if (!areRequestedHeadersAllowed(requestedHeaders, config.ALLOWED_HEADERS)) {
    return corsFailure({
      context,
      status: 403,
      code: 'EDGE_CORS_HEADERS_FORBIDDEN',
      title: 'CORS headers forbidden',
      detail: 'The requested CORS headers are not allowed by the edge gateway.',
      origin,
      config,
    });
  }

  return null;
}

function createPreflightResponse(origin: string | null, config: WorkerConfig): Response {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(origin, config, {
      preflight: true,
    }),
  });
}

function finalizeCorsResponse(
  context: HonoContext,
  response: Response,
  origin: string | null,
  config: WorkerConfig,
): Response {
  const wrappedResponse = withCorsHeaders(response, origin, config);

  context.res = wrappedResponse;

  return wrappedResponse;
}

export function createCorsMiddleware(): MiddlewareHandler<{
  Bindings: HonoBindings;
  Variables: HonoVariables;
}> {
  return async (context: HonoContext, next: Next): Promise<Response> => {
    const config = context.get('workerConfig');
    const origin = normalizeOptionalHeader(context.req.header('origin') ?? undefined);
    const method = context.req.method.toUpperCase();
    const backendPath = resolveBackendPath(context.req.path, config);

    if (origin !== null && !isOriginAllowed(origin, config)) {
      return corsFailure({
        context,
        status: 403,
        code: 'EDGE_ORIGIN_FORBIDDEN',
        title: 'Origin forbidden',
        detail: 'The request origin is not allowed by the edge gateway.',
        origin,
        config,
      });
    }

    if (
      shouldRequireOrigin({
        method,
        backendPath,
        origin,
        requireOriginOnMutation: config.REQUIRE_ORIGIN_ON_MUTATION,
      })
    ) {
      return corsFailure({
        context,
        status: 403,
        code: 'EDGE_ORIGIN_REQUIRED',
        title: 'Origin required',
        detail: 'Mutating browser-facing requests must include an allowed Origin header.',
        origin,
        config,
      });
    }

    if (method === 'OPTIONS') {
      const preflightValidationResponse = validatePreflightRequest(context, origin, config);

      if (preflightValidationResponse !== null) {
        return preflightValidationResponse;
      }

      return createPreflightResponse(origin, config);
    }

    await next();

    return finalizeCorsResponse(context, context.res, origin, config);
  };
}
