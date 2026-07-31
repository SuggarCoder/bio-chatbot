# Deployment authentication

The Chatbot does not issue sessions or authenticate credentials. GPAS2 remains
the identity authority.

## Local development

Use the built-in fixed user fixture:

```env
NODE_ENV=development
GPAS2_AUTH_MODE=mock
```

In mock mode, Fastify does not require a Cookie and does not call GPAS2. The
fixture's stable `userId` is synchronized into PostgreSQL in the same way as a
real GPAS2 user. This keeps Chat, Generation, ownership, and cancellation
behavior representative during local development.

Never select a mock user through a request header, query parameter, or body.
Production startup rejects `GPAS2_AUTH_MODE=mock`.

## Production request path

Users access the application through the GPAS2 HTTPS origin:

```text
Browser
  -> https://<gpas-host>/ai-chatbot/
  -> Nginx/Gateway preserves the GPAS2 Cookie
  -> Fastify /ai-chatbot/api/*
  -> internal HTTPS GPAS2 /api/gpas2/v1/user/info
  -> PostgreSQL User upsert by externalUserId
  -> request ownership checks by internal User.id
```

Required production configuration:

```env
NODE_ENV=production
GPAS2_AUTH_MODE=upstream
GPAS2_USER_INFO_URL=https://<internal-gpas-host>/api/gpas2/v1/user/info
```

The self-hosted GitHub Actions runner reads these values from
`/home/lu/.env`. The file stays outside `GITHUB_WORKSPACE`, so checkout cleanup
cannot remove it. It must be a non-empty regular file, readable by the runner,
and inaccessible to other users. The workflow passes it to every Compose
command through `--env-file` and never prints its contents.

`GPAS2_USER_INFO_URL` must be HTTPS in production. If the internal service uses
a private CA, mount the CA certificate into the container and configure
`NODE_EXTRA_CA_CERTS`; do not disable TLS certificate verification.

Fastify forwards the incoming Cookie to `/user/info` with a ten-second timeout.
Access is granted only when the upstream HTTP request succeeds, `code` is 200,
`data.userId` is present, and `data.status` is 0.

Responses have these meanings:

| Condition | HTTP |
| --- | --- |
| Cookie missing, expired, or rejected | 401 |
| GPAS2 account status is not active | 403 |
| Identity network/timeout failure | 502 |
| Invalid upstream HTTP or JSON response | 502 |

The frontend redirects 401 responses to the same-origin `/login`. It displays
403 as an account-status error and provides retry feedback for temporary
identity-service failures.

Every protected request is checked through GPAS2, including stream connection
and reconnection. Redis `user:profile:*` data is only a realtime projection and
is never accepted as authentication.

## Reverse proxy

Use `deploy/nginx.ai-chatbot.conf.example` inside the existing GPAS2 HTTPS
server block. The public should not connect directly to port 8090.

The GPAS2 session Cookie must have a Domain matching the public GPAS2 host and a
Path of `/` or another path that includes `/ai-chatbot/`. Production cookies
must be Secure.

The proxy must preserve the Cookie and full `/ai-chatbot/*` URI. Disable proxy
buffering and use a long read timeout for SSE. No CORS configuration is needed
for the same-origin topology.

## Deployment and smoke tests

The production image contains `gpas2_chatbot_schema.sql`. Deployment applies it
with `node dist/server/applySchema.js` before replacing the running container.

`/ai-chatbot/api/health` intentionally has no authentication and therefore
cannot prove that GPAS2 authentication works. After deployment:

1. Request `/ai-chatbot/api/me` without a Cookie and expect 401.
2. Request it with a valid test Cookie and expect the synchronized user.
3. Confirm an inactive fixture/user receives 403.
4. Confirm an invalid/expired session redirects the browser to `/login`.
5. Start a Generation and verify its SSE stream and reconnection remain
   authenticated.
6. Confirm a second user cannot read or cancel the first user's Generation.
7. Inspect proxy and application logs to ensure Cookies and credentials are not
   logged.
