# Production deployments

This file records manual Cloudflare deployments. A Git commit is not considered deployed until it is listed here after deployment and smoke testing.

## Current production deployment

Not yet verified from this workspace. Before the next deployment, compare the complete Cloudflare editor source with `worker/worker.js` and record the current production baseline below.

| Deployed at (UTC) | Worker version | Git commit | Cloudflare version/deployment | Deployed by | Smoke-test result |
|---|---|---|---|---|---|
| _Unverified_ | _Unknown_ | _Unknown_ | _Unknown_ | _Unknown_ | _Not run_ |

## Manual deployment checklist

- [ ] Back up or copy the currently deployed Cloudflare source.
- [ ] Confirm `worker/worker.js` is committed and the working tree is clean.
- [ ] Run `node --check worker/worker.js`.
- [ ] Run `npm --prefix worker test`.
- [ ] Review API and stored-data compatibility.
- [ ] Copy the complete committed `worker/worker.js` into Cloudflare.
- [ ] Deploy and record the Cloudflare version or deployment identifier if available.
- [ ] Test an approved vendor login and its default plan list.
- [ ] Test an approved Hyundai login and its default plan list.
- [ ] Confirm pending, rejected, suspended, and invalid account states cannot access protected APIs.
- [ ] Record the deployment and smoke-test result in the table above.

## Emergency Cloudflare edits

If production must be edited directly in Cloudflare, copy the complete deployed source back to `worker/worker.js`, run the checks, and commit that hotfix before any other development. This prevents the next manual deployment from silently removing the emergency change.
