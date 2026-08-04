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
TRUSTED_PROXY_CIDRS=<direct-proxy-ip-or-cidr>
```

The self-hosted GitHub Actions runner reads these values from
`/home/lu/.env`. The file stays outside `GITHUB_WORKSPACE`, so checkout cleanup
cannot remove it. It must be a non-empty regular file, readable by the runner,
and inaccessible to other users. The workflow passes it to every Compose
command through `--env-file` and never prints its contents.

`GPAS2_USER_INFO_URL` must be HTTPS in production. If the internal service uses
a private CA, mount the CA certificate into the container and configure
`NODE_EXTRA_CA_CERTS`; do not disable TLS certificate verification.

For an isolated test deployment only, `NODE_TLS_REJECT_UNAUTHORIZED=0` may be
set in the external deployment environment file. The Compose service explicitly
passes this value to Node.js. This disables certificate verification for every
HTTPS request made by the process, including GPAS2, model providers, MCP, and
tool requests, so it must remain `1` in production.

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
and reconnection. Redis is never accepted as authentication.

## Reverse proxy

Use `deploy/nginx.ai-chatbot.conf.example` inside the existing GPAS2 HTTPS
server block. The public should not connect directly to port 8090.

The GPAS2 session Cookie must have a Domain matching the public GPAS2 host and a
Path of `/` or another path that includes `/ai-chatbot/`. Production cookies
must be Secure.

The proxy must preserve the Cookie and full `/ai-chatbot/*` URI. Disable proxy
buffering and use a long read timeout for SSE. No CORS configuration is needed
for the same-origin topology.

Production startup rejects an empty `TRUSTED_PROXY_CIDRS`. Configure only the
IP address or narrow CIDR of the proxy that connects directly to Fastify. For
the single Nginx hop shown in `deploy/nginx.ai-chatbot.conf.example`, overwrite
client-supplied forwarding information with:

```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
```

Do not use `true`, `0.0.0.0/0`, `::/0`, or a broad container network. Fastify
must not be reachable publicly around the trusted proxy.

## Deployment and smoke tests

The production image contains the committed `drizzle/` migrations. Deployment
applies them with `node dist/server/migrate.js` before replacing the running
container.

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
