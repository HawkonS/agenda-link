#!/usr/bin/env bash
# ============================================================
# agenda-link 一键启动脚本
#
# 默认构建并启动 API 与生产静态服务。
# 传入 --dev 后启动 NestJS watch 和 Vite 开发服务器。
# ============================================================
set -Eeuo pipefail
umask 077

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${AGENDA_LINK_WORKSPACE:-$CODE_DIR}"
export AGENDA_LINK_WORKSPACE="$ROOT_DIR"
cd "$CODE_DIR"

RUNTIME_DIR="$ROOT_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/pids"
LOG_DIR="$RUNTIME_DIR/logs"
CONFIG_FILE="$ROOT_DIR/agenda-link.properties"
DEFAULT_API_PORT=18480
DEFAULT_WEB_PORT=15173
MODE="production"
SKIP_BUILD=false

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { printf '%b\n' "${GREEN}[agenda-link]${NC} $*"; }
log_warn() { printf '%b\n' "${YELLOW}[agenda-link]${NC} $*"; }
log_error() { printf '%b\n' "${RED}[agenda-link]${NC} $*" >&2; }

read_property() {
  local key="$1" fallback="$2" value=""
  if [ -f "$CONFIG_FILE" ]; then
    value="$(awk -v key="$key" '
      $0 !~ /^[[:space:]]*[#;]/ && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
        sub(/^[^=]*=[[:space:]]*/, "")
        print
        exit
      }
    ' "$CONFIG_FILE" 2>/dev/null || true)"
  fi
  if [ -n "$value" ]; then printf '%s\n' "$value"; else printf '%s\n' "$fallback"; fi
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

for arg in "$@"; do
  case "$arg" in
    --dev) MODE="development" ;;
    --no-build) SKIP_BUILD=true ;;
    --help|-h)
      cat <<'EOF'
用法: ./run.sh [--dev|--no-build]

  默认       构建并启动生产服务
  --dev      启动 NestJS watch 和 Vite 开发服务器
  --no-build 使用已构建的生产产物
EOF
      exit 0
      ;;
    *) log_error "未知参数: $arg"; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  log_error "未找到 Node.js，请安装 Node.js 22.12 或更高版本。"
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  log_error "未找到 npm。"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||major===22&&minor>=12?0:1)'; then
  log_error "Node.js 版本过低: $(node --version)，需要 22.12 或更高版本。"
  exit 1
fi

mkdir -p "$RUNTIME_DIR"

if [ ! -x "$CODE_DIR/node_modules/.bin/tsx" ]; then
  log_info "正在安装依赖..."
  npm ci --include=dev
fi
LAUNCH_CONFIG="$(node "$CODE_DIR/node_modules/tsx/dist/cli.mjs" "$CODE_DIR/tools/configure.ts")"
LOG_DIR="$(LAUNCH_CONFIG="$LAUNCH_CONFIG" node -e 'console.log(JSON.parse(process.env.LAUNCH_CONFIG).logDir)')"
mkdir -p "$LOG_DIR"

API_PORT="$(LAUNCH_CONFIG="$LAUNCH_CONFIG" node -e 'console.log(JSON.parse(process.env.LAUNCH_CONFIG).apiPort)')"
WEB_PORT="$(LAUNCH_CONFIG="$LAUNCH_CONFIG" node -e 'console.log(JSON.parse(process.env.LAUNCH_CONFIG).webPort)')"
if ! valid_port "$API_PORT"; then
  log_error "配置中的 app.port 无效: ${API_PORT}（应为 1-65535 的端口号）。"
  exit 1
fi
if ! valid_port "$WEB_PORT"; then
  log_error "配置中的 web.port 无效: ${WEB_PORT}（应为 1-65535 的端口号）。"
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  supervisor_pid="$(awk -F= '$1 == "supervisor" {print $2}' "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$supervisor_pid" ] && kill -0 "$supervisor_pid" 2>/dev/null; then
    log_error "agenda-link 已经运行中 (PID: $supervisor_pid)。"
    exit 1
  fi
  rm -f "$PID_FILE"
fi

if [ ! -x "$CODE_DIR/node_modules/.bin/tsc" ] \
  || [ ! -x "$CODE_DIR/node_modules/.bin/vite" ]; then
  log_info "未找到依赖，正在执行 npm ci..."
  npm ci --include=dev
fi

if ! node -e 'require("better-sqlite3")' >/dev/null 2>&1; then
  log_error "当前 Node.js 无法加载 better-sqlite3（原生模块与 Node 版本不匹配）。"
  log_error "请使用启动服务时的 Node 版本，或执行: npm rebuild better-sqlite3"
  exit 1
fi

if [ "$MODE" = "production" ]; then
  if [ "$SKIP_BUILD" = false ]; then log_info "正在构建生产产物..."; npm run build; fi
  [ -f "$CODE_DIR/apps/server/dist/main.js" ] && [ -f "$CODE_DIR/apps/web/dist/index.html" ] || { log_error "缺少生产产物，请先 npm run build"; exit 1; }
  server_command=(node "$CODE_DIR/apps/server/dist/main.js")
  web_command=(node "$CODE_DIR/tools/web-server.mjs")
else
  server_command=(node "$CODE_DIR/node_modules/tsx/dist/cli.mjs" watch --tsconfig "$CODE_DIR/apps/server/tsconfig.json" "$CODE_DIR/apps/server/src/main.ts")
  web_command=(node "$CODE_DIR/node_modules/vite/bin/vite.js" "$CODE_DIR/apps/web" --host 0.0.0.0 --port "$WEB_PORT" --strictPort)
fi

server_pid=""
web_pid=""
stopping="false"

write_pid_file() {
  cat > "$PID_FILE" <<EOF
supervisor=$$
server=${server_pid:-}
web=${web_pid:-}
mode=$MODE
EOF
}

is_running() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

stop_child() {
  local pid="${1:-}"
  [ -z "$pid" ] || ! is_running "$pid" && return 0
  kill -TERM "$pid" 2>/dev/null || true
}

wait_child() {
  local pid="${1:-}" i
  [ -z "$pid" ] && return 0
  for i in 1 2 3 4 5 6 7 8 9 10; do
    is_running "$pid" || return 0
    sleep 1
  done
  if is_running "$pid"; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  [ "$stopping" = "true" ] && return 0
  stopping="true"
  stop_child "$server_pid"
  stop_child "$web_pid"
  wait_child "$server_pid"
  wait_child "$web_pid"
  rm -f "$PID_FILE"
}

on_signal() {
  cleanup
  exit 0
}

trap cleanup EXIT
trap on_signal INT TERM HUP

log_info "启动模式: $MODE"
log_info "日志目录: $LOG_DIR"

(exec "${server_command[@]}" >> "$LOG_DIR/server.log" 2>&1) &
server_pid=$!
(exec "${web_command[@]}" >> "$LOG_DIR/web.log" 2>&1) &
web_pid=$!
write_pid_file

sleep 2
if ! is_running "$server_pid"; then
  log_error "API 服务启动失败，请查看 $LOG_DIR/server.log"
  exit 1
fi
if ! is_running "$web_pid"; then
  log_error "前端服务启动失败，请查看 $LOG_DIR/web.log"
  exit 1
fi

log_info "API: http://127.0.0.1:$API_PORT"
log_info "Web: http://127.0.0.1:$WEB_PORT"
if [ -f "$RUNTIME_DIR/initial-admin-password" ]; then
  log_info "管理员初始密码已生成，请读取: $RUNTIME_DIR/initial-admin-password"
fi
log_info "按 Ctrl+C 停止服务。"

while true; do
  if ! is_running "$server_pid" || ! is_running "$web_pid"; then
    log_error "子服务异常退出，请查看 ${LOG_DIR}。"
    exit 1
  fi
  sleep 2
done
