import type { Context } from 'hono';

import type { WorkerConfig, WorkerEnv } from '../../config/index.js';
import type { RequestContext } from './request-context.js';

export type WorkerVariables = {
  requestContext: RequestContext;
  workerConfig: WorkerConfig;
  routeClass?: string;
  backendDurationMs?: number;
};

export type WorkerHonoEnv = {
  Bindings: WorkerEnv;
  Variables: WorkerVariables;
};

export type WorkerContext = Context<WorkerHonoEnv>;
