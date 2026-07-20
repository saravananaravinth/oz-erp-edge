import { describe, expect, it } from 'vitest';

import { parseWorkerConfig, resolveCloudRunAuthMode } from '../../../src/config/index.js';
import { createLocalWorkerEnv } from '../../fixtures/worker-env.js';

describe('worker config', () => {
  it('parses local disabled-auth configuration', () => {
    const config = parseWorkerConfig(createLocalWorkerEnv());
    expect(config.APP_ENV).toBe('development');
    expect(resolveCloudRunAuthMode(config)).toBe('disabled');
  });

  it('isolates Cloudflare metadata and unrelated platform bindings from strict config parsing', () => {
    const env = {
      ...createLocalWorkerEnv(),
      CF_VERSION_METADATA: {
        id: '11111111-1111-4111-8111-111111111111',
        tag: 'v0.5.0-test',
        timestamp: '2026-07-20T00:00:00.000Z',
      },
      FUTURE_PLATFORM_BINDING: { binding: 'test' },
    };

    const config = parseWorkerConfig(env);

    expect(config.APP_NAME).toBe('oz-erp-edge');
    expect(config).not.toHaveProperty('CF_VERSION_METADATA');
    expect(config).not.toHaveProperty('FUTURE_PLATFORM_BINDING');
  });

  it('rejects malformed supported configuration values', () => {
    expect(() => parseWorkerConfig(createLocalWorkerEnv({ APP_ENV: 'prod' }))).toThrow();
  });

  it('rejects remote disabled authentication', () => {
    expect(() =>
      parseWorkerConfig(
        createLocalWorkerEnv({
          CLOUD_RUN_BASE_URL: 'https://service.run.app',
          CLOUD_RUN_AUDIENCE: 'https://service.run.app',
          CLOUD_RUN_AUTH_MODE: 'disabled',
        }),
      ),
    ).toThrow();
  });

  it('rejects production without a service-account secret', () => {
    expect(() =>
      parseWorkerConfig(
        createLocalWorkerEnv({
          APP_ENV: 'production',
          ALLOWED_ORIGINS: 'https://erp.ozotecev.com',
          CLOUD_RUN_BASE_URL: 'https://service.run.app',
          CLOUD_RUN_AUDIENCE: 'https://service.run.app',
          CLOUD_RUN_AUTH_MODE: 'id_token',
        }),
      ),
    ).toThrow();
  });
});
