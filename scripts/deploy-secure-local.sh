#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-${ROOT_DIR}/.openclaw}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-${ROOT_DIR}/.openclaw/workspace}"
COMPOSE_ARGS=(
  --env-file "${ENV_FILE}"
  -f "${ROOT_DIR}/docker-compose.yml"
  -f "${ROOT_DIR}/docker-compose.secure.yml"
)

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing dependency: $1"
  fi
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
    return 0
  fi
  fail "Cannot generate token: install openssl or python3."
}

write_default_env() {
  local token
  token="$(generate_token)"
  cat >"${ENV_FILE}" <<EOF
# OpenClaw local Docker profile (locked to this repository path)
OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest
OPENCLAW_GATEWAY_TOKEN=${token}
OPENCLAW_CONFIG_DIR=${ROOT_DIR}/.openclaw
OPENCLAW_WORKSPACE_DIR=${ROOT_DIR}/.openclaw/workspace
OPENCLAW_GATEWAY_PORT=127.0.0.1:28889
OPENCLAW_BRIDGE_PORT=127.0.0.1:28890
OPENCLAW_GATEWAY_BIND=lan
EOF
  chmod 600 "${ENV_FILE}" || true
  echo "Wrote ${ENV_FILE}"
}

host_port_from_binding() {
  local binding="$1"
  if [[ "${binding}" == *:* ]]; then
    echo "${binding##*:}"
    return 0
  fi
  echo "${binding}"
}

require_cmd docker
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."

mkdir -p "${CONFIG_DIR}" "${WORKSPACE_DIR}"
chmod 700 "${CONFIG_DIR}" "${WORKSPACE_DIR}" || true

if [[ ! -f "${ENV_FILE}" ]]; then
  write_default_env
fi

echo "Using env file: ${ENV_FILE}"
echo "Config dir: ${CONFIG_DIR}"
echo "Workspace dir: ${WORKSPACE_DIR}"
echo
echo "1) Pull image"
docker compose "${COMPOSE_ARGS[@]}" pull openclaw-gateway openclaw-cli
echo
echo "2) Onboard (interactive)"
docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli onboard
echo
gateway_binding="${OPENCLAW_GATEWAY_PORT:-127.0.0.1:28889}"
gateway_host_port="$(host_port_from_binding "${gateway_binding}")"
control_ui_origins="[\"http://localhost:${gateway_host_port}\",\"http://127.0.0.1:${gateway_host_port}\"]"

echo "3) Apply secure runtime policy"
docker compose "${COMPOSE_ARGS[@]}" run --rm -T openclaw-cli config set tools.allow '["web_search","web_fetch","write","session_status"]'
docker compose "${COMPOSE_ARGS[@]}" run --rm -T openclaw-cli config set tools.deny '["group:runtime","group:automation","group:ui","group:nodes","read","edit","apply_patch","sessions_spawn","sessions_send"]'
docker compose "${COMPOSE_ARGS[@]}" run --rm -T openclaw-cli config set tools.fs.workspaceOnly true
docker compose "${COMPOSE_ARGS[@]}" run --rm -T openclaw-cli config set tools.exec.security deny
docker compose "${COMPOSE_ARGS[@]}" run --rm -T openclaw-cli config set tools.exec.ask always
docker compose "${COMPOSE_ARGS[@]}" run --rm -T openclaw-cli config set tools.elevated.enabled false
docker compose "${COMPOSE_ARGS[@]}" run --rm -T openclaw-cli config set tools.web.search.enabled true
docker compose "${COMPOSE_ARGS[@]}" run --rm -T openclaw-cli config set tools.web.fetch.enabled true
docker compose "${COMPOSE_ARGS[@]}" run --rm -T openclaw-cli config set gateway.auth.mode token
docker compose "${COMPOSE_ARGS[@]}" run --rm -T openclaw-cli config set gateway.controlUi.allowedOrigins "${control_ui_origins}"
echo
echo "4) Start gateway"
docker compose "${COMPOSE_ARGS[@]}" up -d openclaw-gateway
echo
echo "Open dashboard: http://127.0.0.1:${gateway_host_port}/"
echo "Need token URL again?"
echo "docker compose ${COMPOSE_ARGS[*]} run --rm openclaw-cli dashboard --no-open"
