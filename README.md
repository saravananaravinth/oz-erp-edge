# oz-erp-edge

`oz-erp-edge` is the enterprise Cloudflare Workers gateway for the private `oz-erp-api` Cloud Run
service. It is deployed at:

```text
https://api.erp.ozotecev.com
```

The Worker owns public route exposure, origin and CORS enforcement, bounded request handling, header
trust, authenticated Cloud Run invocation, response sanitization, and edge health. ERP business
logic, RBAC/ABAC, tenant isolation, transactions, SQL, idempotency, audit, and webhook verification
remain authoritative in `oz-erp-api`.

## Architecture

```text
src/
├── apps/worker/          Hono composition and runtime dependencies
├── config/               Strict Worker environment schema and parsing
├── gateway/
│   ├── cors/             CORS headers, validation, and middleware
│   ├── http/             Problems, security headers, request context
│   ├── proxy/            Body bounds, header trust, backend proxying
│   └── routing/          Route contracts, exposure, classification, origin policy
├── infrastructure/google Google assertion signing, token exchange, bounded cache
├── observability/        Redacted structured request logging
├── operations/health/    Edge liveness and private-backend readiness
└── shared/               Dependency-free primitives
```

Detailed contracts are in `docs/architecture`.

## Request path

```text
Browser / mobile app / provider webhook
                ↓
Cloudflare Worker: oz-erp-edge
                ↓  X-Serverless-Authorization: Bearer <Google ID token>
Private oz-erp-api Cloud Run service
```

The original end-user `Authorization` header is preserved. Client-supplied Cloud Run, Cloud Tasks,
Google identity, cookie, Cloudflare identity, and forwarded identity headers are removed.

## Public endpoints

- `GET /livez`: Worker/configuration liveness and active Worker version.
- `GET /readyz`: authenticated private-backend readiness with strict response validation.
- `/erp/**`: approved ERP proxy surface subject to route, method, origin, media-type, and size
  policy.

The gateway never publicly exposes `/tasks/**`, metrics, backend readiness, backend liveness,
health, or version routes.

## Origin policy

Production uses explicit HTTPS origins and bearer authentication without cookies:

```text
CORS_ALLOW_CREDENTIALS=false
REQUIRE_ORIGIN_ON_MUTATION=true
```

A bearer token does not bypass origin enforcement. Only exact webhook and documented native-app
mutation contracts may omit `Origin`.

## Request limits

- Standard ERP requests: 1 MiB.
- Exact warranty multipart upload: 11 MiB edge envelope.
- Compressed requests: rejected.
- Unknown-length streams: incrementally bounded and cancelled on overflow.
- Backend redirects: not followed.

## Cloud Run authentication

Production requires:

```text
CLOUD_RUN_AUTH_MODE=id_token
GCP_SERVICE_ACCOUNT_JSON_B64=<Worker secret>
```

The service account should have only `roles/run.invoker` on the target Cloud Run service. Configure
or rotate the secret with Wrangler; never store it in Git or `wrangler.jsonc`.

## Local development

Required toolchain:

```text
Node.js 24
npm 12.0.1
```

Run:

```bash
npm ci --no-audit --no-fund
cp .dev.vars.example .dev.vars
npm run dev
```

The example uses `http://localhost:8080` and automatic Cloud Run authentication, which resolves to
disabled only for localhost HTTP development.

## Verification

```bash
npm run verify
npm run cf:startup
```

The verification pipeline runs generated-binding drift checks, architecture and cycle checks, strict
Worker and test typechecks, ESLint, security-policy unit/integration tests, Prettier, Wrangler
strict build, and production dependency audit.

## Production deployment

`.github/workflows/deploy.yml` uses checked-in scripts under `.github/scripts` for repository
validation, release planning, immutable configuration generation, stable-version capture, candidate
upload, canary rollout, health verification, rollback, and release notes.

The protected `production` environment requires:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
```

The Worker requires the remote secret:

```text
GCP_SERVICE_ACCOUNT_JSON_B64
```

The rollout sequence is 0% version-override smoke, 5% canary, 25% canary, and 100% promotion. A
failure after rollout starts triggers an automatic rollback to the captured stable Worker version.
