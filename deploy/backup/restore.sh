#!/bin/bash
# Restores a backup made by backup.sh into the database in DATABASE_URL,
# REPLACING its contents. Stop app, app-2, worker and worker-2 first.
#
#   docker compose -p ai-chatbot stop app app-2 worker worker-2
#   docker compose -p ai-chatbot run --rm --entrypoint bash \
#     -e RESTORE_CONFIRM=<database name> db-backup \
#     /backup/restore.sh /backups/daily/chatbot-<time>.dump
#   docker compose -p ai-chatbot up -d
#
# Afterwards clear this app's Redis keys (streams, queues and caches refer to
# the replaced data): see docs/operations.md, "Restore".
set -Eeuo pipefail

dump="${1:?usage: restore.sh <dump file>}"
: "${DATABASE_URL:?DATABASE_URL is required}"
url_base="${DATABASE_URL%%\?*}"
db_name="${url_base##*/}"

if [ "${RESTORE_CONFIRM:-}" != "$db_name" ]; then
  echo "Refusing: set RESTORE_CONFIRM=$db_name to replace that database" >&2
  exit 2
fi
[ -f "$dump" ] || { echo "No such file: $dump" >&2; exit 2; }
if [ -f "$dump.sha256" ]; then
  (cd "$(dirname "$dump")" && sha256sum --check --status "$(basename "$dump").sha256") \
    || { echo "Checksum mismatch: $dump" >&2; exit 1; }
fi
pg_restore --list "$dump" >/dev/null

active="$(psql -X -At -d "$DATABASE_URL" -c "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and application_name not like 'pg_dump%'")"
if [ "$active" != 0 ] && [ "${RESTORE_FORCE:-}" != true ]; then
  echo "Refusing: $active other connections to $db_name (stop the app and workers, or set RESTORE_FORCE=true)" >&2
  exit 1
fi

echo "Restoring $dump into $db_name"
# --clean --if-exists drops each object before recreating it; one transaction,
# so a failed restore leaves the previous contents in place.
pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error \
  -d "$DATABASE_URL" "$dump"
psql -X -At -d "$DATABASE_URL" -c 'select count(*) || '"' migrations applied'"' from drizzle.__drizzle_migrations'
echo "Restore finished"
