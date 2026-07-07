Enterprise Cloudflare Hono Worker gateway for the private `oz-erp-api` Cloud Run service.

`oz-erp-edge` is the public edge boundary for ERP browser/API traffic. It accepts public
requests on Cloudflare, applies edge-safe validation and CORS controls, obtains a Google-signed
Cloud Run invocation ID token, and forwards allowed ERP routes to the private `oz-erp-api`
backend.

The Worker must stay intentionally thin. It must not contain ERP business logic, final
authorization, database access, tenant resolution, RBAC/ABAC decisions, or data mutation logic.
Those controls remain mandatory inside `oz-erp-api`.

---

## Runtime contract

| Area | Standard |
| --- | --- |
| Runtime | Cloudflare Workers |
| Framework | Hono |
| Language | TypeScript, strict mode |
| Module system | ESM |
| Package manager | npm |
| Node tooling | Node.js `>=24.0.0 <25.0.0`, npm `>=11.0.0` |
| Public route | `https://api.erp.ozotecev.com/*` |
| Private backend | `oz-erp-api` on Cloud Run |
| Cloud Run auth | Google ID token sent through `X-Serverless-Authorization` |
| Backend user auth | Original user `Authorization` header is preserved for `oz-erp-api` |
| Config validation | Zod, fail closed |
| Release title | `oz-erp-edge v<package.version>` |

---

## Responsibilities

The Worker is responsible for:

- Accepting public traffic for the ERP frontend/API edge domain.
- Enforcing CORS origin/method/header rules.
- Requiring an `Origin` header for mutating browser-facing requests when configured.
- Enforcing an allowlist of backend route prefixes.
- Blocking private backend-only paths from public proxying.
- Applying request ID and correlation ID propagation.
- Rejecting unsupported HTTP methods and body content types.
- Enforcing a maximum request body size from `Content-Length`.
- Obtaining and caching a Google-signed ID token for Cloud Run invocation.
- Forwarding allowed requests to private Cloud Run with safe headers.
- Returning stable RFC 7807-style problem JSON for edge failures.
- Exposing Worker-level `/livez` and `/readyz`.

The Worker is not responsible for:

- ERP RBAC, ABAC, or permission decisions.
- Tenant, organization unit, dealer, financier, or customer ownership checks.
- JWT claim trust decisions beyond forwarding the user token to the backend.
- OTP verification, idempotency enforcement, audit writes, webhook verification, or Cloud Task handling.
- Reading PostgreSQL, Redis, R2, or ERP integration providers directly.
- Implementing ERP business workflows.

---

## Project structure

```text
oz-erp-edge/
|-- .github/
|   `-- workflows/
|       `-- deploy.yml
|-- src/
|   |-- config.ts
|   |-- cors.ts
|   |-- gcp-id-token.ts
|   |-- health.ts
|   |-- index.ts
|   |-- problem.ts
|   |-- proxy.ts
|   |-- request-context.ts
|   `-- security.ts
|-- tests/
|   |-- config.test.ts
|   `-- proxy.test.ts
|-- eslint.config.js
|-- package.json
|-- prettier.config.js
|-- tsconfig.json
|-- vitest.config.ts
`-- wrangler.toml
```

### Source ownership

| File | Ownership |
| --- | --- |
| `src/index.ts` | Hono app bootstrap, request context/config middleware, route registration, top-level errors |
| `src/config.ts` | Worker environment schema, defaults, Zod validation, normalized config types |
| `src/cors.ts` | CORS policy, preflight handling, allowed origin enforcement |
| `src/gcp-id-token.ts` | Service account parsing, JWT assertion signing, Google ID token exchange/cache |
| `src/health.ts` | Edge `/livez` and `/readyz` handlers |
| `src/problem.ts` | Stable edge problem-details responses |
| `src/proxy.ts` | Route allowlist/blocklist, safe header forwarding, backend fetch, response sanitization |
| `src/request-context.ts` | Request ID and correlation ID extraction/generation |
| `src/security.ts` | Edge response security headers |
| `tests/**` | Config and route-proxy safety tests |

---

## Public route contract

The frontend calls the public Worker domain:

```text
https://api.erp.ozotecev.com/erp/auth/login/otp/request
```

The Worker forwards the request privately to Cloud Run:

```text
https://<cloud-run-service-url>/erp/auth/login/otp/request
```

Only backend paths matching the configured allowlist are proxyable. Current production defaults expose
only `/erp/**`.

Backend-only paths are blocked from public proxying:

```text
/tasks
/metrics
/readyz
/healthz
/livez
/version
```

Worker-owned health routes are still public at the edge:

```text
GET /livez
GET /readyz
```

`/readyz` verifies the Worker can obtain a Cloud Run invocation token and checks the backend
`/readyz` endpoint with that token.

---

## Security model

### Edge controls

`oz-erp-edge` applies these fail-closed controls before forwarding to Cloud Run:

- Zod validation for Worker configuration.
- Production wildcard CORS rejection.
- No wildcard CORS when credentials are enabled.
- CORS origin enforcement.
- `Origin` required for mutating requests when `REQUIRE_ORIGIN_ON_MUTATION=true`.
- Allowed HTTP method enforcement.
- Allowed body content types:
  - `application/json`
  - `multipart/form-data`
  - `application/x-www-form-urlencoded`
- Request body size limit based on `MAX_BODY_BYTES`.
- Public path allowlist using `ALLOWED_BACKEND_PREFIXES`.
- Backend-private path blocklist using `BLOCKED_BACKEND_PREFIXES`.
- Hop-by-hop and privileged inbound header stripping.
- Cloudflare/internal header stripping.
- Cloud Tasks header stripping.
- `X-Oz-Task-Secret` stripping.
- `X-Serverless-Authorization` stripping from client input.
- Safe backend response header sanitization.
- Security headers on responses:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Strict-Transport-Security`
  - `Cross-Origin-Resource-Policy: same-site`
  - default `Cache-Control: no-store`

### Backend controls that must remain in `oz-erp-api`

The backend must still verify every protected operation:

- JWT/JWKS and token claims.
- Actor context.
- Tenant isolation.
- RBAC and ABAC.
- Organization/dealer/financier/customer scope.
- Zod request validation.
- Rate limits.
- Idempotency keys.
- Transactions.
- Audit logging.
- Webhook signatures.
- Cloud Tasks authentication.
- PII/secrets redaction.

The edge gateway is a perimeter control, not a source of final authorization truth.

---

## Cloud Run invocation flow

1. Browser/frontend sends request to `https://api.erp.ozotecev.com/...`.
2. Worker validates config and creates request/correlation IDs.
3. CORS middleware validates origin and handles preflight.
4. Proxy resolves the public path to an allowed backend path.
5. Worker creates a Google JWT assertion using the configured service account key.
6. Worker exchanges the assertion at `GOOGLE_TOKEN_URI` for an ID token targeting `CLOUD_RUN_AUDIENCE`.
7. Worker caches the ID token until shortly before expiry.
8. Worker forwards the request to `CLOUD_RUN_BASE_URL`.
9. Worker sends the Cloud Run token in `X-Serverless-Authorization`.
10. Worker preserves the user `Authorization` header for backend JWT verification.
11. `oz-erp-api` performs final authentication, authorization, validation, and business logic.

---

## Configuration

### `wrangler.toml`

Production Worker metadata and non-secret variables are configured in `wrangler.toml`.

Current production route:

```toml
routes = [
  { pattern = "api.erp.ozotecev.com/*", zone_name = "ozotecev.com" }
]
```

Current production variables:

```toml
[vars]
APP_ENV = "production"
APP_NAME = "oz-erp-edge"
APP_VERSION = "0.1.0"
PUBLIC_API_PREFIX = ""
BACKEND_PATH_PREFIX = ""
ALLOWED_BACKEND_PREFIXES = "/erp"
BLOCKED_BACKEND_PREFIXES = "/tasks,/metrics,/readyz,/healthz,/livez,/version"
ALLOWED_ORIGINS = "https://erp.ozotecev.com,https://www.ozotecev.com"
ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS"
ALLOWED_HEADERS = "authorization,content-type,idempotency-key,x-idempotency-key,x-request-id,x-correlation-id,x-tenant-id,x-org-unit-id,x-dealer-org-unit-id,x-financier-id,x-customer-id"
EXPOSED_HEADERS = "x-request-id,x-correlation-id"
CORS_MAX_AGE_SECONDS = "600"
CORS_ALLOW_CREDENTIALS = "true"
REQUIRE_ORIGIN_ON_MUTATION = "true"
MAX_BODY_BYTES = "1048576"
FETCH_TIMEOUT_MS = "115000"
CLOUD_RUN_BASE_URL = "https://oz-erp-api-963011711716.asia-south1.run.app"
CLOUD_RUN_AUDIENCE = "https://oz-erp-api-963011711716.asia-south1.run.app"
GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token"
GOOGLE_TOKEN_CACHE_SKEW_SECONDS = "120"
```

### Required Worker secret

Set the service account key as a Cloudflare Worker secret, not as a normal variable:

```bash
wrangler secret put GCP_SERVICE_ACCOUNT_JSON_B64
```

Value format:

```bash
base64 -w 0 oz-erp-edge-worker-sa.json
```

Never commit service account JSON files or their base64-encoded contents.

### GitHub Actions secrets

The deploy workflow requires:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
```

The Cloudflare API token should be scoped to deploy this Worker only.

---

## GCP setup

Create a dedicated service account for the Worker and grant only Cloud Run Invoker on the
`oz-erp-api` service.

```bash
PROJECT_ID="ozotec-erp"
REGION="asia-south1"
SERVICE="oz-erp-api"
EDGE_SA="oz-erp-edge-worker@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create oz-erp-edge-worker \
  --project="${PROJECT_ID}" \
  --display-name="oz-erp-edge Worker Cloud Run Invoker"

gcloud run services add-iam-policy-binding "${SERVICE}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --member="serviceAccount:${EDGE_SA}" \
  --role="roles/run.invoker"
```

Create and encode the key only for Cloudflare Worker secret input:

```bash
gcloud iam service-accounts keys create ./oz-erp-edge-worker-sa.json \
  --project="${PROJECT_ID}" \
  --iam-account="${EDGE_SA}"

base64 -w 0 ./oz-erp-edge-worker-sa.json
```

After setting the Cloudflare secret, delete the local JSON file securely.

---

## Local development

Install dependencies:

```bash
npm ci
```

Generate Cloudflare Worker type bindings when bindings change:

```bash
npm run cf:typegen
```

Run the Worker through Wrangler:

```bash
npm run dev
```

Because the configured script uses remote Wrangler development mode, Cloudflare-side variables and
secrets must be available for realistic testing.

---

## Verification commands

Run these before opening a PR or deploying:

```bash
npm run typecheck
npm run lint
npm run test
npm run format:check
```

Full local verification:

```bash
npm run verify
npm run format:check
```

Available scripts:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run Wrangler development mode |
| `npm run deploy` | Deploy Worker with Wrangler |
| `npm run typecheck` | Run TypeScript without emitting |
| `npm run lint` | Run ESLint with zero warnings |
| `npm run lint:fix` | Auto-fix lint issues where safe |
| `npm run format` | Format with Prettier |
| `npm run format:check` | Check formatting |
| `npm run test` | Run Vitest |
| `npm run verify` | Run typecheck, lint, and tests |
| `npm run cf:typegen` | Generate Cloudflare Worker binding types |

---

## Deployment

Production deployment is managed by GitHub Actions:

```text
.github/workflows/deploy.yml
```

The workflow:

1. Validates required deployment secrets.
2. Sets up Node.js 24.
3. Runs `npm ci`.
4. Runs `npm run typecheck`.
5. Runs `npm run lint`.
6. Runs `npm run test`.
7. Runs `npm run format:check`.
8. Deploys the Cloudflare Worker with `cloudflare/wrangler-action`.
9. Smoke-checks `https://api.erp.ozotecev.com/livez`.
10. Creates release notes.
11. Creates a GitHub release titled `oz-erp-edge v<package.version>`.

Manual deployment:

```bash
npm run verify
npm run format:check
npm run deploy
```

---

## Health checks

### Edge liveness

```bash
curl -i https://api.erp.ozotecev.com/livez
```

Expected behavior:

- Returns `200`.
- Does not require backend readiness.
- Returns Worker service, version, environment, request ID, and timestamp.

### Edge readiness

```bash
curl -i https://api.erp.ozotecev.com/readyz
```

Expected behavior:

- Returns `200` when the Worker can obtain a Cloud Run ID token and the backend `/readyz` is ready.
- Returns `503` when token acquisition fails or backend readiness fails.

---

## Proxy behavior

### Allowed example

```bash
curl -i "https://api.erp.ozotecev.com/erp/auth/login/otp/request" \
  -H "Origin: https://erp.ozotecev.com" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: local-edge-test-0001" \
  --data '{"clientId":"erp-web","identifier":{"type":"PHONE","value":"+919999999999"}}'
```

The backend response depends on `oz-erp-api` validation and auth logic.

### Blocked examples

These must not be exposed through the edge proxy:

```bash
curl -i https://api.erp.ozotecev.com/tasks/notification.send
curl -i https://api.erp.ozotecev.com/metrics
curl -i https://api.erp.ozotecev.com/admin/internal
```

Expected behavior:

- `404 EDGE_ROUTE_NOT_FOUND` for non-exposed routes.
- `403 EDGE_ORIGIN_FORBIDDEN` for disallowed origins.
- `403 EDGE_ORIGIN_REQUIRED` for mutating requests without `Origin` when required.
- `405 EDGE_METHOD_NOT_ALLOWED` for unsupported methods.
- `413 EDGE_PAYLOAD_TOO_LARGE` for oversized bodies.
- `415 EDGE_UNSUPPORTED_MEDIA_TYPE` for unsupported request content types.
- `503 EDGE_CLOUD_RUN_TOKEN_UNAVAILABLE` when Cloud Run token acquisition fails.
- `504 EDGE_BACKEND_TIMEOUT` when backend fetch exceeds `FETCH_TIMEOUT_MS`.

---

## Testing standards

Tests must cover:

- Config parsing defaults and production rejection rules.
- CORS wildcard rejection in production.
- CORS wildcard rejection when credentials are enabled.
- Allowed frontend origins.
- Public-to-backend path mapping.
- Blocked backend private paths.
- Unknown path rejection.
- Header propagation and sanitization for proxy requests.
- Problem JSON responses for edge failures.

Current tests include:

```text
tests/config.test.ts
tests/proxy.test.ts
```

---

## Change safety checklist

Before changing this Worker, verify:

- The change does not introduce ERP business logic into the edge layer.
- The change does not bypass backend authentication or authorization.
- The route allowlist still exposes only intended public backend paths.
- `/tasks`, `/metrics`, backend health, and backend version routes remain blocked from proxying.
- User `Authorization` is preserved for `oz-erp-api`.
- Cloud Run invocation auth remains in `X-Serverless-Authorization`.
- Client-supplied `X-Serverless-Authorization`, Cloud Tasks headers, and `X-Oz-Task-Secret` remain stripped.
- CORS production rules remain fail-closed.
- No secrets are moved into `wrangler.toml`, Git, logs, release notes, or normal variables.
- `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run format:check` pass.

---

## Troubleshooting

| Symptom | Likely cause | Check |
| --- | --- | --- |
| `503 EDGE_CONFIG_INVALID` | Missing/invalid Worker variable or secret | Validate `wrangler.toml` vars and `GCP_SERVICE_ACCOUNT_JSON_B64` secret |
| `503 EDGE_CLOUD_RUN_TOKEN_UNAVAILABLE` | Service account key invalid, missing secret, bad token URI, or bad audience | Check Worker secret, `CLOUD_RUN_AUDIENCE`, and service account key |
| `403 EDGE_ORIGIN_FORBIDDEN` | Frontend origin not in `ALLOWED_ORIGINS` | Add the exact origin, including scheme |
| `403 EDGE_ORIGIN_REQUIRED` | Mutating request without `Origin` | Ensure browser/frontend sends an allowed `Origin` |
| `404 EDGE_ROUTE_NOT_FOUND` | Path is outside `/erp` or is explicitly blocked | Check `ALLOWED_BACKEND_PREFIXES` and `BLOCKED_BACKEND_PREFIXES` |
| `413 EDGE_PAYLOAD_TOO_LARGE` | `Content-Length` exceeds `MAX_BODY_BYTES` | Increase only if backend/body-limit policy supports it |
| `415 EDGE_UNSUPPORTED_MEDIA_TYPE` | Unsupported body content type | Use JSON, multipart, or URL-encoded bodies |
| `504 EDGE_BACKEND_TIMEOUT` | Cloud Run backend did not respond before timeout | Check `oz-erp-api` readiness, latency, and Cloud Run logs |
| Cloud Run returns `401/403` | Backend JWT/RBAC or Cloud Run invocation failed | Confirm `X-Serverless-Authorization`, backend `Authorization`, and service account `roles/run.invoker` |

---

## Operational principles

- Keep Cloud Run private.
- Keep the edge gateway public but thin.
- Keep all ERP decisions in `oz-erp-api`.
- Preserve request and correlation IDs end-to-end.
- Do not trust frontend-supplied tenant, org, dealer, financier, customer, user, or system headers.
- Strip privileged client-supplied infrastructure headers.
- Fail closed on config, CORS, route exposure, token acquisition, and backend timeout.
- Document every route exposure change as a security-impacting change.