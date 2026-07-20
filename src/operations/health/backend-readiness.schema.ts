// oz-erp-edge/src/operations/health/backend-readiness.schema.ts
import { z } from 'zod';

const dependencyResultSchema = z
  .object({
    name: z.enum(['postgres', 'redis']),
    status: z.enum(['up', 'down']),
    latency_ms: z.number().nonnegative(),
    error: z.enum(['dependency_timeout', 'dependency_unavailable']).optional(),
  })
  .strict();

export const backendReadyEnvelopeSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        service: z.string().min(1).max(128),
        status: z.enum(['ready', 'not_ready']),
        uptime_seconds: z.number().nonnegative(),
        timestamp: z.iso.datetime(),
        dependencies: z.array(dependencyResultSchema).max(16),
      })
      .strict(),
    request_id: z.string().min(1).max(128),
    timestamp: z.iso.datetime(),
  })
  .strict();
