import { z } from 'zod';

import type { CloudRunAuthMode } from './worker-config.types.js';

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const PRODUCTION_APP_ENV = 'production';
export const REQUIRED_BLOCKED_BACKEND_PREFIXES = [
  '/tasks',
  '/metrics',
  '/readyz',
  '/healthz',
  '/livez',
  '/version',
  '/erp/metrics',
  '/erp/readyz',
  '/erp/healthz',
  '/erp/livez',
  '/erp/version',
] as const;

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const requiredTrimmedString = z.string().trim().min(1);
const cloudRunAuthModeSchema = z.enum(['auto', 'disabled', 'id_token']).default('auto');

const booleanFromEnv = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return value;

    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    return value;
  }, z.boolean().default(defaultValue));

const integerFromEnv = (options: {
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
}) =>
  z.preprocess((value) => {
    if (value === undefined || value === '') return undefined;
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return value;

    const trimmed = value.trim();
    return /^\d+$/u.test(trimmed) ? Number(trimmed) : value;
  }, z.number().int().min(options.min).max(options.max).default(options.defaultValue));

function safeParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalhostHostname(hostname: string): boolean {
  return LOCALHOST_HOSTNAMES.has(hostname.toLowerCase());
}

function isHttpUrl(value: string): boolean {
  const url = safeParseUrl(value);
  return url !== null && (url.protocol === 'https:' || url.protocol === 'http:');
}

function isExactHttpOrigin(value: string): boolean {
  const url = safeParseUrl(value);
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) return false;

  return (
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.pathname === '/' &&
    url.search.length === 0 &&
    url.hash.length === 0 &&
    url.origin === value
  );
}

function isLocalHttpBackend(value: string): boolean {
  const url = safeParseUrl(value);
  return url !== null && url.protocol === 'http:' && isLocalhostHostname(url.hostname);
}

function isProductionOrigin(value: string): boolean {
  const url = safeParseUrl(value);
  return url !== null && url.protocol === 'https:' && !isLocalhostHostname(url.hostname);
}

function resolveAuthMode(value: {
  readonly CLOUD_RUN_AUTH_MODE: CloudRunAuthMode;
  readonly CLOUD_RUN_BASE_URL: string;
}): 'disabled' | 'id_token' {
  if (value.CLOUD_RUN_AUTH_MODE !== 'auto') return value.CLOUD_RUN_AUTH_MODE;
  return isLocalHttpBackend(value.CLOUD_RUN_BASE_URL) ? 'disabled' : 'id_token';
}

const httpUrlString = requiredTrimmedString.refine(isHttpUrl, {
  message: 'Must be a valid http(s) URL.',
});
const exactHttpOriginString = requiredTrimmedString.refine(isExactHttpOrigin, {
  message: 'Must be an exact HTTP origin without path, query, fragment, or credentials.',
});
const semverString = requiredTrimmedString.regex(SEMVER_PATTERN, {
  message: 'Must be a valid semantic version.',
});
const absolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^\/[A-Za-z0-9/_-]*$/u, 'Must be an absolute path.')
  .refine((value) => value === '/' || !value.endsWith('/'), {
    message: 'Path must not end with a slash.',
  });
const optionalAbsolutePathSchema = z
  .string()
  .trim()
  .max(256)
  .regex(/^$|^\/[A-Za-z0-9/_-]*$/u, 'Must be empty or an absolute path.')
  .refine((value) => value === '' || value === '/' || !value.endsWith('/'), {
    message: 'Path must not end with a slash.',
  });

const csvList = (defaultValue: string) =>
  z.preprocess(
    (value) => (value === undefined || value === '' ? defaultValue : value),
    z.string().transform((value, context) => {
      const items = [
        ...new Set(
          value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ];
      if (items.length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'At least one comma-separated value is required.',
        });
        return z.NEVER;
      }
      return items;
    }),
  );

const pathCsvList = (defaultValue: string) =>
  csvList(defaultValue).superRefine((items, context) => {
    for (const item of items) {
      const parsed = absolutePathSchema.safeParse(item);
      if (!parsed.success || item === '/') {
        context.addIssue({ code: 'custom', message: `Invalid path prefix "${item}".` });
      }
    }
  });

const methodCsvList = csvList('GET,POST,PUT,PATCH,DELETE,OPTIONS').superRefine((items, context) => {
  const supported = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
  for (const item of items) {
    if (!supported.has(item)) {
      context.addIssue({ code: 'custom', message: `Unsupported HTTP method "${item}".` });
    }
  }
});

const headerCsvList = (defaultValue: string) =>
  csvList(defaultValue).superRefine((items, context) => {
    for (const item of items) {
      if (!/^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/u.test(item)) {
        context.addIssue({ code: 'custom', message: `Invalid header name "${item}".` });
      }
    }
  });

const originCsvList = csvList('http://localhost:3000').superRefine((items, context) => {
  for (const item of items) {
    if (item !== '*' && !exactHttpOriginString.safeParse(item).success) {
      context.addIssue({ code: 'custom', message: `Invalid origin "${item}".` });
    }
  }
});

const serviceAccountJsonB64Schema = requiredTrimmedString
  .min(100)
  .max(32_768)
  .regex(/^[A-Za-z0-9+/=_-]+$/u, 'Must be base64/base64url encoded service account JSON.');

export const workerEnvSchema = z
  .object({
    APP_ENV: z.enum(['development', 'staging', 'production']).default('production'),
    APP_NAME: requiredTrimmedString.max(128).default('oz-erp-edge'),
    APP_VERSION: semverString.default('0.1.0'),
    PUBLIC_API_PREFIX: optionalAbsolutePathSchema.default(''),
    BACKEND_PATH_PREFIX: optionalAbsolutePathSchema.default(''),
    BACKEND_READINESS_PATH: absolutePathSchema.default('/erp/readyz'),
    ALLOWED_BACKEND_PREFIXES: pathCsvList('/erp'),
    BLOCKED_BACKEND_PREFIXES: pathCsvList(REQUIRED_BLOCKED_BACKEND_PREFIXES.join(',')),
    ALLOWED_ORIGINS: originCsvList,
    ALLOWED_METHODS: methodCsvList,
    ALLOWED_HEADERS: headerCsvList(
      'authorization,content-type,idempotency-key,x-idempotency-key,x-request-id,x-correlation-id,x-tenant-id,x-org-unit-id,x-dealer-org-unit-id,x-financier-id,x-customer-id',
    ),
    EXPOSED_HEADERS: headerCsvList(
      'x-request-id,x-correlation-id,retry-after,x-ratelimit-scope,x-ratelimit-limit,x-ratelimit-remaining',
    ),
    CORS_MAX_AGE_SECONDS: integerFromEnv({ min: 0, max: 86_400, defaultValue: 600 }),
    CORS_ALLOW_CREDENTIALS: booleanFromEnv(false),
    REQUIRE_ORIGIN_ON_MUTATION: booleanFromEnv(true),
    MAX_BODY_BYTES: integerFromEnv({ min: 1_024, max: 10_485_760, defaultValue: 1_048_576 }),
    FETCH_TIMEOUT_MS: integerFromEnv({ min: 1_000, max: 120_000, defaultValue: 115_000 }),
    READINESS_TIMEOUT_MS: integerFromEnv({ min: 500, max: 10_000, defaultValue: 5_000 }),
    CLOUD_RUN_BASE_URL: exactHttpOriginString,
    CLOUD_RUN_AUDIENCE: exactHttpOriginString,
    CLOUD_RUN_AUTH_MODE: cloudRunAuthModeSchema,
    GOOGLE_TOKEN_URI: httpUrlString.default('https://oauth2.googleapis.com/token'),
    GOOGLE_TOKEN_TIMEOUT_MS: integerFromEnv({ min: 500, max: 10_000, defaultValue: 5_000 }),
    GOOGLE_TOKEN_CACHE_SKEW_SECONDS: integerFromEnv({ min: 30, max: 600, defaultValue: 120 }),
    GCP_SERVICE_ACCOUNT_JSON_B64: serviceAccountJsonB64Schema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const resolvedAuthMode = resolveAuthMode(value);
    const backendUrl = safeParseUrl(value.CLOUD_RUN_BASE_URL);
    const tokenUrl = safeParseUrl(value.GOOGLE_TOKEN_URI);

    if (value.APP_ENV === PRODUCTION_APP_ENV && value.ALLOWED_ORIGINS.includes('*')) {
      context.addIssue({
        code: 'custom',
        path: ['ALLOWED_ORIGINS'],
        message: 'Wildcard CORS origins are not allowed in production.',
      });
    }
    if (value.CORS_ALLOW_CREDENTIALS && value.ALLOWED_ORIGINS.includes('*')) {
      context.addIssue({
        code: 'custom',
        path: ['ALLOWED_ORIGINS'],
        message: 'Wildcard CORS origins cannot be used when credentials are allowed.',
      });
    }
    if (value.CLOUD_RUN_AUTH_MODE === 'disabled' && !isLocalHttpBackend(value.CLOUD_RUN_BASE_URL)) {
      context.addIssue({
        code: 'custom',
        path: ['CLOUD_RUN_AUTH_MODE'],
        message: 'Cloud Run auth can be disabled only for localhost HTTP development.',
      });
    }
    for (const prefix of REQUIRED_BLOCKED_BACKEND_PREFIXES) {
      if (!value.BLOCKED_BACKEND_PREFIXES.includes(prefix)) {
        context.addIssue({
          code: 'custom',
          path: ['BLOCKED_BACKEND_PREFIXES'],
          message: `Required private backend prefix "${prefix}" is missing.`,
        });
      }
    }
    const readinessBlocked = value.BLOCKED_BACKEND_PREFIXES.some(
      (prefix) =>
        value.BACKEND_READINESS_PATH === prefix ||
        value.BACKEND_READINESS_PATH.startsWith(`${prefix}/`),
    );
    if (!readinessBlocked) {
      context.addIssue({
        code: 'custom',
        path: ['BLOCKED_BACKEND_PREFIXES'],
        message: 'BACKEND_READINESS_PATH must be blocked from public proxy access.',
      });
    }

    if (value.APP_ENV === PRODUCTION_APP_ENV) {
      for (const origin of value.ALLOWED_ORIGINS) {
        if (origin !== '*' && !isProductionOrigin(origin)) {
          context.addIssue({
            code: 'custom',
            path: ['ALLOWED_ORIGINS'],
            message: `Production origin "${origin}" must use HTTPS and must not target localhost.`,
          });
        }
      }
      if (backendUrl?.protocol !== 'https:' || isLocalhostHostname(backendUrl.hostname)) {
        context.addIssue({
          code: 'custom',
          path: ['CLOUD_RUN_BASE_URL'],
          message: 'Production Cloud Run base URL must be non-local HTTPS.',
        });
      }
      if (tokenUrl?.protocol !== 'https:') {
        context.addIssue({
          code: 'custom',
          path: ['GOOGLE_TOKEN_URI'],
          message: 'Production Google token URI must use HTTPS.',
        });
      }
      if (resolvedAuthMode === 'disabled') {
        context.addIssue({
          code: 'custom',
          path: ['CLOUD_RUN_AUTH_MODE'],
          message: 'Cloud Run auth cannot be disabled in production.',
        });
      }
    }

    if (resolvedAuthMode === 'id_token' && value.GCP_SERVICE_ACCOUNT_JSON_B64 === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['GCP_SERVICE_ACCOUNT_JSON_B64'],
        message: 'Service account JSON is required when Cloud Run auth mode resolves to id_token.',
      });
    }
  });

export type WorkerConfig = z.output<typeof workerEnvSchema>;
