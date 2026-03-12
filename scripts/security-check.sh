#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
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

read_env_var() {
  local key="$1"
  local value
  value="$(awk -F= -v k="${key}" '$1 == k {print substr($0, index($0, "=") + 1)}' "${ENV_FILE}" | tail -n 1)"
  echo "${value}"
}

check_container_security() {
  local service="$1"
  local cid="$2"
  local read_only
  local cap_drop
  local nnp

  read_only="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "${cid}")"
  [[ "${read_only}" == "true" ]] || fail "${service}: read_only root filesystem is not enabled."

  cap_drop="$(docker inspect -f '{{json .HostConfig.CapDrop}}' "${cid}")"
  [[ "${cap_drop}" == *"ALL"* ]] || fail "${service}: expected cap_drop ALL."

  nnp="$(docker inspect -f '{{json .HostConfig.SecurityOpt}}' "${cid}")"
  [[ "${nnp}" == *"no-new-privileges:true"* ]] || fail "${service}: missing no-new-privileges."
}

check_bind_sources() {
  local cid="$1"
  local source

  while IFS= read -r source; do
    [[ -z "${source}" ]] && continue
    case "${source}" in
      "${ROOT_DIR}" | "${ROOT_DIR}"/*) ;;
      *) fail "Host bind mount escapes repository: ${source}" ;;
    esac
  done < <(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}' "${cid}")
}

check_loopback_ports() {
  local cid="$1"
  local host_ip_18789
  local host_ip_18790

  host_ip_18789="$(docker inspect -f '{{(index (index .NetworkSettings.Ports "18789/tcp") 0).HostIp}}' "${cid}")"
  host_ip_18790="$(docker inspect -f '{{(index (index .NetworkSettings.Ports "18790/tcp") 0).HostIp}}' "${cid}")"

  [[ "${host_ip_18789}" == "127.0.0.1" ]] || fail "Port 18789 is not bound to loopback."
  [[ "${host_ip_18790}" == "127.0.0.1" ]] || fail "Port 18790 is not bound to loopback."
}

check_no_docker_sock() {
  local cid="$1"
  local sock_mount
  sock_mount="$(docker inspect -f '{{range .Mounts}}{{if and (eq .Type "bind") (eq .Source "/var/run/docker.sock")}}{{println .Source}}{{end}}{{end}}' "${cid}")"
  [[ -z "${sock_mount}" ]] || fail "docker.sock is mounted; this breaks isolation."
}

check_runtime_policy() {
  local config_file="$1"
  [[ -f "${config_file}" ]] || fail "Missing config file: ${config_file}"
  require_cmd python3

  python3 - "${config_file}" <<'PY'
import json
import sys

cfg_path = sys.argv[1]
with open(cfg_path, "r", encoding="utf-8") as handle:
    cfg = json.load(handle)

tools = cfg.get("tools") or {}
errors = []

fs = tools.get("fs") or {}
if fs.get("workspaceOnly") is not True:
    errors.append("tools.fs.workspaceOnly must be true.")

elevated = tools.get("elevated") or {}
if elevated.get("enabled") is not False:
    errors.append("tools.elevated.enabled must be false.")

exec_cfg = tools.get("exec") or {}
if exec_cfg.get("security") != "deny":
    errors.append('tools.exec.security must be "deny".')

allow = tools.get("allow") or []
allow_set = {item for item in allow if isinstance(item, str)}
required_allow = {"web_search", "web_fetch", "write", "session_status"}
if not required_allow.issubset(allow_set):
    errors.append(
        "tools.allow must include web_search, web_fetch, write, and session_status."
    )
if "read" in allow_set or "edit" in allow_set:
    errors.append("tools.allow must not include read/edit in secure mode.")

if errors:
    for item in errors:
        print(item)
    raise SystemExit(1)
PY
}

require_cmd docker
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
[[ -f "${ENV_FILE}" ]] || fail "Missing ${ENV_FILE}. Run scripts/deploy-secure-local.sh first."

config_dir="$(read_env_var "OPENCLAW_CONFIG_DIR")"
if [[ -z "${config_dir}" ]]; then
  config_dir="${ROOT_DIR}/.openclaw"
fi
config_file="${config_dir}/openclaw.json"

gateway_cid="$(docker compose "${COMPOSE_ARGS[@]}" ps -q openclaw-gateway)"
cli_cid="$(docker compose "${COMPOSE_ARGS[@]}" ps -a -q openclaw-cli)"
cleanup_cli=0

[[ -n "${gateway_cid}" ]] || fail "openclaw-gateway container not found. Start deployment first."
if [[ -z "${cli_cid}" ]]; then
  docker compose "${COMPOSE_ARGS[@]}" create openclaw-cli >/dev/null
  cli_cid="$(docker compose "${COMPOSE_ARGS[@]}" ps -a -q openclaw-cli)"
  cleanup_cli=1
fi
[[ -n "${cli_cid}" ]] || fail "openclaw-cli container could not be created for inspection."

check_container_security "openclaw-gateway" "${gateway_cid}"
check_container_security "openclaw-cli" "${cli_cid}"
check_bind_sources "${gateway_cid}"
check_bind_sources "${cli_cid}"
check_loopback_ports "${gateway_cid}"
check_no_docker_sock "${gateway_cid}"
check_runtime_policy "${config_file}"

if [[ "${cleanup_cli}" == "1" ]]; then
  docker compose "${COMPOSE_ARGS[@]}" rm -fsv openclaw-cli >/dev/null
fi

echo "Running OpenClaw security audit..."
docker compose "${COMPOSE_ARGS[@]}" run --rm -T openclaw-cli security audit --deep

echo
echo "Security checks passed:"
echo "- Containers use read-only rootfs, cap_drop=ALL, and no-new-privileges"
echo "- Host binds stay under ${ROOT_DIR}"
echo "- Gateway ports are loopback-only"
echo "- docker.sock is not mounted"
echo "- Runtime policy enforces workspace-only fs and denies elevated/exec"
