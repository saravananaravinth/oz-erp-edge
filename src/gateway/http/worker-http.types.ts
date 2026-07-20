import type { Context } from 'hono';

import type { WorkerConfig, WorkerEnv } from '../../config/index.js';
import type { RequestContext } from './request-context.js';
import type { CloudRunTokenFailure } from '../../shared/auth/cloud-run-token.error.js';

export type WorkerVariables = {
  requestContext: RequestContext;
  workerConfig: WorkerConfig;
  routeClass?: string;
  backendDurationMs?: number;
  tokenFailure?: CloudRunTokenFailure;
};

export type WorkerHonoEnv = {
  Bindings: WorkerEnv;
  Variables: WorkerVariables;
};

export type WorkerContext = Context<WorkerHonoEnv>;
