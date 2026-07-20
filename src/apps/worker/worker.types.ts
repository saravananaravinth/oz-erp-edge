import type { WorkerConfig } from '../../config/index.js';
import type { EdgeLogger } from '../../observability/observability.types.js';
import type { OutboundFetcher } from '../../shared/http/outbound-fetch.js';

export type WorkerDependencies = Readonly<{
  logger: EdgeLogger;
  fetcher: OutboundFetcher;
  tokenProvider: (config: WorkerConfig) => Promise<string>;
}>;
