// oz-erp-edge/src/gateway/cors/cors-request.validator.ts
import type { WorkerConfig } from '../../config/index.js';

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

export type CorsValidationFailure = Readonly<{
  status: 400 | 403 | 405;
  code: string;
  title: string;
  detail: string;
}>;

function normalizeMethod(value: string | null): string | null {
  const normalized = value?.trim().toUpperCase() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function parseRequestedHeaders(value: string | null): readonly string[] | null {
  if (value === null) return [];
  const names = value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return names.some((name) => !HEADER_NAME_PATTERN.test(name)) ? null : names;
}

export function validateCorsPreflight(input: {
  readonly requestedMethod: string | null;
  readonly requestedHeaders: string | null;
  readonly config: WorkerConfig;
}): CorsValidationFailure | null {
  const method = normalizeMethod(input.requestedMethod);
  if (method !== null && !input.config.ALLOWED_METHODS.includes(method)) {
    return {
      status: 405,
      code: 'EDGE_CORS_METHOD_NOT_ALLOWED',
      title: 'CORS method not allowed',
      detail: 'The requested CORS method is not allowed by the edge gateway.',
    };
  }

  const headers = parseRequestedHeaders(input.requestedHeaders);
  if (headers === null) {
    return {
      status: 400,
      code: 'EDGE_CORS_HEADERS_INVALID',
      title: 'Invalid CORS request headers',
      detail: 'The CORS preflight request includes invalid header names.',
    };
  }

  const allowlist = new Set(input.config.ALLOWED_HEADERS.map((name) => name.toLowerCase()));
  if (!headers.every((name) => allowlist.has(name))) {
    return {
      status: 403,
      code: 'EDGE_CORS_HEADERS_FORBIDDEN',
      title: 'CORS headers forbidden',
      detail: 'The requested CORS headers are not allowed by the edge gateway.',
    };
  }

  return null;
}
