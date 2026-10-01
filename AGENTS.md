# OverTime Development Instructions

OverTime is an existing production application.

## Architecture
- Frontend: index.html
- Backend/API: Cloudflare Worker under worker/
- Authentication: Google Login
- Deployment: GitHub + Cloudflare

## Production Safety

Always preserve:
- existing stored data
- existing API compatibility
- Google Login
- existing production behavior

Before changing an API:
- inspect both frontend and worker implementation
- identify existing consumers
- prefer backward-compatible changes

Do not:
- hardcode secrets
- migrate stored data without explicit instruction
- perform broad refactors unless explicitly requested
- remove existing API fields without checking compatibility

When modifying code:
1. inspect related files first
2. explain impact
3. make the smallest necessary change
4. test
5. summarize the diff
