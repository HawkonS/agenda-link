#!/usr/bin/env bash
# ============================================================
# agenda-link systemd 服务管理
#
# 用法:
#   ./tools/manage_service.sh install
#   ./tools/manage_service.sh {start|stop|restart|status|logs}
#   ./tools/manage_service.sh {enable|disable|upgrade|uninstall}
# ============================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SCRIPT="$PROJECT_ROOT/run.sh"
STOP_SCRIPT="$PROJECT_ROOT/stop.sh"
SERVICE_NAME="agenda-link.service"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"
REPOSITORY_URL="https://github.com/HawkonS/agenda-link.git"
REPOSITORY_BRANCH="main"
SERVICE_USER="${AGENDA_LINK_SERVICE_USER:-${SUDO_USER:-${USER:-$(id -un)}}}"
DATA_DIR=""
LOG_DIR=""

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { printf '%b\n' "${GREEN}[agenda-link]${NC} $*"; }
warn() { printf '%b\n' "${YELLOW}[agenda-link]${NC} $*"; }
error() { printf '%b\n' "${RED}[agenda-link]${NC} $*" >&2; }

run_sudo() {
  if [ "${EUID:-$(id -u)}" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

require_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    error "未找到 systemctl；该脚本只支持 Linux systemd。"
    exit 1
  fi
}

require_files() {
  [ -x "$RUN_SCRIPT" ] || { error "启动脚本不存在或不可执行: $RUN_SCRIPT"; exit 1; }
  [ -x "$STOP_SCRIPT" ] || { error "停止脚本不存在或不可执行: $STOP_SCRIPT"; exit 1; }
}

service_unit() {
  cat <<EOF
[Unit]
Description=agenda-link meeting, calendar and directory connector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_ROOT
ExecStart=/bin/bash "$RUN_SCRIPT" --no-build
ExecStop=/bin/bash "$STOP_SCRIPT"
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=30
Environment=NODE_ENV=production
Environment="PATH=$PATH"
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths="$PROJECT_ROOT" "$DATA_DIR" "$LOG_DIR"
ReadOnlyPaths="$PROJECT_ROOT/apps" "$PROJECT_ROOT/tools" "$PROJECT_ROOT/node_modules" "$RUN_SCRIPT" "$STOP_SCRIPT"
ReadOnlyPaths="-$PROJECT_ROOT/.git" "-$PROJECT_ROOT/package.json" "-$PROJECT_ROOT/package-lock.json"
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=
TasksMax=128
LimitNOFILE=8192
MemoryMax=1G

[Install]
WantedBy=multi-user.target
EOF
}

prepare_permissions() {
  if [ -z "${AGENDA_LINK_SERVICE_USER:-}" ] && [ -f "$SERVICE_FILE" ]; then
    local installed_user
    installed_user="$(systemctl show "$SERVICE_NAME" --property=User --value)"
    if [ -n "$installed_user" ]; then SERVICE_USER="$installed_user"; fi
  fi
  id "$SERVICE_USER" >/dev/null 2>&1 || { error "服务用户不存在: $SERVICE_USER"; exit 1; }
  (cd "$PROJECT_ROOT" && node node_modules/tsx/dist/cli.mjs tools/configure.ts >/dev/null)
  DATA_DIR="$(cd "$PROJECT_ROOT" && node --input-type=module -e "import path from 'node:path';import {root,configuration} from './tools/config.mjs';console.log(path.resolve(root,configuration()['storage.data-dir']))")"
  LOG_DIR="$(cd "$PROJECT_ROOT" && node --input-type=module -e "import path from 'node:path';import {root,configuration} from './tools/config.mjs';console.log(path.resolve(root,configuration()['logging.dir']))")"
  # Never recursively change ownership of an arbitrary configured directory.
  for directory in "$DATA_DIR" "$LOG_DIR"; do
    case "$directory" in "$PROJECT_ROOT"/*) ;; *) error "服务数据和日志目录必须位于项目内，请迁移目录后安装。"; exit 1 ;; esac
    [ ! -L "$directory" ] || { error "数据和日志目录不能是符号链接。"; exit 1; }
  done
  run_sudo chown "$SERVICE_USER" "$PROJECT_ROOT" "$PROJECT_ROOT/agenda-link.properties"
  run_sudo chmod 600 "$PROJECT_ROOT/agenda-link.properties"
  run_sudo chmod 755 "$PROJECT_ROOT" "$PROJECT_ROOT/apps" "$PROJECT_ROOT/apps/server" "$PROJECT_ROOT/apps/web" "$PROJECT_ROOT/tools" "$PROJECT_ROOT/node_modules"
  run_sudo find "$PROJECT_ROOT/apps" "$PROJECT_ROOT/tools" "$PROJECT_ROOT/node_modules" -type d -exec chmod a+rx {} +
  run_sudo mkdir -p "$PROJECT_ROOT/.runtime" "$DATA_DIR" "$LOG_DIR"
  run_sudo chown -R "$SERVICE_USER" "$PROJECT_ROOT/.runtime" "$DATA_DIR" "$LOG_DIR"
  run_sudo chmod 700 "$PROJECT_ROOT/.runtime" "$DATA_DIR" "$LOG_DIR"
}

install_service() {
  require_files
  if [ -f "$SERVICE_FILE" ] && systemctl is-active --quiet "$SERVICE_NAME"; then
    error "服务正在运行。请使用 upgrade 升级，或先 stop 再重新 install。"
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    error "未找到 Node.js 或 npm，请先安装 Node.js 22.12+ 和 npm。"
    exit 1
  fi
  if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||major===22&&minor>=12?0:1)'; then
    error "Node.js 版本过低，需要 22.12 或更高版本。"
    exit 1
  fi
  # Finish dependency installation before building or changing service files.
  run_sudo "$SCRIPT_DIR/install-maintenance.sh" --prepare-dependencies
  (cd "$PROJECT_ROOT" && npm ci && npm run build)
  prepare_permissions
  info "正在写入 $SERVICE_FILE"
  service_unit | run_sudo tee "$SERVICE_FILE" >/dev/null
  run_sudo chmod 644 "$SERVICE_FILE"
  run_sudo systemctl daemon-reload
  run_sudo systemctl enable "$SERVICE_NAME"
  run_sudo "$SCRIPT_DIR/install-maintenance.sh"
  info "服务已注册并设置为开机自启。"
}

start_service() {
  if [ ! -f "$SERVICE_FILE" ]; then install_service; fi
  run_sudo systemctl start "$SERVICE_NAME"
  info "服务已启动。"
}

stop_service() {
  if [ -f "$SERVICE_FILE" ]; then
    run_sudo systemctl stop "$SERVICE_NAME"
  else
    "$STOP_SCRIPT"
  fi
  info "服务已停止。"
}

restart_service() {
  if [ ! -f "$SERVICE_FILE" ]; then install_service; fi
  run_sudo systemctl restart "$SERVICE_NAME"
  info "服务已重启。"
}

status_service() {
  if [ ! -f "$SERVICE_FILE" ]; then
    warn "服务尚未注册。"
    return 1
  fi
  run_sudo systemctl status "$SERVICE_NAME" --no-pager
}

logs_service() {
  if [ -f "$SERVICE_FILE" ]; then
    run_sudo journalctl -u "$SERVICE_NAME" -f
  else
    local log_dir
    log_dir="$(cd "$PROJECT_ROOT" && node --input-type=module -e "import path from 'node:path';import {root,configuration} from './tools/config.mjs';console.log(path.resolve(root,configuration()['logging.dir']))")"
    tail -f "$log_dir/server.log" "$log_dir/web.log"
  fi
}

enable_service() { run_sudo systemctl enable "$SERVICE_NAME"; info "已开启开机自启。"; }
disable_service() { run_sudo systemctl disable "$SERVICE_NAME"; info "已关闭开机自启。"; }

upgrade_service() {
  "$SCRIPT_DIR/upgrade.sh" "${@:2}"
}

uninstall_service() {
  if [ ! -f "$SERVICE_FILE" ]; then warn "服务尚未注册。"; return 0; fi
  stop_service
  run_sudo systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  run_sudo systemctl disable --now agenda-link-maintenance.service 2>/dev/null || true
  run_sudo rm -f /etc/systemd/system/agenda-link-maintenance.service
  run_sudo rm -f "$SERVICE_FILE"
  run_sudo systemctl daemon-reload
  info "服务已卸载。"
}

usage() {
  cat <<'EOF'
用法: ./tools/manage_service.sh <命令>

  install      检查并安装维护依赖，注册 systemd 服务并设置开机自启
  start        启动服务（未注册时自动注册）
  stop         停止服务
  restart      重启服务
  status       查看 systemd 状态
  logs         查看实时日志
  enable       开启开机自启
  disable      关闭开机自启
  upgrade      git fast-forward 更新、安装依赖、构建并恢复服务
               --rebuild 强制验证并重新部署当前提交
  update       upgrade 的别名
  link-git     首次关联官方仓库 main（须先上传相同源码；不覆盖文件）
               --ssh 使用 GitHub SSH 只读部署密钥
  backup       在线备份数据库和配置到 .runtime/backups
  restore DIR  停止服务后恢复备份目录
  uninstall    停止并卸载本脚本注册的服务
EOF
}

case "${1:-}" in
  -h|--help|"") usage; exit 0 ;;
  link-git) node "$PROJECT_ROOT/tools/link-repository.mjs" "$REPOSITORY_URL" "$REPOSITORY_BRANCH" "${@:2}"; exit ;;
esac

require_systemd
case "${1:-}" in
  install) install_service ;;
  start) start_service ;;
  stop) stop_service ;;
  restart) restart_service ;;
  status) status_service ;;
  logs) logs_service ;;
  enable) enable_service ;;
  disable) disable_service ;;
  upgrade|update) upgrade_service "$@" ;;
  backup) (cd "$PROJECT_ROOT" && node tools/database.mjs backup) ;;
  restore)
    [ "$#" -eq 2 ] && [ -n "$2" ] || { error "用法: ./tools/manage_service.sh restore <备份目录或 SQLite 文件>"; exit 2; }
    [ -f "$2" ] || [ -f "$2/agenda-link.sqlite" ] || { error "找不到备份数据库: $2"; exit 1; }
    restore_path="$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$2")"
    stop_service
    (cd "$PROJECT_ROOT" && node tools/database.mjs restore "$restore_path")
    prepare_permissions
    info "恢复完成，服务保持停止。请执行 start 并核对数据。"
    ;;
  uninstall) uninstall_service ;;
  *) error "未知命令: $1"; usage; exit 2 ;;
esac
