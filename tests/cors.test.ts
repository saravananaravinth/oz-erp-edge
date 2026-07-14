// oz-erp-edge/tests/cors.test.ts
import { describe, expect, it } from 'vitest';

import { parseWorkerConfig } from '../src/config.js';
import { buildCorsHeaders } from '../src/cors.js';

const config = parseWorkerConfig({
  APP_ENV: 'development',
  CLOUD_RUN_BASE_URL: 'http://localhost:8080',
  CLOUD_RUN_AUDIENCE: 'http://localhost:8080',
  ALLOWED_ORIGINS: 'http://localhost:3000',
});

describe('buildCorsHeaders', () => {
  it('exposes request tracing and rate-limit headers without credentialed CORS', () => {
    const headers = buildCorsHeaders('http://localhost:3000', config);
    const exposed = headers.get('access-control-expose-headers') ?? '';

    expect(headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(headers.get('access-control-allow-credentials')).toBeNull();
    expect(exposed).toContain('x-request-id');
    expect(exposed).toContain('retry-after');
    expect(exposed).toContain('x-ratelimit-remaining');
  });
});
