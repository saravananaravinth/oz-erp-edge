# oz-erp-edge architecture

## Purpose

`oz-erp-edge` is a single stateless Cloudflare Worker that exposes the approved `/erp/**` surface of
private `oz-erp-api`. It is an edge gateway, not a business-service runtime. ERP authorization,
tenant isolation, transactions, idempotency, webhook verification, and durable state remain in the
backend.

## Canonical layers

```text
apps/worker
    ↓
gateway + operations + observability
    ↓
infrastructure + config + shared
```

- `apps/worker` owns Hono composition and dependency construction.
- `gateway` owns route exposure, origin/CORS policy, request bounds, header trust, proxying, and
  response sanitization.
- `operations` owns edge liveness and private-backend readiness.
- `infrastructure` owns Google service-account parsing, assertion signing, token exchange, and the
  bounded ID-token cache.
- `observability` owns redacted structured Worker logs.
- `config` owns strict runtime validation and production invariants.
- `shared` contains transport-neutral, dependency-free primitives.

## Dependency rules

- Shared code imports only shared code.
- Configuration imports only configuration and shared code.
- Infrastructure cannot import Hono, gateway handlers, operations, observability, or applications.
- Gateway code cannot import applications, infrastructure implementations, operations, or
  observability.
- Applications compose concrete dependencies and are the only layer permitted to know every layer.
- No client-controlled infrastructure identity header may cross the edge trust boundary.
- No module-level collection may grow without a defined maximum and eviction behavior.

The repository enforces canonical paths, file names, line limits, dependency direction, and cycle
freedom through `scripts/verify-architecture.mjs` and `scripts/verify-cycles.mjs`.

## Runtime invariants

- One Worker: `oz-erp-edge`.
- One approved production route: `api.erp.ozotecev.com/*`.
- Private backend invocation uses `X-Serverless-Authorization` with a Google ID token.
- End-user `Authorization` remains untouched.
- `/tasks/**` and backend operational routes are never proxied publicly.
- Request bodies are bounded before backend dispatch.
- Redirects are not followed.
- The gateway remains stateless except for a bounded, expiring token cache and single-flight map.
