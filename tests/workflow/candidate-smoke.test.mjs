// oz-erp-edge/tests/workflow/candidate-smoke.test.mjs
import fs from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  CandidateOverrideUnavailableError,
  verifyCandidateColdStart,
  waitForCandidateOverride,
} from '../../scripts/verify-candidate-smoke.mjs';

const input = {
  workerName: 'oz-erp-edge',
  workerOrigin: 'https://api.erp.ozotecev.com',
  candidateVersionId: 'e0a24f75-d525-4a49-aca0-27514f961782',
  expectedTag: 'v0.6.0-test',
};
const expectedOverride = `${input.workerName}="${input.candidateVersionId}"`;

function livez(version = input.expectedTag) {
  return Response.json({
    success: true,
    data: {
      status: 'alive',
      version,
      environment: 'production',
      cloud_run_auth_mode: 'id_token',
    },
  });
}

function readyz() {
  return Response.json({
    success: true,
    data: {
      status: 'ready',
      backend_status: 200,
      backend_contract: 'valid',
      cloud_run_auth_mode: 'id_token',
    },
  });
}

describe('candidate version-override smoke', () => {
  it('accepts immediate availability and starts all readiness requests concurrently', async () => {
    let readinessCalls = 0;
    let releaseReadiness;
    const readinessBarrier = new Promise((resolve) => {
      releaseReadiness = resolve;
    });
    const observedHeaders = [];
    const fetcher = vi.fn(async (url, init) => {
      observedHeaders.push(new Headers(init?.headers).get('Cloudflare-Workers-Version-Overrides'));
      if (String(url).endsWith('/livez')) return livez();

      readinessCalls += 1;
      if (readinessCalls === 8) releaseReadiness();
      await readinessBarrier;
      return readyz();
    });

    await expect(verifyCandidateColdStart(input, { fetcher })).resolves.toEqual({
      propagationAttempts: 1,
      readinessChecks: 8,
    });
    expect(readinessCalls).toBe(8);
    expect(observedHeaders).toEqual(Array.from({ length: 9 }, () => expectedOverride));
  });

  it('retries a stable-version response until the candidate is observable', async () => {
    const sleep = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(livez('v0.5.0-stable'))
      .mockResolvedValueOnce(livez());

    await expect(
      waitForCandidateOverride(input, { fetcher, sleep, retryDelayMs: 5_000 }),
    ).resolves.toMatchObject({ attempts: 2 });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('retries malformed liveness responses', async () => {
    const sleep = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }))
      .mockResolvedValueOnce(livez());

    await expect(waitForCandidateOverride(input, { fetcher, sleep })).resolves.toMatchObject({
      attempts: 2,
    });
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('reports the expected tag and last response after retry exhaustion', async () => {
    const fetcher = vi.fn(async () => livez('v0.5.0-stable'));

    const rejection = waitForCandidateOverride(input, {
      fetcher,
      sleep: vi.fn(),
      maxAttempts: 3,
    });

    await expect(rejection).rejects.toBeInstanceOf(CandidateOverrideUnavailableError);
    await expect(rejection).rejects.toMatchObject({
      expectedVersion: input.expectedTag,
      lastObservation: {
        status: 200,
        body: { data: { version: 'v0.5.0-stable' } },
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps the protected rollout stages ordered around the smoke helper', () => {
    const workflow = fs.readFileSync('.github/workflows/deploy.yml', 'utf8');
    const stages = [
      'deploy_distribution 0 100',
      'node scripts/verify-candidate-smoke.mjs',
      'deploy_distribution 5 95',
      'deploy_distribution 25 75',
      'Production promotion:',
    ];

    let previousPosition = -1;
    for (const stage of stages) {
      const position = workflow.indexOf(stage, previousPosition + 1);
      expect(position, `missing or unordered workflow stage: ${stage}`).toBeGreaterThan(
        previousPosition,
      );
      previousPosition = position;
    }
  });
});
