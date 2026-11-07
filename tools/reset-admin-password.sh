#!/usr/bin/env bash
# ============================================================
# agenda-link 管理员密码重置
#
# 直接执行即可：
#   ./tools/reset-admin-password.sh
#   ./tools/reset-admin-password.sh --enable
#   ./tools/reset-admin-password.sh --user hawkon --password-stdin
#
# 所有参数原样透传给实现脚本，详见：
#   ./tools/reset-admin-password.sh --help
# ============================================================
set -eu

SCRIPT_PATH="$0"
CODE_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
NODE_BIN="${AGENDA_LINK_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  # 优先使用当前 shell 的 Node（CI 由 setup-node 提供），
  # 无法加载 better-sqlite3 时再回退到系统的生产 Node。
  for candidate in "${AGENDA_LINK_NODE:-}" "$(command -v node 2>/dev/null || true)" /usr/bin/node /usr/local/bin/node; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    if "$candidate" -e 'require(process.argv[1])' "$CODE_DIR/node_modules/better-sqlite3" >/dev/null 2>&1; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ] || ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "错误：未找到可用于当前依赖的 Node.js。请使用 Node.js 22.12+，或用 AGENDA_LINK_NODE 指定。" >&2
  exit 1
fi

if ! "$NODE_BIN" -e 'require(process.argv[1])' "$CODE_DIR/node_modules/better-sqlite3" >/dev/null 2>&1; then
  echo "错误：$NODE_BIN 无法加载 better-sqlite3（Node 大版本与编译产物不一致）。" >&2
  echo "请在服务使用的 Node.js 下执行：cd $CODE_DIR && npm rebuild better-sqlite3" >&2
  exit 1
fi

exec "$NODE_BIN" "$CODE_DIR/tools/reset-admin-password.mjs" "$@"
