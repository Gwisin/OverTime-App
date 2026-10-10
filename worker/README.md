# OverTime Cloudflare Worker

`worker.js` is the single source of truth for the production Cloudflare Worker. Do not create a new active source file for each release. Git commits and tags retain previous versions; `CHANGELOG.md` records release notes, and `DEPLOYMENTS.md` records what was actually copied to Cloudflare.

## Runtime data

The Worker uses a GitHub repository as its runtime data store:

- `users.json`: user profile, organization, approval status, and signature path
- `data/index.json`: plan summaries used by list requests
- `data/plans/{id}.json`: complete plan records
- `signatures/{email}.png`: current user signature images

Prefer a private data repository separate from this application source repository. Do not commit production data or secrets to this repository.

## Cloudflare configuration

Configure these values in Cloudflare rather than in source code:

- `GITHUB_TOKEN`: fine-grained token with only the required data-repository permissions
- `GITHUB_OWNER`: data-repository owner
- `GITHUB_REPO`: data-repository name
- `GITHUB_BRANCH`: data branch; defaults to `main`
- `GOOGLE_CLIENT_ID`: Google OAuth client ID used by the frontend
- `ALLOWED_ORIGIN`: required comma-separated list of deployed frontend origins; browser requests fail closed when omitted
- `ADMIN_EMAILS`: comma-separated administrator email addresses

The production Worker only accepts Google ID tokens. It verifies RS256 signatures using Web Crypto and Google's rotating public keys from `https://www.googleapis.com/oauth2/v3/certs`. Only public keys are cached (following the response max-age); tokens and account status are not cached. The existing `GOOGLE_CLIENT_ID` configuration and email-keyed user records are retained. No new secrets, packages, build step, or data migration are needed. Remove any legacy `TEST_LOGIN_SECRET` setting from Cloudflare before deployment.

## Local checks

Run from the repository root:

```bash
node --check worker/worker.js
npm --prefix worker test
```

## Manual deployment rule

1. Make and review changes in `worker/worker.js`; do not edit the Cloudflare copy independently.
2. Run the local checks and commit the exact source to be deployed.
3. Copy the complete committed `worker/worker.js` into the Cloudflare editor and deploy it.
4. Perform login and API smoke tests.
5. Add the deployed commit, version, date, and result to `DEPLOYMENTS.md`.
6. If an emergency edit is made in Cloudflare, copy the complete deployed source back into `worker/worker.js`, test it, and commit it before starting other work.
