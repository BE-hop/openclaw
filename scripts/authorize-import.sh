#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMPORT_ROOT="${ROOT_DIR}/.openclaw/workspace/authorized-imports"
LOG_FILE="${IMPORT_ROOT}/approvals.log"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  scripts/authorize-import.sh <absolute_source_path> [label]

Purpose:
  Explicitly approve one local path by copying it into OpenClaw workspace.
  OpenClaw can then read only the imported copy under:
  .openclaw/workspace/authorized-imports/
EOF
}

resolve_realpath() {
  local input="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath "${input}"
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "${input}" <<'PY'
import os
import sys

print(os.path.realpath(sys.argv[1]))
PY
    return 0
  fi
  fail "Missing realpath/python3 for canonical path resolution."
}

sanitize_label() {
  local raw="$1"
  printf '%s' "${raw}" | tr -cs 'A-Za-z0-9._-' '-' | sed -E 's/^-+//; s/-+$//'
}

[[ $# -ge 1 ]] || {
  usage
  exit 1
}

source_path="$1"
label_input="${2:-$(basename "${source_path}")}"

[[ "${source_path}" = /* ]] || fail "Source path must be absolute."
[[ -e "${source_path}" ]] || fail "Source path does not exist: ${source_path}"

resolved_source="$(resolve_realpath "${source_path}")"
case "${resolved_source}" in
  "${ROOT_DIR}" | "${ROOT_DIR}"/*)
    fail "Source already inside OpenClaw directory; no authorization import needed."
    ;;
esac

safe_label="$(sanitize_label "${label_input}")"
[[ -n "${safe_label}" ]] || safe_label="authorized"
stamp="$(date '+%Y%m%d-%H%M%S')"
destination="${IMPORT_ROOT}/${stamp}-${safe_label}"

mkdir -p "${IMPORT_ROOT}"
cp -R "${resolved_source}" "${destination}"

{
  printf '%s\t%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "${resolved_source}" "${destination}"
} >> "${LOG_FILE}"

echo "Approved import completed:"
echo "- source: ${resolved_source}"
echo "- imported copy: ${destination}"
echo "- audit log: ${LOG_FILE}"
