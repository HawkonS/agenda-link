#!/usr/bin/env bash
# ============================================================
# agenda-link 服务停止脚本
# 只依据本项目 .runtime/pids 停止由 run.sh 启动的进程。
# ============================================================
set -Eeuo pipefail

case "${1:-}" in
  -h|--help) echo "用法: ./stop.sh（停止当前工作目录对应的运行实例）"; exit 0 ;;
  "") ;;
  *) echo "未知参数: $1" >&2; exit 2 ;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${AGENDA_LINK_WORKSPACE:-$ROOT_DIR}"
PID_FILE="$ROOT_DIR/.runtime/pids"

if [ ! -f "$PID_FILE" ]; then
  echo "agenda-link 当前没有运行记录。"
  exit 0
fi

supervisor_pid="$(awk -F= '$1 == "supervisor" {print $2}' "$PID_FILE" 2>/dev/null || true)"
server_pid="$(awk -F= '$1 == "server" {print $2}' "$PID_FILE" 2>/dev/null || true)"
web_pid="$(awk -F= '$1 == "web" {print $2}' "$PID_FILE" 2>/dev/null || true)"
for pid in "$supervisor_pid" "$server_pid" "$web_pid"; do
  if [ -n "$pid" ] && { ! [[ "$pid" =~ ^[0-9]+$ ]] || [ "$pid" -le 1 ]; }; then
    echo "运行记录包含无效 PID，拒绝发送停止信号。请核对 ${PID_FILE}。" >&2
    exit 1
  fi
done

stop_one() {
  local name="$1" pid="$2"
  [ -z "$pid" ] && return 0
  if kill -0 "$pid" 2>/dev/null; then
    echo "正在停止 $name (PID: $pid)..."
    kill -TERM "$pid" 2>/dev/null || { echo "无法停止 ${name}，请检查运行用户权限。" >&2; return 1; }
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || { echo "$name 已停止。"; return 0; }
      sleep 1
    done
    echo "$name 未及时退出，正在强制停止。"
    kill -KILL "$pid" 2>/dev/null || { echo "无法强制停止 ${name}。" >&2; return 1; }
  else
    echo "$name 已经停止。"
  fi
}

# 先通知 supervisor，由 supervisor 负责回收两个子进程。
stop_one "agenda-link" "$supervisor_pid"
stop_one "API" "$server_pid"
stop_one "Web" "$web_pid"
rm -f "$PID_FILE"
echo "agenda-link 已停止。"
