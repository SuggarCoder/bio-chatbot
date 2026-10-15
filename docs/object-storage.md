# SeaweedFS object storage foundation

The server uses the SeaweedFS S3 Gateway through AWS SDK for JavaScript v3.
It does not call the Master, Filer, or Volume Server APIs directly. This layer
is intentionally independent from the future Artifact schema and HTTP API.

## Provision the bucket and identity

Configure a private bucket name for each environment. Deployment runs an
idempotent initializer that creates the bucket when it is missing. Use separate
runtime and deployment identities so the long-running application does not
retain bucket-management permission. A SeaweedFS S3 identity configuration has
this shape (replace every placeholder and keep the real file outside this
repository):

```json
{
  "identities": [
    {
      "name": "bio-chatbot",
      "credentials": [
        {
          "accessKey": "replace-with-random-access-key",
          "secretKey": "replace-with-random-secret-key"
        }
      ],
      "actions": [
        "Read:bio-chatbot-artifacts-dev",
        "List:bio-chatbot-artifacts-dev",
        "Write:bio-chatbot-artifacts-dev"
      ]
    },
    {
      "name": "bio-chatbot-deployer",
      "credentials": [
        {
          "accessKey": "replace-with-admin-access-key",
          "secretKey": "replace-with-admin-secret-key"
        }
      ],
      "actions": [
        "Admin:bio-chatbot-artifacts-dev",
        "List:bio-chatbot-artifacts-dev"
      ]
    }
  ]
}
```

Start or restart the S3 Gateway with its IAM configuration enabled. Do not add
an anonymous identity for the Chatbot bucket. Configure the deployment identity
as `S3_ADMIN_ACCESS_KEY_ID` and `S3_ADMIN_SECRET_ACCESS_KEY`; those credentials
are passed only to the one-off initializer. The initializer may create the
configured bucket but never deletes buckets.

## Application configuration

For local development on the same host:

```env
OBJECT_STORAGE_ENABLED=true
S3_ENDPOINT=http://127.0.0.1:8333
S3_REGION=us-east-1
S3_BUCKET=bio-chatbot-artifacts-dev
S3_ACCESS_KEY_ID=<configured access key>
S3_SECRET_ACCESS_KEY=<configured secret key>
S3_FORCE_PATH_STYLE=true
S3_MAX_ATTEMPTS=3
```

When the Chatbot runs in a container, `127.0.0.1` points to the Chatbot
container. If the S3 Gateway is another container, attach it to
`chatbot-backend` and use its service name. If it is a process on the same
Docker host, make it listen on an address reachable from the Docker bridge and
use the host-gateway mapping supplied by `compose.yaml`:

```env
S3_ENDPOINT=http://host.docker.internal:8333
S3_ALLOW_INSECURE_HTTP=true
```

Production continues to require HTTPS by default. The HTTP opt-in is only for
a trusted same-host or private Docker-network connection; do not enable it for
an endpoint reached over an external network. Production containers reject
`localhost`, `127.0.0.1`, and `[::1]` because those addresses point back to the
Chatbot container itself.

`S3_SERVER_SIDE_ENCRYPTION=AES256` may be set only after server-side encryption
has been configured and verified on SeaweedFS.

## Verification

Initialize the configured bucket locally with the same idempotent command used
by deployment:

```bash
npm run storage:init
```

When Artifact Protocol is enabled, this verification is a production rollout
gate rather than an optional diagnostic. Do not deploy with
`ARTIFACT_PROTOCOL_ENABLED=true` unless the command succeeds and
`/ai-chatbot/api/health` reports `dependencies.objectStorage` as `ok`.

The non-mutating preflight verifies that signed bucket access works and that
an unsigned bucket listing is rejected:

```bash
npm run storage:check
```

The integration test writes one randomly prefixed object, reads it and a byte
range, and removes it in `finally`:

```bash
npm run test:storage
```

The regular test suite does not require SeaweedFS and keeps object storage
disabled by default.

## Contract for future Artifact services

- Obtain the shared `ObjectStore` instance through server dependency injection;
  never instantiate or expose `S3Client` in routes or Artifact code.
- Use opaque keys such as
  `artifacts/users/{userId}/{artifactId}/{versionId}/{fileId}`. Original file
  names and logical paths belong in PostgreSQL, not in object keys.
- Store the `sha256`, byte count, ETag, MIME type, and key returned by
  `putStream` in the future Artifact file row.
- Consume or destroy every stream returned by `getStream` so the SDK can reuse
  its HTTP connection.
- Keep lifecycle decisions in PostgreSQL. Do not enable bucket-wide automatic
  expiration for durable Artifact objects.
