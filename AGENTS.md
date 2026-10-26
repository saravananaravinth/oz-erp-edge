<!-- oz-erp-edge/AGENTS.md -->
# Ozotec ERP — Project Rules

Applies to `oz-erp-api`, `oz-erp-edge`, `oz-next-app`. These are distinct Git repositories and may
run different deployed revisions.

## Sources and task discovery

- For **every** code, architecture, debugging, review, performance, deployment or UI change, locate
  and consult the applicable sections of **all eight** standards: `00-ozotec-system-map.md`,
  `01-engineering-standards.md`, `02-security-standards.md`, `03-api-and-auth-contracts.md`,
  `04-database-standards.md`, `05-frontend-standards.md`, `06-deployment-and-observability.md`,
  `07-ozotec-ui-ux-standards.md`. Apply `07` to every app/UI change. ChatGPT Project attachments are
  _not_ automatically available in Codex's filesystem; report missing files rather than inventing
  their contents.
- Source precedence: current task (without weakening security) > verified current SQL invariants >
  live repo code/config > standards 00–07 > accepted ADRs > current provider docs. Use accessible
  `ozotec_main_db_v2_35.sql` as the supplied SQL snapshot; verify current migrations/deployment
  before DDL. Ignore `public`, `credit`, `crm`, `fin`, `warranty` as legacy/testing **design
  precedents**. Verify current Git revisions, package manifests and all impacted consumers; never
  mistake proposals for deployed behavior.

## Boundaries and ownership

- Protected route: browser → Next.js server (`oz-next-app`) → server-only `ERP_EDGE` binding →
  Hono/Cloudflare `oz-erp-edge` → private Cloud Run `oz-erp-api` → PostgreSQL/Redis/Cloud Tasks.
  Protected staging/production calls fail closed if the binding is missing. No private Cloud Run
  endpoint, bearer token or credentials in browser code.
- Only explicitly approved public auth/engagement/provider paths call edge directly. Public edge
  exposes approved `/erp/**` plus edge `/livez` and `/readyz`; backend
  `/tasks/**`/metrics/operations remain private.
- API owns authn/authz, RBAC/ABAC, actor/tenant/resource scope, domain rules, SQL/transactions,
  audit, durable idempotency, webhooks/tasks. Edge owns route/Origin/CORS/header/body trust,
  rate/size controls, private Cloud Run invocation and bounded streaming—not domain authorization.
  App owns server sessions, typed protected transport and scope-safe UX.

## Nonnegotiable implementation rules

- Every nonpublic API operation validates action and tenant + org/dealer/financier/customer/resource
  scope; supplied IDs/headers are untrusted selectors. `/erp/auth/me`, not JWT metadata, governs UI
  permissions/menus. Keep access/refresh tokens in server-set Secure/HttpOnly/SameSite cookies
  (production `__Host-` preferred), enforce CSRF/Origin, refresh rotation/revocation, single-flight
  refresh and at most one safe `401` replay. Edge strips forged proxy/identity headers; keeps user
  `Authorization` separate from its `X-Serverless-Authorization` Cloud Run ID token.
- Node 24, ESM and strict TypeScript per repo manifests. Zod/equivalent validates
  HTTP/forms/cookies/uploads/config/tasks/webhooks/providers/persisted JSON/API responses. Preserve
  canonical success envelopes, safe RFC 7807 errors, `401/403/409/422/429`, `Retry-After`,
  abort/timeouts; `PATCH` partial, `PUT` replace, bounded keyset pagination. Preserve
  signatures/replay controls, OTP safeguards and scan-before-use uploads.
- PostgreSQL is authoritative: typed, parameterized, schema-qualified SQL; explicit columns and
  `tenant_id` + sub-scope even with RLS; no `SELECT *`, N+1 or unbounded work. Short
  locked/versioned transactions; release/rollback in `finally`; no HTTP/Redis/tasks/storage _inside_
  transactions. Use outbox/after-commit and durable payload-bound idempotency for critical writes,
  never Redis-only correctness. No shared cache for protected ERP, stock,
  financial/permission/OTP/workflow truth; other caches require reviewed scope/TTL/invalidation.
- No startup DDL. Expand → migrate → contract with mixed-version safety. Preserve
  request/correlation/trace IDs, redacted structured logs, bounded concurrency/retries,
  cancellation, readiness/SIGTERM and owned temporary-file cleanup. Measure latency p50/p95/p99,
  memory, DB waits, cost and UI Web Vitals before claiming improvements. Cloud Run min instances 1,
  concurrency/admission 16, DB pool max 6, and exact anonymous JWKS 60s cache are **review-dependent
  trial candidates**, not deployed defaults.

## Validation and delivery

- Test impacted auth/tenant boundaries, CSRF, validation, idempotency, private routes, cache
  isolation, webhooks, concurrency/shutdown, accessibility and responsive behavior as applicable.
  Run current repo-specific scripts below; disclose anything not executed.
- For schema/contract releases: backward-compatible DB expansion → compatible API → edge when needed
  → app → observe → later schema contraction. Require staged smoke/canary and rollback; never
  silently deploy.
- Report changed files and rationale, compatibility/security/data/performance impact, migrations,
  rollout/rollback, executed checks and unchanged repositories. Avoid full-file dumps unless
  explicitly requested.

## `oz-erp-edge`: Hono/Cloudflare gateway

- Respect existing layer boundaries. Apply exact route allowlist, Origin/CORS, header/body/media
  trust **before** proxy/cache; strip spoofed infrastructure/task identity and unsafe cookies.
  Preserve bounded Google ID-token acquisition/audience/skew, end-user Authorization and no-follow
  redirects.
- Stream permitted `Response.body` with backpressure, abort, safe headers and fresh request IDs.
  Keep standard JSON and warranty-multipart bounds (documented 1 MiB / 11 MiB) until the current
  contract is inspected. Preserve raw webhook signatures, never use `waitUntil` for durable business
  completion; no shared protected cache. JWKS caching requires a separate security/key-rotation
  review.
- Verify current scripts, then run `npm run verify` and `npm run cf:startup` as applicable. Test
  private route denial, header spoofing, Origin, streams/abort, webhook and cache isolation.
