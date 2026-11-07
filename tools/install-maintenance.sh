#!/usr/bin/env bash
# Install a protected broker outside the application writable directory.
set -Eeuo pipefail
[ "$(id -u)" -eq 0 ] || { echo '请使用 sudo 安装维护服务'; exit 1; }

TASK_DEPENDENCIES_ONLY=false
case "$#:${1:-}" in
  0:) ;;
  1:--prepare-dependencies) TASK_DEPENDENCIES_ONLY=true ;;
  *) echo '用法: sudo tools/install-maintenance.sh [--prepare-dependencies]' >&2; exit 2 ;;
esac

# These paths must match the protected maintenance service and its daemon.
TASK_PYTHON=/usr/bin/python3
TASK_SETPRIV=/usr/bin/setpriv
TASK_RUNUSER=/usr/sbin/runuser

find_missing_dependencies() {
  TASK_MISSING_PACKAGES=()
  if ! "$TASK_PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 7))' >/dev/null 2>&1; then
    TASK_MISSING_PACKAGES+=(python3)
  fi
  if ! "$TASK_SETPRIV" --no-new-privs -- /bin/true >/dev/null 2>&1 \
    || ! "$TASK_RUNUSER" --version >/dev/null 2>&1; then
    TASK_MISSING_PACKAGES+=(util-linux)
  fi
}

prepare_dependencies() {
  find_missing_dependencies
  [ "${#TASK_MISSING_PACKAGES[@]}" -gt 0 ] || return 0
  printf '[agenda-link] 正在安装系统依赖: %s\n' "${TASK_MISSING_PACKAGES[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    if ! DEBIAN_FRONTEND=noninteractive apt-get update \
      || ! DEBIAN_FRONTEND=noninteractive apt-get install -y -- "${TASK_MISSING_PACKAGES[@]}"; then
      echo '系统依赖安装失败，请检查软件源、网络和包管理器锁，然后重试。尚未修改服务注册。' >&2
      return 1
    fi
  elif command -v dnf >/dev/null 2>&1; then
    if ! dnf install -y -- "${TASK_MISSING_PACKAGES[@]}"; then
      echo '系统依赖安装失败，请检查软件源、网络和包管理器锁，然后重试。尚未修改服务注册。' >&2
      return 1
    fi
  elif command -v yum >/dev/null 2>&1; then
    if ! yum install -y -- "${TASK_MISSING_PACKAGES[@]}"; then
      echo '系统依赖安装失败，请检查软件源、网络和包管理器锁，然后重试。尚未修改服务注册。' >&2
      return 1
    fi
  else
    echo '未找到 apt-get、dnf 或 yum，请手动安装 Python 3 和 util-linux 后重试。尚未修改服务注册。' >&2
    return 1
  fi
  find_missing_dependencies
  if [ "${#TASK_MISSING_PACKAGES[@]}" -gt 0 ]; then
    printf '安装后依赖仍不可用: %s。需要 /usr/bin/python3（3.7+）、/usr/bin/setpriv 和 /usr/sbin/runuser。尚未修改服务注册。\n' "${TASK_MISSING_PACKAGES[*]}" >&2
    return 1
  fi
}

if ! command -v systemctl >/dev/null 2>&1 \
  || ! systemctl show --property=Version --value >/dev/null 2>&1; then
  echo '无法连接 systemd，请在使用 systemd 的 Linux 主机上安装服务。' >&2
  exit 1
fi
TASK_NODE="$(command -v node)" || { echo '未找到 Node.js，请先安装 Node.js 22.12+。' >&2; exit 1; }
if ! "$TASK_NODE" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||major===22&&minor>=12?0:1)'; then
  echo 'Node.js 版本过低，需要 22.12 或更高版本。' >&2
  exit 1
fi
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$TASK_DEPENDENCIES_ONLY" = true ]; then
  prepare_dependencies
  exit 0
fi
TASK_USER="$(systemctl show agenda-link.service --property=User --value)"
[ -n "$TASK_USER" ] || { echo '无法读取 systemd 服务用户'; exit 1; }
prepare_dependencies
TASK_DEST=/usr/local/lib/agenda-link-maintenance
install -d -o root -g root -m 755 "$TASK_DEST"
install -o root -g root -m 644 "$TASK_ROOT/tools/maintenance/daemon.py" "$TASK_ROOT/tools/maintenance/client.py" "$TASK_DEST/"
TASK_ROOT="$TASK_ROOT" TASK_USER="$TASK_USER" TASK_DEST="$TASK_DEST" TASK_NODE="$TASK_NODE" "$TASK_PYTHON" - <<'PY'
import json, os, pathlib, subprocess
root=pathlib.Path(os.environ['TASK_ROOT']);dest=pathlib.Path(os.environ['TASK_DEST'])
# No application-controlled path/argument is accepted at runtime by the root broker.
manager=(root/'tools/manage_service.sh').read_text().replace('PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"','PROJECT_ROOT='+__import__('shlex').quote(str(root)))
(dest/'manage_service.sh').write_text(manager)
upgrade=(root/'tools/upgrade.sh').read_text().replace('ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"','ROOT_DIR='+__import__('shlex').quote(str(root)))
upgrade=upgrade.replace('as_root(){ if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }','as_root(){ if [ "$1" = systemctl ]; then /usr/bin/python3 /usr/local/lib/agenda-link-maintenance/client.py "$@"; else "$@"; fi; }')
(dest/'upgrade.sh').write_text(upgrade)
port=subprocess.check_output([os.environ['TASK_NODE'],'--input-type=module','-e',"import {configuration} from './tools/config.mjs';console.log(configuration()['app.port'])"],cwd=root,text=True).strip()
(dest/'config.json').write_text(json.dumps({'root':str(root),'user':os.environ['TASK_USER'],'apiPort':int(port),'path':os.environ['PATH']}))
for p in dest.iterdir(): p.chmod(0o644);os.chown(p,0,0)
PY
cat > /etc/systemd/system/agenda-link-maintenance.service <<EOF_UNIT
[Unit]
Description=agenda-link fixed action maintenance broker
After=network.target
[Service]
Type=simple
ExecStart=/usr/bin/python3 $TASK_DEST/daemon.py
Restart=on-failure
RuntimeDirectory=agenda-link-maintenance
RuntimeDirectoryMode=0755
UMask=0027
PrivateTmp=true
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
# Node.js uses netlink to enumerate network interfaces during Vite startup checks.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
[Install]
WantedBy=multi-user.target
EOF_UNIT
chmod 644 /etc/systemd/system/agenda-link-maintenance.service
systemctl daemon-reload
systemctl enable --now agenda-link-maintenance.service
systemctl restart agenda-link-maintenance.service
