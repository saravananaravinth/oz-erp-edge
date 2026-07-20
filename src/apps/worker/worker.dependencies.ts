import { getCloudRunIdToken } from '../../infrastructure/google/cloud-run-id-token.provider.js';
import { edgeLogger } from '../../observability/edge-logger.js';
import type { WorkerDependencies } from './worker.types.js';

export function createWorkerDependencies(): WorkerDependencies {
  return Object.freeze({
    logger: edgeLogger,
    fetcher: fetch,
    tokenProvider: getCloudRunIdToken,
  });
}
