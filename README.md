# oz-erp-edge

Enterprise Cloudflare Hono Worker gateway for the private `oz-erp-api` Cloud Run service.

The Worker is the only public API boundary. It applies edge-safe controls and invokes Cloud Run with
a Google ID token while preserving the end-user Bearer token for backend authentication. It does not
implement ERP authorization, tenancy, database access, business workflows, webhook trust, or
idempotency.

## Runtime contract

| Area                 | Standard                                                  |
| -------------------- | --------------------------------------------------------- |
| Runtime              | Cloudflare Workers                                        |
| Framework            | Hono                                                      |
| Language             | strict TypeScript / ESM                                   |
| Tooling              | Node.js 24 and npm 11                                     |
| Public route         | `https://api.erp.ozotecev.com/*`                          |
| Private backend      | `oz-erp-api` on Cloud Run                                 |
| Cloud Run invocation | Google ID token in `X-Serverless-Authorization`           |
| User authentication  | Original `Authorization` header forwarded to `oz-erp-api` |
| Configuration        | Strict Zod validation; invalid configuration fails closed |
| Release title        | `oz-erp-edge v<version>`                                  |

## Security boundaries

The edge gateway:

- allows only configured `/erp/**` backend prefixes;
- blocks `/tasks/**`, root health routes, and the currently mounted `/erp/*` health, version, and
  metrics routes;
- strips client-supplied Cloud Run, Cloud Tasks, Google infrastructure, forwarding, cookie, and
  Cloudflare identity headers;
- preserves the user Bearer token but generates trusted request, correlation, forwarding, and edge
  gateway headers;
- requires an allowed browser `Origin` for mutating ERP requests;
- exempts only exact provider webhook routes from the browser-origin requirement;
- applies exact route-specific media-type rules;
- buffers request bodies only up to their route-specific cap before backend dispatch;
- returns stable RFC 7807-style edge problems without backend details;
- enforces strict response security headers without weakening stricter API policies.

Backend authorization remains authoritative. The Worker must never trust tenant, organization unit,
dealer, financier, customer, permission, or role headers as proof of access.

## Route policy

### Public Worker routes

| Route         | Purpose                                                               |
| ------------- | --------------------------------------------------------------------- |
| `GET /livez`  | Worker process/configuration liveness and deployed runtime version    |
| `GET /readyz` | Validated private call to `oz-erp-api /erp/readyz`                    |
| `/erp/**`     | Allowlisted proxy surface, subject to blocked-prefix and route policy |

### Never publicly proxied

```text
/tasks/**
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

### Raw webhook routes

The following exact routes may omit browser `Origin` and may carry provider-specific raw media
types. The backend still verifies endpoint keys, signatures, timestamps, replay protection, schemas,
and provider event IDs.

```text
ALL  /erp/channel-ingest/webhooks/telecmi/:endpointKey
POST /erp/channel-ingest/webhooks/msg91/:endpointKey
POST /erp/channel-ingest/webhooks/zeptomail/:endpointKey
```

### Warranty upload route

```text
POST /erp/engagement/public/forms/warranty/:token/files
Content-Type: multipart/form-data; boundary=...
```

The ordinary edge body limit remains 1 MiB. Only this exact route receives an 11 MiB multipart
envelope limit around the API's authoritative 10 MiB single-file limit.

## Body and media-type policy

| Route class          | Accepted body contract                                        | Edge cap                            |
| -------------------- | ------------------------------------------------------------- | ----------------------------------- |
| Ordinary ERP         | `application/json`, `application/*+json`, or URL-encoded form | `MAX_BODY_BYTES` (1 MiB production) |
| Provider webhook     | Any syntactically valid media type, or no media type          | `MAX_BODY_BYTES`                    |
| Warranty file upload | Multipart with a valid boundary                               | 11 MiB                              |
| Empty mutation       | No `Content-Type` required                                    | 0 bytes                             |

The Worker reads the incoming stream into a bounded buffer before invoking Cloud Run. Therefore,
missing, invalid, or misleading `Content-Length` values cannot bypass the edge limit or cause a
partially forwarded oversized mutation.

## CORS

Production uses exact HTTPS origins and `CORS_ALLOW_CREDENTIALS=false`. Browser clients authenticate
with the `Authorization` header, not cookies. Exposed response headers include request tracing,
`Retry-After`, and API rate-limit telemetry.

## Configuration

Non-secret production values are stored in `wrangler.toml`. The service account JSON is a Worker
secret and must never be committed:

```bash
npx wrangler secret put GCP_SERVICE_ACCOUNT_JSON_B64
```

The value is the base64/base64url-encoded service account JSON. The service account requires only
the permission needed to invoke the private Cloud Run service.

Important production variables:

```text
BACKEND_READINESS_PATH=/erp/readyz
CLOUD_RUN_AUTH_MODE=id_token
CORS_ALLOW_CREDENTIALS=false
MAX_BODY_BYTES=1048576
FETCH_TIMEOUT_MS=115000
READINESS_TIMEOUT_MS=5000
GOOGLE_TOKEN_TIMEOUT_MS=5000
```

`BACKEND_READINESS_PATH` must also remain in `BLOCKED_BACKEND_PREFIXES` so it can be used internally
by Worker readiness without becoming part of the public proxy surface.

## Local development

Install with the tracked lockfile:

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

The default example uses a localhost backend and automatic auth mode, which resolves Cloud Run
invocation authentication to disabled only for localhost HTTP development.

For remote development against private Cloud Run, configure an HTTPS backend, set
`CLOUD_RUN_AUTH_MODE=id_token`, and provide the service account secret only through `.dev.vars` or
Wrangler secret storage.

## Verification

```bash
npm run typecheck
npm run lint
npm run test
npm run format:check
npm run build
npm audit --omit=dev --audit-level=high
```

Or run:

```bash
npm run verify
```

The test suite covers configuration fail-closed behavior, blocked backend routes, route-specific
content types, bounded bodies without trusted `Content-Length`, privileged-header stripping, webhook
origin exemptions, strict backend readiness validation, CORS telemetry, and security-header
hardening.

## Deployment and release behavior

The production workflow always verifies and deploys the commit after a successful main-branch run.

- Releasable Conventional Commits create a semantic GitHub release named `oz-erp-edge v<version>`.
- A non-releasable commit still deploys with runtime build metadata such as
  `0.1.0+build.<run>.<sha>` but does not create a GitHub release.
- Deployment fails unless `/livez` reports the exact runtime version and `/readyz` confirms the
  validated private API readiness contract.

Supported release commits:

```text
feat:      minor
fix:       patch
perf:      patch
security:  patch
revert:    patch
<type>!:   major
BREAKING CHANGE: major
```

## Project structure

```text
oz-erp-edge/
|-- .github/workflows/deploy.yml
|-- src/
|   |-- config.ts
|   |-- cors.ts
|   |-- gcp-id-token.ts
|   |-- health.ts
|   |-- index.ts
|   |-- origin-policy.ts
|   |-- problem.ts
|   |-- proxy.ts
|   |-- request-context.ts
|   |-- route-policy.ts
|   `-- security.ts
|-- tests/
|   |-- config.test.ts
|   |-- cors.test.ts
|   |-- health.test.ts
|   |-- proxy.test.ts
|   `-- security.test.ts
|-- package-lock.json
|-- package.json
|-- wrangler.toml
`-- README.md
```
