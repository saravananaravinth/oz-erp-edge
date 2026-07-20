import { describe, expect, it } from 'vitest';

import { parseWorkerConfig, resolveCloudRunAuthMode } from '../../../src/config/index.js';
import { createLocalWorkerEnv } from '../../fixtures/worker-env.js';

describe('worker config', () => {
  it('parses local disabled-auth configuration', () => {
    const config = parseWorkerConfig(createLocalWorkerEnv());
    expect(config.APP_ENV).toBe('development');
    expect(resolveCloudRunAuthMode(config)).toBe('disabled');
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
