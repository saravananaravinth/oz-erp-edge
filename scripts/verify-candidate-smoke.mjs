// oz-erp-edge/scripts/verify-candidate-smoke.mjs
import { pathToFileURL } from 'node:url';

const VERSION_OVERRIDE_HEADER = 'Cloudflare-Workers-Version-Overrides';
const DEFAULT_ATTEMPTS = 12;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_READINESS_CONCURRENCY = 8;
const MAX_DIAGNOSTIC_BODY_LENGTH = 4_096;

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function versionOverrideValue(workerName, candidateVersionId) {
  return `${workerName}="${candidateVersionId}"`;
}

function isCandidateLive(body, expectedVersion) {
  return (
    body?.success === true &&
    body?.data?.status === 'alive' &&
    body?.data?.version === expectedVersion &&
    body?.data?.environment === 'production' &&
    body?.data?.cloud_run_auth_mode === 'id_token'
  );
}

function isCandidateReady(body) {
  return (
    body?.success === true &&
    body?.data?.status === 'ready' &&
    body?.data?.backend_status === 200 &&
    body?.data?.backend_contract === 'valid' &&
    body?.data?.cloud_run_auth_mode === 'id_token'
  );
}

async function observeEndpoint({ fetcher, url, overrideValue, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: { [VERSION_OVERRIDE_HEADER]: overrideValue },
      redirect: 'follow',
      signal: controller.signal,
    });
    const responseText = await response.text();
    let body = null;
    try {
      body = JSON.parse(responseText);
    } catch {
      // The bounded response text is retained for failure diagnostics.
    }
    return {
      status: response.status,
      body,
      responseText: responseText.slice(0, MAX_DIAGNOSTIC_BODY_LENGTH),
    };
  } catch (error) {
    return {
      status: null,
      body: null,
      responseText: `Request failed: ${error instanceof Error ? error.name : 'UnknownError'}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export class CandidateOverrideUnavailableError extends Error {
  constructor(expectedVersion, lastObservation) {
    super(`Candidate version override did not become available for ${expectedVersion}.`);
    this.name = 'CandidateOverrideUnavailableError';
    this.expectedVersion = expectedVersion;
    this.lastObservation = lastObservation;
  }
}

export class CandidateReadinessError extends Error {
  constructor(failures, total) {
    super(`${failures.length} of ${total} concurrent candidate readiness requests failed.`);
    this.name = 'CandidateReadinessError';
    this.failures = failures;
  }
}

export async function waitForCandidateOverride(input, dependencies = {}) {
  const fetcher = dependencies.fetcher ?? globalThis.fetch;
  const delay = dependencies.sleep ?? sleep;
  const maxAttempts = dependencies.maxAttempts ?? DEFAULT_ATTEMPTS;
  const retryDelayMs = dependencies.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const overrideValue = versionOverrideValue(input.workerName, input.candidateVersionId);
  let lastObservation = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastObservation = await observeEndpoint({
      fetcher,
      url: `${input.workerOrigin}/livez`,
      overrideValue,
      timeoutMs: requestTimeoutMs,
    });
    if (
      lastObservation.status === 200 &&
      isCandidateLive(lastObservation.body, input.expectedTag)
    ) {
      return { attempts: attempt, overrideValue };
    }
    if (attempt < maxAttempts) await delay(retryDelayMs);
  }

  throw new CandidateOverrideUnavailableError(input.expectedTag, lastObservation);
}

export async function verifyCandidateColdStart(input, dependencies = {}) {
  const fetcher = dependencies.fetcher ?? globalThis.fetch;
  const concurrency = dependencies.readinessConcurrency ?? DEFAULT_READINESS_CONCURRENCY;
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const available = await waitForCandidateOverride(input, { ...dependencies, fetcher });

  const observations = await Promise.all(
    Array.from(
      { length: concurrency },
      async () =>
        await observeEndpoint({
          fetcher,
          url: `${input.workerOrigin}/readyz`,
          overrideValue: available.overrideValue,
          timeoutMs: requestTimeoutMs,
        }),
    ),
  );
  const failures = observations.filter(
    (observation) => observation.status !== 200 || !isCandidateReady(observation.body),
  );
  if (failures.length > 0) throw new CandidateReadinessError(failures, concurrency);

  return { propagationAttempts: available.attempts, readinessChecks: concurrency };
}

function formatObservation(observation) {
  if (observation === null) return 'No liveness response was observed.';
  return `HTTP ${observation.status ?? 'unavailable'}: ${observation.responseText}`;
}

async function main() {
  const input = {
    workerName: requiredString(process.env.WORKER_NAME, 'WORKER_NAME'),
    workerOrigin: requiredString(process.env.WORKER_ORIGIN, 'WORKER_ORIGIN').replace(/\/+$/u, ''),
    candidateVersionId: requiredString(process.env.CANDIDATE_VERSION_ID, 'CANDIDATE_VERSION_ID'),
    expectedTag: requiredString(process.env.WORKER_VERSION_TAG, 'WORKER_VERSION_TAG'),
  };

  try {
    const result = await verifyCandidateColdStart(input);
    console.log(
      `Candidate override became available after ${result.propagationAttempts} attempt(s); ${result.readinessChecks} concurrent readiness checks passed.`,
    );
  } catch (error) {
    if (error instanceof CandidateOverrideUnavailableError) {
      console.error(
        `::error title=Candidate version override unavailable::Expected ${error.expectedVersion} after ${DEFAULT_ATTEMPTS} attempts.`,
      );
      console.error(
        `Last candidate liveness response: ${formatObservation(error.lastObservation)}`,
      );
    } else if (error instanceof CandidateReadinessError) {
      console.error(`::error title=Concurrent candidate readiness failed::${error.message}`);
      error.failures.forEach((failure, index) => {
        console.error(`Failed readiness response ${index + 1}: ${formatObservation(failure)}`);
      });
    } else {
      console.error(
        `::error title=Candidate smoke verification failed::${error instanceof Error ? error.message : 'Unknown failure.'}`,
      );
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
