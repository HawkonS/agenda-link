#!/usr/bin/python3
import json, socket, sys
args=sys.argv[1:]
if args==['systemctl','start','agenda-link.service']: action='start'
elif args==['systemctl','stop','agenda-link.service']: action='stop'
elif args==['systemctl','is-active','--quiet','agenda-link.service']: action='is-active'
elif args==['systemctl','show','agenda-link.service','--property=User','--value']: action='user'
else: sys.exit('拒绝非白名单命令')
with socket.socket(socket.AF_UNIX) as client:
    client.settimeout(180);client.connect('/run/agenda-link-maintenance/control.sock');client.sendall((json.dumps({'method':'control','action':action})+'\n').encode())
    data=b''
    while b'\n' not in data: data+=client.recv(4096)
    result=json.loads(data)
    if not result['ok']: sys.exit(result['error'])
    print(result['data'].get('output',''))
