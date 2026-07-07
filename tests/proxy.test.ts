// oz-erp-edge/tests/proxy.test.ts
import { describe, expect, it } from 'vitest';

import type { WorkerConfig } from '../src/config.js';
import { resolveBackendPath } from '../src/proxy.js';

const config: WorkerConfig = {
  APP_ENV: 'development',
  APP_NAME: 'oz-erp-edge-worker',
  APP_VERSION: 'test',
  PUBLIC_API_PREFIX: '',
  BACKEND_PATH_PREFIX: '',
  ALLOWED_BACKEND_PREFIXES: ['/erp'],
  BLOCKED_BACKEND_PREFIXES: ['/tasks', '/metrics', '/readyz', '/healthz', '/livez', '/version'],
  ALLOWED_ORIGINS: ['http://localhost:3000'],
  ALLOWED_METHODS: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  ALLOWED_HEADERS: ['authorization', 'content-type'],
  EXPOSED_HEADERS: ['x-request-id', 'x-correlation-id'],
  CORS_MAX_AGE_SECONDS: 600,
  CORS_ALLOW_CREDENTIALS: true,
  REQUIRE_ORIGIN_ON_MUTATION: true,
  MAX_BODY_BYTES: 1_048_576,
  FETCH_TIMEOUT_MS: 115_000,
  CLOUD_RUN_BASE_URL: 'http://localhost:8080',
  CLOUD_RUN_AUDIENCE: 'http://localhost:8080',
  CLOUD_RUN_AUTH_MODE: 'auto',
  GOOGLE_TOKEN_URI: 'https://oauth2.googleapis.com/token',
  GOOGLE_TOKEN_CACHE_SKEW_SECONDS: 120,
};

describe('resolveBackendPath', () => {
  it('maps public ERP paths to private backend ERP paths', () => {
    expect(resolveBackendPath('/erp/auth/login/otp/request', config)).toBe(
      '/erp/auth/login/otp/request',
    );
  });

  it('does not expose backend tasks through the frontend gateway', () => {
    expect(resolveBackendPath('/tasks/notification.send', config)).toBeNull();
  });

  it('does not expose backend health through the frontend gateway', () => {
    expect(resolveBackendPath('/erp/readyz', config)).toBe('/erp/readyz');
    expect(resolveBackendPath('/readyz', config)).toBeNull();
  });

  it('does not expose paths outside allowed ERP prefixes', () => {
    expect(resolveBackendPath('/admin/internal', config)).toBeNull();
  });
});
