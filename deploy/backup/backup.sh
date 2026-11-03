#!/bin/bash
# Nightly logical backup of the chatbot database, run by the db-backup
# service (compose.yaml). Uses the pg_dump that matches the server (pg17).
#
#   /backups/daily/chatbot-<UTC time>.dump     custom format, kept BACKUP_RETENTION_DAYS
#   /backups/weekly/...                        Sunday copies, kept BACKUP_WEEKLY_RETENTION_WEEKS
#   $TEXTFILE_DIR/chatbot_backup.prom          metrics for node-exporter's textfile collector
#
# A weekly restore check (BACKUP_VERIFY_RESTORE=true) restores the newest
# dump into a scratch database "<db>_restore_check" and drops it again; the
# database user needs CREATEDB (and must be able to create the vector
# extension) for it.
#
# Run once by hand:  docker compose -p ai-chatbot exec db-backup bash /backup/backup.sh now
set -Euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_HOUR_UTC="${BACKUP_HOUR_UTC:-18}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_WEEKLY_RETENTION_WEEKS="${BACKUP_WEEKLY_RETENTION_WEEKS:-8}"
BACKUP_VERIFY_RESTORE="${BACKUP_VERIFY_RESTORE:-true}"
TEXTFILE_DIR="${TEXTFILE_DIR:-/textfile}"
ROOT="${BACKUP_ROOT:-/backups}"
DAILY="$ROOT/daily"
WEEKLY="$ROOT/weekly"
STATE="$ROOT/.state"
mkdir -p "$DAILY" "$WEEKLY" "$STATE"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# postgres://user:pass@host:port/db?params -> pieces, to address other databases.
url_base="${DATABASE_URL%%\?*}"
url_query="${DATABASE_URL#"$url_base"}"
db_name="${url_base##*/}"
url_prefix="${url_base%/*}"
scratch_db="${db_name}_restore_check"
scratch_url="${url_prefix}/${scratch_db}${url_query}"
admin_url="${url_prefix}/postgres${url_query}"

state() { cat "$STATE/$1" 2>/dev/null || echo 0; }

write_metrics() {
  [ -d "$TEXTFILE_DIR" ] || return 0
  local tmp="$TEXTFILE_DIR/.chatbot_backup.prom.$$"
  cat >"$tmp" <<EOF
# HELP chatbot_backup_last_success_timestamp_seconds Time of the last successful database backup.
# TYPE chatbot_backup_last_success_timestamp_seconds gauge
chatbot_backup_last_success_timestamp_seconds $(state last_success)
# HELP chatbot_backup_last_size_bytes Size of the last successful backup.
# TYPE chatbot_backup_last_size_bytes gauge
chatbot_backup_last_size_bytes $(state last_size)
# HELP chatbot_backup_last_duration_seconds Duration of the last successful backup.
# TYPE chatbot_backup_last_duration_seconds gauge
chatbot_backup_last_duration_seconds $(state last_duration)
# HELP chatbot_backup_last_run_failed 1 when the most recent backup attempt failed.
# TYPE chatbot_backup_last_run_failed gauge
chatbot_backup_last_run_failed $(state last_failed)
# HELP chatbot_backup_restore_verify_last_success_timestamp_seconds Time of the last successful restore check.
# TYPE chatbot_backup_restore_verify_last_success_timestamp_seconds gauge
chatbot_backup_restore_verify_last_success_timestamp_seconds $(state last_verify)
EOF
  chmod 644 "$tmp"
  mv -f "$tmp" "$TEXTFILE_DIR/chatbot_backup.prom"
}

verify_restore() {
  local dump="$1"
  log "Restore check: restoring $(basename "$dump") into $scratch_db"
  psql -X -q -v ON_ERROR_STOP=1 -d "$admin_url" -c "drop database if exists \"$scratch_db\" with (force)" &&
    psql -X -q -v ON_ERROR_STOP=1 -d "$admin_url" -c "create database \"$scratch_db\"" || return 1
  local ok=0
  if pg_restore --no-owner --no-privileges --exit-on-error -d "$scratch_url" "$dump"; then
    local tables migrations
    tables="$(psql -X -At -d "$scratch_url" -c "select count(*) from pg_tables where schemaname = 'public'")"
    migrations="$(psql -X -At -d "$scratch_url" -c 'select count(*) from drizzle.__drizzle_migrations' 2>/dev/null || echo 0)"
    users="$(psql -X -At -d "$scratch_url" -c 'select count(*) from "User"' 2>/dev/null || echo -1)"
    log "Restore check: $tables tables, $migrations migrations, $users users"
    if [ "${tables:-0}" -ge 10 ] && [ "${migrations:-0}" -ge 1 ] && [ "${users:--1}" -ge 0 ]; then ok=1; fi
  fi
  psql -X -q -d "$admin_url" -c "drop database if exists \"$scratch_db\" with (force)" || true
  [ "$ok" = 1 ]
}

run_backup() {
  local started name partial final size
  started="$(date +%s)"
  name="chatbot-$(date -u +%Y%m%dT%H%M%SZ).dump"
  partial="$DAILY/.$name.partial"
  final="$DAILY/$name"
  log "Backup starting: $name"
  if ! pg_dump --format=custom --compress=6 --no-owner --no-privileges -d "$DATABASE_URL" -f "$partial"; then
    log "Backup FAILED: pg_dump"
    rm -f "$partial"
    return 1
  fi
  # The archive must be readable end to end before it replaces anything.
  if ! pg_restore --list "$partial" >/dev/null; then
    log "Backup FAILED: archive is unreadable"
    rm -f "$partial"
    return 1
  fi
  mv "$partial" "$final"
  sha256sum "$final" >"$final.sha256"
  size="$(stat -c %s "$final")"
  if [ "$(date -u +%u)" = 7 ]; then
    cp -l "$final" "$WEEKLY/$name" 2>/dev/null || cp "$final" "$WEEKLY/$name"
    cp "$final.sha256" "$WEEKLY/$name.sha256"
  fi
  find "$DAILY" -maxdepth 1 -name 'chatbot-*.dump*' -mtime +"$BACKUP_RETENTION_DAYS" -delete
  find "$WEEKLY" -maxdepth 1 -name 'chatbot-*.dump*' -mtime +"$((BACKUP_WEEKLY_RETENTION_WEEKS * 7))" -delete
  find "$DAILY" -maxdepth 1 -name '.*.partial' -mmin +360 -delete

  echo "$(date +%s)" >"$STATE/last_success"
  echo "$size" >"$STATE/last_size"
  echo "$(( $(date +%s) - started ))" >"$STATE/last_duration"
  echo 0 >"$STATE/last_failed"
  log "Backup done: $name ($size bytes)"

  if [ "$BACKUP_VERIFY_RESTORE" = true ] && [ $(( $(date +%s) - $(state last_verify) )) -ge $(( 6 * 86400 )) ]; then
    if verify_restore "$final"; then
      echo "$(date +%s)" >"$STATE/last_verify"
      log "Restore check passed"
    else
      log "Restore check FAILED (backup itself is kept)"
    fi
  fi
}

attempt() {
  if run_backup; then :; else echo 1 >"$STATE/last_failed"; fi
  write_metrics
}

if [ "${1:-}" = now ]; then
  attempt
  exit 0
fi

write_metrics
log "db-backup ready: daily at ${BACKUP_HOUR_UTC}:00 UTC, keep ${BACKUP_RETENTION_DAYS} days + ${BACKUP_WEEKLY_RETENTION_WEEKS} weeks"
while true; do
  now="$(date +%s)"
  age=$(( now - $(state last_success) ))
  # The scheduled hour, or catch up when the last good backup is over 26 h
  # old (first start, a missed night, a failed run retried hourly).
  if { [ "$(date -u +%H)" = "$(printf '%02d' "$BACKUP_HOUR_UTC")" ] && [ "$age" -ge 3600 ]; } || [ "$age" -ge 93600 ]; then
    if [ $(( now - $(state last_attempt) )) -ge 3600 ]; then
      echo "$now" >"$STATE/last_attempt"
      attempt
    fi
  fi
  sleep 300
done
