# Dashboard Basic Auth Design

## Overview

Add token-based authentication to the AIGate dashboard. Configured via `ADMIN_TOKEN` environment variable. When not set, the server refuses to start and displays a configuration hint.

## Architecture

```
ADMIN_TOKEN not set → server exits with error message
ADMIN_TOKEN set     → all /api/* routes require Bearer token
                    → frontend shows login page if no valid token
```

## Backend (Gateway)

1. **Startup check**: `index.ts` checks `ADMIN_TOKEN` env var, exits with error if not set
2. **Middleware** `adminAuth`: validates `Authorization: Bearer <ADMIN_TOKEN>` on `/api/*`, returns 401 on failure
3. **Verify endpoint** `POST /api/auth/verify`: frontend uses this to validate stored token, returns 200 or 401
4. **Static assets**: not protected (login page must load)

## Frontend (Dashboard)

1. **AuthGuard component**: wraps App, checks localStorage for token
   - Has token → calls `/api/auth/verify`
   - No token or verify fails → shows Login page
2. **Login page**: full-screen dark background, centered card with token input + submit button, matches DESIGN.md aesthetic
3. **API layer**: `api.ts` fetch adds `Authorization: Bearer <token>` header, clears localStorage on 401

## Docker

```dockerfile
ENV ADMIN_TOKEN=""
```

Usage: `docker run -e ADMIN_TOKEN=your-secret ...`

## File Changes

| File | Change |
|------|--------|
| `packages/gateway/src/index.ts` | Startup check + adminAuth middleware |
| `packages/gateway/src/middleware/admin-auth.ts` | New: token validation middleware |
| `packages/gateway/src/api/auth.ts` | New: `/api/auth/verify` endpoint |
| `packages/dashboard/src/App.tsx` | Wrap with AuthGuard |
| `packages/dashboard/src/components/AuthGuard.tsx` | New: auth guard logic |
| `packages/dashboard/src/pages/Login.tsx` | New: login page |
| `packages/dashboard/src/lib/api.ts` | Add auth header, 401 handling |
| `Dockerfile` | Add `ADMIN_TOKEN` env var |
