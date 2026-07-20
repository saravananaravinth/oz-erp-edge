# Deployment architecture

The GitHub Actions workflow orchestrates checked-in scripts rather than embedding release and
rollout parsers in YAML.

## Verification

The workflow validates the exact checkout, npm toolchain, package-lock synchronization, canonical
architecture, generated Cloudflare bindings, strict TypeScript programs, ESLint, tests, formatting,
Wrangler build, production audit, and Worker startup limits.

## Release and rollout

1. Create an immutable Wrangler configuration with the resolved runtime version.
2. Validate the required Worker secret.
3. Require one stable production version at 100% traffic.
4. Upload an immutable candidate version.
5. At 0%, retry the version override until the candidate is observable through the production route,
   then run eight concurrent authenticated readiness checks against that version.
6. Promote to 5%, then 25%, then 100%, validating health between stages.
7. Automatically roll back to the captured stable version when rollout fails.
8. Create a GitHub release only after successful promotion.

Deployment scripts live in `scripts` so parsing and rollout logic can be reviewed, linted, tested,
and maintained independently from workflow syntax.
