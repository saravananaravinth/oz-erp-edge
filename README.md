# oz-erp-edge

`oz-erp-edge` is the public Cloudflare Workers gateway for the private `oz-erp-api` Cloud Run
service. It is implemented with Hono and strict TypeScript and is deployed at:

```text
https://api.erp.ozotecev.com
```

The gateway owns edge routing, request normalization, origin enforcement, bounded request-body
handling, Cloud Run invocation authentication, response sanitization, security headers, and edge
health endpoints. ERP authentication, authorization, tenant isolation, business validation, database
access, webhook verification, and transactional integrity remain authoritative in `oz-erp-api`.

## Request path

```text
Browser / Android app / provider webhook
                    |
                    v
https://api.erp.ozotecev.com
Cloudflare Worker: oz-erp-edge
                    |
                    | X-Serverless-Authorization: Bearer <Google ID token>
                    | Authorization: Bearer <end-user access token>, when supplied
                    v
Private oz-erp-api Cloud Run service
```

The Worker uses a Google service-account credential stored as a Cloudflare Worker secret to exchange
a signed assertion for a Google ID token. The ID token is sent through `X-Serverless-Authorization`;
the original client `Authorization` header is preserved for ERP user authentication.

## Runtime and tooling

| Area                     | Contract                      |
| ------------------------ | ----------------------------- |
| Runtime                  | Cloudflare Workers            |
| Framework                | Hono                          |
| Language                 | TypeScript, ESM, strict mode  |
| CI runtime               | Node.js 24                    |
| Package manager          | npm 11.16.0                   |
| Wrangler                 | Pinned by `package-lock.json` |
| Production configuration | `wrangler.jsonc`              |
| Worker name              | `oz-erp-edge`                 |
| Production route         | `api.erp.ozotecev.com/*`      |
| Backend region alignment | `gcp:asia-south1`             |
| Backend invocation mode  | Google ID token               |

## Public edge endpoints

### `GET /livez`

Reports Worker process/configuration liveness and the active Cloudflare Worker version tag.

A healthy response has:

```json
{
  "success": true,
  "data": {
    "service": "oz-erp-edge",
    "status": "alive",
    "version": "v0.1.0-0123456789ab",
    "environment": "production",
    "cloud_run_auth_mode": "id_token",
    "timestamp": "2026-07-16T00:00:00.000Z"
  },
  "request_id": "...",
  "timestamp": "2026-07-16T00:00:00.000Z"
}
```

### `GET /readyz`

Obtains a Google ID token, invokes the private backend readiness endpoint, and validates the
complete backend response contract. Readiness succeeds only when the backend returns HTTP `200`,
reports `ready`, and supplies a valid dependency envelope.

### `/erp/**`

The approved ERP proxy surface. Routes are still subject to method, origin, content-type, body-size,
blocked-prefix, and route-class policy.

## Backend routes never exposed through the gateway

The following prefixes are blocked even though the Worker can internally call `/erp/readyz` for
readiness:

```text
/tasks
/metrics
/readyz
/healthz
/livez
/version
/erp/metrics
/erp/readyz
/erp/healthz
/erp/livez
/erp/version
```

Requests outside the configured allowlist return an edge-generated RFC 7807-style problem response
and are not forwarded to Cloud Run.

## Route classes

### Standard ERP routes

Standard requests accept:

```text
application/json
application/*+json
application/x-www-form-urlencoded
```

The ordinary production request-body cap is `1,048,576` bytes.

### Provider webhook routes

The exact provider webhook contracts are:

```text
ALL  /erp/channel-ingest/webhooks/telecmi/:endpointKey
POST /erp/channel-ingest/webhooks/msg91/:endpointKey
POST /erp/channel-ingest/webhooks/zeptomail/:endpointKey
```

These routes may omit browser `Origin` and may use provider-specific raw media types. Endpoint-key
lookup, signature enforcement, timestamp validation, replay prevention, payload validation,
idempotency, and durable processing remain backend responsibilities.

### Warranty multipart upload

```text
POST /erp/engagement/public/forms/warranty/:token/files
Content-Type: multipart/form-data; boundary=...
```

Only this exact route receives an `11 MiB` edge envelope limit. The backend retains the
authoritative `10 MiB` file limit and validates file count, MIME type, extension, magic bytes,
ownership, token scope, and malware-scanning workflow.

### Native application mutation exemptions

The following Android/native application operations may omit browser `Origin` while retaining
backend authentication and authorization:

```text
POST   /erp/auth/login/otp/request
POST   /erp/auth/login/otp/verify
POST   /erp/auth/token/refresh
DELETE /erp/auth/sessions/current
DELETE /erp/auth/sessions/:sessionId
PUT    /erp/engagement/owner-guide/me/location
POST   /erp/engagement/owner-guide/location-requests/:requestId/location
POST   /erp/engagement/owner-guide/assignments/:assignmentId/accept
POST   /erp/engagement/owner-guide/assignments/:assignmentId/reject
POST   /erp/engagement/owner-guide/assignments/:assignmentId/visit
POST   /erp/engagement/owner-guide/assignments/:assignmentId/test-drive-complete
```

This exemption only removes the browser-origin requirement. It does not bypass bearer-token
verification, actor resolution, RBAC/ABAC, tenant scope, ownership checks, idempotency, or backend
validation.

## Origin and CORS policy

Production configuration uses an explicit HTTPS origin allowlist:

```text
https://erp.ozotecev.com
https://www.ozotecev.com
```

The production contract is:

```text
CORS_ALLOW_CREDENTIALS=false
REQUIRE_ORIGIN_ON_MUTATION=true
```

Browser mutations must carry an allowed `Origin`, except for exact server-to-server webhook routes
and exact native application routes. Authentication uses bearer tokens rather than cookies.

Browser-visible response headers include request tracing, retry information, and rate-limit
telemetry:

```text
x-request-id
x-correlation-id
retry-after
x-ratelimit-scope
x-ratelimit-limit
x-ratelimit-remaining
```

## Header trust boundary

Before forwarding a request, the Worker removes client-controlled infrastructure and proxy identity
headers, including client-supplied Cloud Run authorization, Cloud Tasks identity, forwarded
identity, cookies, and Cloudflare-internal identity values.

The Worker then creates trusted values for:

```text
x-serverless-authorization
x-request-id
x-correlation-id
x-forwarded-for
x-forwarded-proto
x-oz-edge-gateway
```

The original end-user `Authorization` header is preserved. Tenant, organization-unit, dealer,
financier, and customer headers are request context selectors only; they are never accepted as proof
of access.

## Request-body safety

The gateway rejects compressed request bodies and enforces body limits before backend dispatch.

When `Content-Length` is present, it must be a non-negative integer and must not exceed the
route-specific limit. When `Content-Length` is absent, the Worker reads through a bounded stream and
stops once the permitted limit is exceeded. An unbounded request is therefore not partially
forwarded to Cloud Run.

Empty mutations may omit `Content-Type`. Requests with a non-empty body must satisfy the exact
media-type policy for their route class.

## Cloud Run authentication

Production must use:

```text
CLOUD_RUN_AUTH_MODE=id_token
```

The required Cloudflare Worker secret is:

```text
GCP_SERVICE_ACCOUNT_JSON_B64
```

The value must be the base64 or base64url encoding of a Google service-account JSON document
containing only a valid service-account email, PKCS#8 private key, and optional token URI. Never
commit this value to the repository or place it in `wrangler.jsonc`.

Configure or rotate the Worker secret from an authorized workstation:

```bash
base64 -w 0 oz-erp-edge-worker-sa.json | npx wrangler secret put GCP_SERVICE_ACCOUNT_JSON_B64
```

On macOS, use:

```bash
base64 < oz-erp-edge-worker-sa.json | tr -d '\n' | npx wrangler secret put GCP_SERVICE_ACCOUNT_JSON_B64
```

The service account should have only the permission required to invoke the target private Cloud Run
service.

## Local development

```bash
npm ci --no-audit --no-fund
cp .dev.vars.example .dev.vars
npm run dev
```

The local example uses a localhost backend and automatic Cloud Run authentication mode. Automatic
mode resolves to disabled only for localhost HTTP development. Remote development against Cloud Run
must use HTTPS, `id_token`, and a locally supplied service-account secret.

Never commit `.dev.vars`, `.env`, private keys, certificates, or service-account JSON files.

## Verification

Run the authoritative repository verification pipeline:

```bash
npm run verify
npm run cf:startup
```

`npm run verify` executes:

```text
Cloudflare generated-binding drift check
TypeScript type checking
ESLint with zero warnings
Prettier formatting check
Wrangler strict dry-run build
Production dependency audit at high severity
```

`npm run cf:startup` validates Worker startup limits separately.

No automated test suite is currently configured in `package.json`. Deployment automation must not
call a nonexistent `npm run test` command.

## Production deployment

Production deployment is controlled by `.github/workflows/deploy.yml` and runs on:

```text
Push to main
Manual workflow dispatch
```

The protected GitHub `production` environment must contain:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
```

The Cloudflare API token must be scoped to the minimum permissions needed to read and update the
`oz-erp-edge` Worker, its versions/deployments, Worker secrets, and the approved route for the
`ozotecev.com` zone. Restrict the token to the specific account and zone.

### Deployment preconditions

The automated rollout fails closed unless:

- the exact Git commit is checked out;
- Node.js and npm match the pinned production toolchain;
- package and lockfile declarations are synchronized;
- the production manifest satisfies the route, CORS, blocked-path, Cloud Run, observability, and
  secret-exclusion policies;
- all repository verification commands pass;
- the required Worker secret exists remotely;
- production currently has exactly one stable Worker version receiving `100%` of traffic.

A manually abandoned split deployment must be stabilized before rerunning automation.

### Rollout sequence

The workflow does not use `wrangler deploy`, which would create a version and immediately route
`100%` of traffic to it. It uses independent Worker version upload and deployment operations:

1. Generate a temporary release configuration containing the resolved runtime semantic version.
2. Build again with Wrangler strict mode.
3. Capture the current `100%` stable version ID.
4. Upload the candidate with an immutable version tag and deployment message.
5. Create a deployment with the candidate at `0%` and the stable version at `100%`.
6. Smoke-test the candidate through `Cloudflare-Workers-Version-Overrides`.
7. Promote the candidate to `5%`.
8. Revalidate candidate liveness and private-backend readiness.
9. Promote the candidate to `25%`.
10. Revalidate candidate liveness and private-backend readiness.
11. Promote the candidate to `100%`.
12. Verify public `/livez` reports the expected version tag and `/readyz` reports a valid
    private-backend readiness contract.

Any failure after deployment traffic configuration starts triggers `wrangler rollback` to the
captured stable version. If Cloudflare rejects the rollback, the workflow emits the exact previous
version ID requiring manual restoration.

### Release versioning

Automatic release classification follows Conventional Commits:

| Commit                                  | Release                           |
| --------------------------------------- | --------------------------------- |
| `BREAKING CHANGE:` or `type!:`          | Major                             |
| `feat:`                                 | Minor                             |
| `fix:`, `perf:`, `security:`, `revert:` | Patch                             |
| Other commit types                      | Deployment without GitHub release |

Manual dispatch may force `patch`, `minor`, `major`, or `none`.

A releasable deployment creates a GitHub release only after successful `100%` promotion and final
health verification. Non-release deployments use semantic build metadata for `APP_VERSION` and still
receive a unique Cloudflare Worker version tag.

## Health verification commands

Public liveness:

```bash
curl --fail --silent --show-error \
  https://api.erp.ozotecev.com/livez
```

Public readiness:

```bash
curl --fail --silent --show-error \
  https://api.erp.ozotecev.com/readyz
```

Recent Worker versions:

```bash
npx wrangler versions list --json
```

Current deployment distribution:

```bash
npx wrangler deployments status --json
```

Manual rollback to a known stable version:

```bash
npx wrangler rollback <WORKER_VERSION_ID> \
  --message "Manual production rollback"
```

## Operational logging

The Worker emits structured request-completion events containing safe operational fields such as
route class, HTTP status, total duration, backend duration, Cloudflare colo, Worker version ID, and
Worker tag.

Production observability is enabled in `wrangler.jsonc` with sampled invocation logs and traces.
Logs must not include credentials, bearer tokens, service-account contents, customer PII, or backend
error internals.

## Configuration ownership

| Configuration                    | Source of truth                         |
| -------------------------------- | --------------------------------------- |
| Non-secret Worker runtime values | `wrangler.jsonc`                        |
| Worker dependency versions       | `package.json` and `package-lock.json`  |
| Cloud Run invocation credential  | Cloudflare Worker secret                |
| Production deployment policy     | `.github/workflows/deploy.yml`          |
| ERP authorization and tenancy    | `oz-erp-api`                            |
| Cloud Run IAM                    | Google Cloud IAM                        |
| DNS and Worker route             | Cloudflare account and `wrangler.jsonc` |

Changes to route exposure, allowed origins, Cloud Run audience, request limits, native-app
exemptions, webhook routes, or private backend prefixes require coordinated security review across
`oz-erp-edge`, `oz-erp-api`, and the consuming clients.
