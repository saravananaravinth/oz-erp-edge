// oz-erp-edge/src/config/worker-config.ts
import { workerEnvSchema, type WorkerConfig } from './worker-env.schema.js';
import type {
  CloudRunAuthConfig,
  ResolvedCloudRunAuthMode,
  WorkerConfigEnv,
  WorkerEnv,
} from './worker-config.types.js';

const parsedConfigCache = new WeakMap<object, WorkerConfig>();

type WorkerConfigSchemaInput = Readonly<{
  [Key in keyof WorkerConfigEnv]-?: WorkerConfigEnv[Key] | undefined;
}>;

function selectWorkerConfigEnv(env: WorkerEnv): WorkerConfigSchemaInput {
  return {
    APP_ENV: env.APP_ENV,
    APP_NAME: env.APP_NAME,
    APP_VERSION: env.APP_VERSION,
    PUBLIC_API_PREFIX: env.PUBLIC_API_PREFIX,
    BACKEND_PATH_PREFIX: env.BACKEND_PATH_PREFIX,
    BACKEND_READINESS_PATH: env.BACKEND_READINESS_PATH,
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
    READINESS_TIMEOUT_MS: env.READINESS_TIMEOUT_MS,
    CLOUD_RUN_BASE_URL: env.CLOUD_RUN_BASE_URL,
    CLOUD_RUN_AUDIENCE: env.CLOUD_RUN_AUDIENCE,
    CLOUD_RUN_AUTH_MODE: env.CLOUD_RUN_AUTH_MODE,
    GOOGLE_TOKEN_URI: env.GOOGLE_TOKEN_URI,
    GOOGLE_TOKEN_TIMEOUT_MS: env.GOOGLE_TOKEN_TIMEOUT_MS,
    GOOGLE_TOKEN_CACHE_SKEW_SECONDS: env.GOOGLE_TOKEN_CACHE_SKEW_SECONDS,
    GCP_SERVICE_ACCOUNT_JSON_B64: env.GCP_SERVICE_ACCOUNT_JSON_B64,
  };
}

export function parseWorkerConfig(env: WorkerEnv): WorkerConfig {
  return Object.freeze(workerEnvSchema.parse(selectWorkerConfigEnv(env)));
}

export function getWorkerConfig(env: WorkerEnv): WorkerConfig {
  const cacheKey = env as object;
  const cached = parsedConfigCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const parsed = parseWorkerConfig(env);
  parsedConfigCache.set(cacheKey, parsed);
  return parsed;
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/u, '');
}

export function resolveCloudRunAuthMode(config: CloudRunAuthConfig): ResolvedCloudRunAuthMode {
  if (config.CLOUD_RUN_AUTH_MODE !== 'auto') return config.CLOUD_RUN_AUTH_MODE;
  const backendUrl = new URL(config.CLOUD_RUN_BASE_URL);
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  return backendUrl.protocol === 'http:' && localHosts.has(backendUrl.hostname.toLowerCase())
    ? 'disabled'
    : 'id_token';
}

export function shouldUseCloudRunIdToken(config: CloudRunAuthConfig): boolean {
  return resolveCloudRunAuthMode(config) === 'id_token';
}
