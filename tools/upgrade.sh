#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
REBUILD=false
case "${1:-}" in
 "") [ "$#" -eq 0 ] || exit 2 ;;
 --rebuild) [ "$#" -eq 1 ] || exit 2; REBUILD=true ;;
 *) echo "用法: ./tools/upgrade.sh [--rebuild]" >&2; exit 2 ;;
esac
git(){ command git -c safe.directory="$ROOT_DIR" "$@"; }
git rev-parse --verify HEAD >/dev/null 2>&1 || { echo "仓库尚无提交。请先上传源码至 https://github.com/HawkonS/agenda-link，再执行 tools/manage_service.sh link-git。" >&2; exit 1; }
[ -n "$(git remote)" ] || { echo "仓库没有 Git remote，无法升级。请先配置可信的私有或公开仓库。" >&2; exit 1; }
git rev-parse --verify '@{upstream}' >/dev/null 2>&1 || { echo "当前分支没有 Git upstream，无法升级。请先配置跟踪分支。" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "工作区有修改，拒绝自动升级。" >&2; exit 1; }
OLD_COMMIT="$(git rev-parse HEAD)"
mkdir -p .runtime
mkdir .runtime/upgrade.lock 2>/dev/null || { echo "已有升级任务。" >&2; exit 1; }
STAGE=""
cleanup(){ [ -z "$STAGE" ] || rm -rf "$STAGE"; rmdir "$ROOT_DIR/.runtime/upgrade.lock" 2>/dev/null || true; }
trap cleanup EXIT
STAGE="$(mktemp -d "$ROOT_DIR/.runtime/upgrade.XXXXXX")"
UNIT=agenda-link.service
WAS_ACTIVE=false
MUTATED=false
SERVICE_USER=""
BACKUP_DIR=""
as_root(){ if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }
runtime_permissions(){
 # Prebuilds inherit the maintenance service umask; Nginx must read public assets.
 if [ -d "$ROOT_DIR/apps/web/dist" ]; then
  find "$ROOT_DIR/apps/web/dist" -type d -exec chmod 755 {} +
  find "$ROOT_DIR/apps/web/dist" -type f -exec chmod 644 {} +
 fi
 if [ -n "$SERVICE_USER" ] && [ "$SERVICE_USER" != root ] && id "$SERVICE_USER" >/dev/null 2>&1; then
  as_root chown "$SERVICE_USER" "$ROOT_DIR" "$ROOT_DIR/agenda-link.properties"
  local data_dir log_dir
  data_dir="$(node --input-type=module -e "import path from 'node:path';import {configuration} from './tools/config.mjs';console.log(path.resolve(configuration()['storage.data-dir'] || './data'))")"
  log_dir="$(node --input-type=module -e "import path from 'node:path';import {configuration} from './tools/config.mjs';console.log(path.resolve(configuration()['logging.dir'] || './logs'))")"
  for directory in "$ROOT_DIR/.runtime" "$data_dir" "$log_dir"; do
   case "$directory" in "$ROOT_DIR"/*) ;; *) echo "运行目录在项目外，需运维人员检查所有权。" >&2; continue ;; esac
   [ ! -d "$directory" ] || as_root chown -R "$SERVICE_USER" "$directory"
  done
 fi
}
rollback(){
 local code=$?
 trap - ERR
 echo "升级失败，正在恢复旧版。" >&2
 if [ "$MUTATED" = true ]; then
  as_root systemctl stop "$UNIT" || true
  git reset --keep "$OLD_COMMIT" || { echo "代码回退失败，保留服务停止状态，请检查本地修改。" >&2; exit "$code"; }
  if [ -d "$STAGE/previous-node_modules" ]; then rm -rf node_modules; mv "$STAGE/previous-node_modules" node_modules; fi
  if [ -n "$BACKUP_DIR" ]; then node tools/database.mjs restore "$BACKUP_DIR"; fi
  npm run build || { echo "旧版构建失败，请从 $BACKUP_DIR 手动恢复。" >&2; exit "$code"; }
  runtime_permissions
 fi
 if [ "$WAS_ACTIVE" = true ]; then as_root systemctl start "$UNIT" || true; fi
 exit "$code"
}
trap cleanup EXIT
trap rollback ERR
git fetch
TARGET="$(git rev-parse '@{upstream}')"
git merge-base --is-ancestor "$OLD_COMMIT" "$TARGET"
if [ "$TARGET" = "$OLD_COMMIT" ] && [ "$REBUILD" = false ]; then echo "当前已是最新版本。"; exit 0; fi
echo "预先安装、检查和构建新版..."
git archive "$TARGET" | tar -x -C "$STAGE"
(cd "$STAGE" && npm ci && npm run check)
[ -z "$(git status --porcelain)" ] || { echo "准备期间工作区发生修改，退出升级。" >&2; exit 1; }
if as_root systemctl is-active --quiet "$UNIT"; then WAS_ACTIVE=true; fi
if [ "$WAS_ACTIVE" = true ]; then SERVICE_USER="$(as_root systemctl show "$UNIT" --property=User --value)"; fi
if [ "$WAS_ACTIVE" = true ]; then as_root systemctl stop "$UNIT"; else ./stop.sh; fi
if [ -f agenda-link.properties ]; then
 BACKUP_DIR="$ROOT_DIR/.runtime/backups/upgrade-$(date +%Y%m%d-%H%M%S)"
 node tools/database.mjs backup "$BACKUP_DIR"
fi
MUTATED=true
git merge --ff-only "$TARGET"
[ ! -d node_modules ] || mv node_modules "$STAGE/previous-node_modules"
mv "$STAGE/node_modules" node_modules
mkdir -p apps/server/dist apps/web/dist
rm -rf apps/server/dist apps/web/dist
cp -R "$STAGE/apps/server/dist" apps/server/dist
cp -R "$STAGE/apps/web/dist" apps/web/dist
runtime_permissions
if [ "$WAS_ACTIVE" = true ]; then
 as_root systemctl start "$UNIT"
 WEB_PORT="$(node --input-type=module -e "import {configuration} from './tools/config.mjs';console.log(configuration()['web.port'])")"
 healthy=false
 for _ in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:$WEB_PORT/api/health" >/dev/null; then healthy=true; break; fi
  sleep 1
 done
 [ "$healthy" = true ]
fi
trap - ERR
echo "升级完成：${TARGET}。备份：${BACKUP_DIR:-首次部署无旧数据}。"
