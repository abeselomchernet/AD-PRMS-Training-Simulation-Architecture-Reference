#!/usr/bin/env bash
set -euo pipefail

# AD-PRMS Daily Encrypted Backup & Isolated Restore Verification Drill (D-010)
# Usage:
#   DATABASE_URL=postgres://adprms_admin:pass@localhost:5432/adprms \
#   BACKUP_ENCRYPTION_PASSPHRASE=strong-secret \
#   ./backend/scripts/backup_and_restore_drill.sh

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RAW_DUMP="${BACKUP_DIR}/adprms-${TIMESTAMP}.dump"
ENC_DUMP="${RAW_DUMP}.enc"
SHA_FILE="${ENC_DUMP}.sha256"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is required." >&2
  exit 2
fi
if [ -z "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
  echo "ERROR: BACKUP_ENCRYPTION_PASSPHRASE is required." >&2
  exit 2
fi

mkdir -p "${BACKUP_DIR}"
trap 'rm -f "${RAW_DUMP}"' EXIT

echo "[1/4] Dumping PostgreSQL database in custom format..."
pg_dump --format=custom --no-owner --no-privileges --file="${RAW_DUMP}" "${DATABASE_URL}"

echo "[2/4] Encrypting snapshot with AES-256-CBC + PBKDF2..."
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "${RAW_DUMP}" -out "${ENC_DUMP}" -pass env:BACKUP_ENCRYPTION_PASSPHRASE
rm -f "${RAW_DUMP}"

echo "[3/4] Writing SHA-256 integrity manifest..."
sha256sum "${ENC_DUMP}" > "${SHA_FILE}"
sha256sum -c "${SHA_FILE}"

if [ -n "${VERIFY_RESTORE_DATABASE_URL:-}" ]; then
  echo "[4/4] Running automated restore drill into VERIFY_RESTORE_DATABASE_URL..."
  VERIFY_TMP="$(mktemp)"
  trap 'rm -f "${VERIFY_TMP}"' EXIT
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "${ENC_DUMP}" -out "${VERIFY_TMP}" -pass env:BACKUP_ENCRYPTION_PASSPHRASE
  pg_restore --clean --if-exists --no-owner --dbname="${VERIFY_RESTORE_DATABASE_URL}" "${VERIFY_TMP}"
  echo "RESTORE DRILL PASSED."
else
  echo "[4/4] Restore drill skipped (set VERIFY_RESTORE_DATABASE_URL to test live restore)."
fi

echo "Backup completed: ${ENC_DUMP}"
