// oz-erp-edge/src/apps/worker/worker.dependencies.ts
import { getCloudRunIdToken } from '../../infrastructure/google/cloud-run-id-token.provider.js';
import { edgeLogger } from '../../observability/edge-logger.js';
import { outboundFetch } from '../../shared/http/outbound-fetch.js';
import type { WorkerDependencies } from './worker.types.js';

export function createWorkerDependencies(): WorkerDependencies {
  return Object.freeze({
    logger: edgeLogger,
    fetcher: outboundFetch,
    tokenProvider: getCloudRunIdToken,
  });
}
