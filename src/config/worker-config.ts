import { workerEnvSchema, type WorkerConfig } from './worker-env.schema.js';
import type {
  CloudRunAuthConfig,
  ResolvedCloudRunAuthMode,
  WorkerEnv,
} from './worker-config.types.js';

const parsedConfigCache = new WeakMap<object, WorkerConfig>();

export function parseWorkerConfig(env: WorkerEnv): WorkerConfig {
  return Object.freeze(workerEnvSchema.parse(env));
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
