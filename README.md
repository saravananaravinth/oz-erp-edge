# oz-erp-edge-worker

Enterprise Cloudflare Hono Worker gateway for the private `oz-erp-api` Cloud Run service.

The Worker is intentionally thin:

- accepts public browser traffic from the Next.js frontend;
- enforces CORS, request IDs, basic content-type/body limits, and public route allowlists;
- obtains a Google-signed ID token for Cloud Run invocation;
- sends the Cloud Run token through `X-Serverless-Authorization` so the user JWT in `Authorization`
  is preserved for `oz-erp-api`;
- does **not** perform ERP authorization, RBAC, ABAC, tenant resolution, database access, or
  business logic.

## Public route contract

Frontend calls this public edge URL:

```text
https://api.ozotecev.com/erp/auth/login/otp/request
```

The Worker forwards it privately to Cloud Run as:

```text
https://<cloud-run-service-url>/erp/auth/login/otp/request
```

By default, only `/erp/**` is exposed. `/tasks`, `/metrics`, and health/version backend routes are
blocked from frontend proxying.

## Required Cloudflare variables

Configure these in `wrangler.toml` or Cloudflare dashboard variables:

```text
APP_ENV=production
PUBLIC_API_PREFIX=
ALLOWED_BACKEND_PREFIXES=/erp
BLOCKED_BACKEND_PREFIXES=/tasks,/metrics,/readyz,/healthz,/livez,/version
ALLOWED_ORIGINS=https://erp.ozotecev.com,https://www.ozotecev.com
CLOUD_RUN_BASE_URL=https://<service>-<hash>-<region>.a.run.app
CLOUD_RUN_AUDIENCE=https://<service>-<hash>-<region>.a.run.app
GOOGLE_TOKEN_URI=https://oauth2.googleapis.com/token
```

Configure this as a Cloudflare Worker secret, never as a normal variable:

```text
GCP_SERVICE_ACCOUNT_JSON_B64=<base64 encoded service account key json>
```

## GCP setup

Create a dedicated service account for the Worker and grant only Cloud Run Invoker on `oz-erp-api`:

```bash
PROJECT_ID="ozotec-erp"
REGION="asia-south1"
SERVICE="oz-erp-api"
EDGE_SA="oz-erp-edge-worker@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create oz-erp-edge-worker \
  --project="${PROJECT_ID}" \
  --display-name="Oz ERP Edge Worker Cloud Run Invoker"

gcloud run services add-iam-policy-binding "${SERVICE}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --member="serviceAccount:${EDGE_SA}" \
  --role="roles/run.invoker"
```

Create the service account key and immediately upload it as a Cloudflare secret:

```bash
gcloud iam service-accounts keys create ./edge-worker-sa.json \
  --project="${PROJECT_ID}" \
  --iam-account="${EDGE_SA}"

base64 -w0 ./edge-worker-sa.json | npx wrangler secret put GCP_SERVICE_ACCOUNT_JSON_B64
shred -u ./edge-worker-sa.json
```

For production, rotate this key periodically and restrict who can create service account keys in
IAM.

## Local development

```bash
cp .dev.vars.example .dev.vars
npm ci
npm run dev
```

Use a real `GCP_SERVICE_ACCOUNT_JSON_B64` only on a secured developer machine.

## Verification

```bash
npm run typecheck
npm run lint
npm run test
npm run deploy
```

## Next.js frontend usage

Set the frontend API base URL to the Worker route:

```bash
NEXT_PUBLIC_API_BASE_URL=https://api.ozotecev.com
```

Then call backend resources through the Worker:

```ts
await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/erp/auth/login/otp/request`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-request-id": crypto.randomUUID(),
  },
  body: JSON.stringify(payload),
});
```

Authenticated frontend calls must keep the ERP access token in `Authorization`; the Worker preserves
it and uses `X-Serverless-Authorization` only for Cloud Run IAM invocation.
