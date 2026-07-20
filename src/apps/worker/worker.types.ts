import type { WorkerConfig } from '../../config/index.js';
import type { EdgeLogger } from '../../observability/observability.types.js';

export type WorkerDependencies = Readonly<{
  logger: EdgeLogger;
  fetcher: typeof fetch;
  tokenProvider: (config: WorkerConfig) => Promise<string>;
}>;
