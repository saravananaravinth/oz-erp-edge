// oz-erp-edge/src/config.ts
import { z } from 'zod';

export type WorkerEnv = Readonly<{
  APP_ENV?: string;
  APP_NAME?: string;
  APP_VERSION?: string;
  PUBLIC_API_PREFIX?: string;
  BACKEND_PATH_PREFIX?: string;
  ALLOWED_BACKEND_PREFIXES?: string;
  BLOCKED_BACKEND_PREFIXES?: string;
  ALLOWED_ORIGINS?: string;
  ALLOWED_METHODS?: string;
  ALLOWED_HEADERS?: string;
  EXPOSED_HEADERS?: string;
  CORS_MAX_AGE_SECONDS?: string;
  CORS_ALLOW_CREDENTIALS?: string;
  REQUIRE_ORIGIN_ON_MUTATION?: string;
  MAX_BODY_BYTES?: string;
  FETCH_TIMEOUT_MS?: string;
  CLOUD_RUN_BASE_URL?: string;
  CLOUD_RUN_AUDIENCE?: string;
  GOOGLE_TOKEN_URI?: string;
  GOOGLE_TOKEN_CACHE_SKEW_SECONDS?: string;
  GCP_SERVICE_ACCOUNT_JSON_B64?: string;
}>;

const requiredTrimmedString = z.string().trim().min(1);
const booleanFromEnv = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === '') {
      return undefined;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value !== 'string') {
      return value;
    }

    const normalized = value.trim().toLowerCase();

    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }

    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }

    return value;
  }, z.boolean().default(defaultValue));

const integerFromEnv = (options: {
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
}) =>
  z.preprocess((value) => {
    if (value === undefined || value === '') {
      return undefined;
    }

    if (typeof value === 'number') {
      return value;
    }

    if (typeof value !== 'string') {
      return value;
    }

    const trimmed = value.trim();

    if (!/^\d+$/u.test(trimmed)) {
      return value;
    }

    return Number(trimmed);
  }, z.number().int().min(options.min).max(options.max).default(options.defaultValue));

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

const httpUrlString = requiredTrimmedString.refine(isHttpUrl, {
  message: 'Must be a valid http(s) URL.',
});

const absolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^\/[A-Za-z0-9/_-]*$/u, 'Must be an absolute path.');

const csvList = (defaultValue: string) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === '') {
        return defaultValue;
      }

      return value;
    },
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

      if (!parsed.success) {
        context.addIssue({
          code: 'custom',
          message: `Invalid path prefix "${item}".`,
        });
      }
    }
  });

const methodCsvList = csvList('GET,POST,PUT,PATCH,DELETE,OPTIONS').superRefine((items, context) => {
  const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

  for (const item of items) {
    if (!allowedMethods.has(item)) {
      context.addIssue({
        code: 'custom',
        message: `Unsupported HTTP method "${item}".`,
      });
    }
  }
});

const createHeaderNameCsvList = (defaultValue: string) =>
  csvList(defaultValue).superRefine((items, context) => {
    for (const item of items) {
      if (!/^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/u.test(item)) {
        context.addIssue({
          code: 'custom',
          message: `Invalid header name "${item}".`,
        });
      }
    }
  });

const originCsvList = csvList('http://localhost:3000').superRefine((items, context) => {
  for (const item of items) {
    if (item === '*') {
      continue;
    }

    if (!isHttpUrl(item)) {
      context.addIssue({
        code: 'custom',
        message: `Invalid origin "${item}".`,
      });
    }
  }
});

const serviceAccountJsonB64Schema = requiredTrimmedString
  .min(100)
  .max(32_768)
  .regex(/^[A-Za-z0-9+/=_-]+$/u, 'Must be base64/base64url encoded service account JSON.');

const rawConfigSchema = z
  .object({
    APP_ENV: z.enum(['development', 'staging', 'production']).default('production'),
    APP_NAME: requiredTrimmedString.default('oz-erp-edge-worker'),
    APP_VERSION: requiredTrimmedString.default('0.1.0'),
    PUBLIC_API_PREFIX: z
      .string()
      .trim()
      .max(128)
      .regex(/^$|^\/[A-Za-z0-9/_-]*$/u, 'Must be empty or an absolute path.')
      .default(''),
    BACKEND_PATH_PREFIX: z
      .string()
      .trim()
      .max(128)
      .regex(/^$|^\/[A-Za-z0-9/_-]*$/u, 'Must be empty or an absolute path.')
      .default(''),
    ALLOWED_BACKEND_PREFIXES: pathCsvList('/erp'),
    BLOCKED_BACKEND_PREFIXES: pathCsvList('/tasks,/metrics,/readyz,/healthz,/livez,/version'),
    ALLOWED_ORIGINS: originCsvList,
    ALLOWED_METHODS: methodCsvList,
    ALLOWED_HEADERS: createHeaderNameCsvList(
      'authorization,content-type,idempotency-key,x-idempotency-key,x-request-id,x-correlation-id,x-tenant-id,x-org-unit-id,x-dealer-org-unit-id,x-financier-id,x-customer-id',
    ),
    EXPOSED_HEADERS: createHeaderNameCsvList('x-request-id,x-correlation-id'),
    CORS_MAX_AGE_SECONDS: integerFromEnv({ min: 0, max: 86_400, defaultValue: 600 }),
    CORS_ALLOW_CREDENTIALS: booleanFromEnv(true),
    REQUIRE_ORIGIN_ON_MUTATION: booleanFromEnv(true),
    MAX_BODY_BYTES: integerFromEnv({ min: 1_024, max: 10_485_760, defaultValue: 1_048_576 }),
    FETCH_TIMEOUT_MS: integerFromEnv({ min: 1_000, max: 120_000, defaultValue: 115_000 }),
    CLOUD_RUN_BASE_URL: httpUrlString,
    CLOUD_RUN_AUDIENCE: httpUrlString,
    GOOGLE_TOKEN_URI: httpUrlString.default('https://oauth2.googleapis.com/token'),
    GOOGLE_TOKEN_CACHE_SKEW_SECONDS: integerFromEnv({ min: 30, max: 600, defaultValue: 120 }),
    GCP_SERVICE_ACCOUNT_JSON_B64: serviceAccountJsonB64Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.APP_ENV === 'production' && value.ALLOWED_ORIGINS.includes('*')) {
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
  });

export type WorkerConfig = z.output<typeof rawConfigSchema>;

export function parseWorkerConfig(env: WorkerEnv): WorkerConfig {
  return rawConfigSchema.parse({
    APP_ENV: env.APP_ENV,
    APP_NAME: env.APP_NAME,
    APP_VERSION: env.APP_VERSION,
    PUBLIC_API_PREFIX: env.PUBLIC_API_PREFIX,
    BACKEND_PATH_PREFIX: env.BACKEND_PATH_PREFIX,
    ALLOWED_BACKEND_PREFIXES: env.ALLOWED_BACKEND_PREFIXES,
    BLOCKED_BACKEND_PREFIXES: env.BLOCKED_BACKEND_PREFIXES,
    ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
    ALLOWED_METHODS: env.ALLOWED_METHODS,
    ALLOWED_HEADERS: env.ALLOWED_HEADERS,
    EXPOSED_HEADERS: env.EXPOSED_HEADERS,
    CORS_MAX_AGE_SECONDS: env.CORS_MAX_AGE_SECONDS,
    CORS_ALLOW_CREDENTIALS: env.CORS_ALLOW_CREDENTIALS,
    REQUIRE_ORIGIN_ON_MUTATION: env.REQUIRE_ORIGIN_ON_MUTATION,
    MAX_BODY_BYTES: env.MAX_BODY_BYTES,
    FETCH_TIMEOUT_MS: env.FETCH_TIMEOUT_MS,
    CLOUD_RUN_BASE_URL: env.CLOUD_RUN_BASE_URL,
    CLOUD_RUN_AUDIENCE: env.CLOUD_RUN_AUDIENCE,
    GOOGLE_TOKEN_URI: env.GOOGLE_TOKEN_URI,
    GOOGLE_TOKEN_CACHE_SKEW_SECONDS: env.GOOGLE_TOKEN_CACHE_SKEW_SECONDS,
    GCP_SERVICE_ACCOUNT_JSON_B64: env.GCP_SERVICE_ACCOUNT_JSON_B64,
  });
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/u, '');
}
