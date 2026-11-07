#!/usr/bin/python3
"""Privileged broker: accepts fixed service actions only; never executes caller supplied commands."""
import json, os, pwd, re, socket, struct, subprocess, threading, time, uuid, urllib.request
from pathlib import Path
BASE = Path('/usr/local/lib/agenda-link-maintenance')
CONFIG = json.loads((BASE / 'config.json').read_text())
ROOT, USER = CONFIG['root'], CONFIG['user']
UID, GID = pwd.getpwnam(USER).pw_uid, pwd.getpwnam(USER).pw_gid
SOCKET = '/run/agenda-link-maintenance/control.sock'
STATE = Path('/var/lib/agenda-link-maintenance/operation.json')
UNIT = 'agenda-link.service'
lock = threading.Lock()

def clean(text):
    text=re.sub(r'(https?://)[^\s/@]+:[^\s/@]+@',r'\1[hidden]@',text)
    return re.sub(r'((?:token|secret|password|authorization)[\w-]*[=:\s]+)[^\s,;]+',r'\1[hidden]',text,flags=re.I)[-32768:]

def run(args, timeout=60, user=False, state=None):
    command = (['/usr/sbin/runuser','-u',USER,'--','/usr/bin/setpriv','--no-new-privs','--'] if user else []) + args
    env = {'PATH':CONFIG['path'],'HOME':pwd.getpwnam(USER).pw_dir,'LANG':'C.UTF-8','AGENDA_LINK_MAINTENANCE':'1','GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'safe.directory','GIT_CONFIG_VALUE_0':ROOT}
    if state is None:
        result = subprocess.run(command,cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=timeout)
        if result.returncode: raise RuntimeError(clean(result.stdout) or '操作失败')
        return clean(result.stdout.strip())
    process=subprocess.Popen(command,cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,start_new_session=True)
    output=[]
    def reader():
        last=0
        for line in process.stdout:
            output.append(line)
            if len(output)>500: del output[:-500]
            if time.monotonic()-last>0.5:
                state['output']=clean(''.join(output));save(state);last=time.monotonic()
    reading=threading.Thread(target=reader,daemon=True);reading.start()
    try: code=process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid,15);process.wait(timeout=30);raise RuntimeError('维护操作超时，请通过 SSH 核对')
    reading.join(timeout=5)
    result=clean(''.join(output));state['output']=result;save(state)
    if code: raise RuntimeError(result or '操作失败')
    return result

def read_state():
    try: return json.loads(STATE.read_text())
    except FileNotFoundError: return None

def save(state):
    target=STATE.with_suffix('.tmp')
    target.write_text(json.dumps(state,ensure_ascii=False))
    os.chmod(target,0o640);os.chown(target,0,GID);os.replace(target,STATE)

def health():
    values = dict(line.split('=',1) for line in (Path(ROOT)/'agenda-link.properties').read_text().splitlines() if '=' in line and not line.lstrip().startswith('#'))
    port=int(values.get('app.port',CONFIG['apiPort']))
    if not 1 <= port <= 65535: raise RuntimeError('API 端口无效')
    with urllib.request.urlopen('http://127.0.0.1:%s/api/health'%port,timeout=2) as response:
        return json.load(response)

def upstream():
    remote = run(['git','remote'],user=True)
    if not remote: raise RuntimeError('仓库没有 Git remote，无法检查更新。请通过 SSH 配置可信上游。')
    try: target=run(['git','rev-parse','--abbrev-ref','@{upstream}'],user=True)
    except Exception: raise RuntimeError('当前分支没有 Git upstream，请通过 SSH 配置上游。')
    if run(['git','status','--porcelain'],user=True): raise RuntimeError('工作区有未提交修改，拒绝自动更新。请通过 SSH 处理。')
    run(['git','-c','core.hooksPath=/dev/null','fetch'],timeout=180,user=True)
    return run(['git','rev-parse','@{upstream}'],user=True)

def execute(state):
    try:
        action=state['action'];state.update(status='running',stage='执行中');save(state)
        old = {'bootId':state.get('previousBootId')}
        if action in ['check-update','upgrade']:
            state['stage']='检查上游';save(state);target=upstream();state['targetVersion']=target;save(state)
            current=run(['git','rev-parse','HEAD'],user=True)
            if action=='upgrade' and target!=current:
                for relative in ['.','.git','apps','apps/server','apps/web','tools','node_modules']:
                    try: run(['/usr/bin/test','-w',str(Path(ROOT)/relative)],user=True)
                    except Exception: raise RuntimeError('服务运行用户没有代码目录写权限，请通过 SSH 升级或调整安装所有权。')
            state['output']='当前版本：%s\n上游版本：%s'%(current,target)
            if action=='upgrade' and target!=current:
                state['stage']='预构建、备份与升级';save(state)
                state['output']+='\n'+run(['/bin/bash',str(BASE/'upgrade.sh')],timeout=3600,user=True,state=state)
            elif action=='upgrade': state['output']+='\n当前已是最新版本。'
        else:
            state['output']=run(['/bin/bash',str(BASE/'manage_service.sh'),action],timeout=180)
            if action=='stop' and run(['/usr/bin/systemctl','show',UNIT,'--property=ActiveState','--value']) not in ['inactive','failed']:
                raise RuntimeError('服务未完全停止，请通过 SSH 检查')
        if action in ['restart','upgrade'] and (action=='restart' or target!=current):
            state['stage']='验证启动与健康状态';save(state)
            for attempt in range(60):
                try:
                    new=health()
                    if new.get('status')=='ok' and new.get('bootId')!=old.get('bootId') and (action!='upgrade' or new.get('revision')==state['targetVersion']): break
                except Exception: pass
                time.sleep(1)
            else: raise RuntimeError('服务未通过启动标识、目标版本与健康检查，请通过 SSH 核对。')
            state['bootId']=new.get('bootId')
        state.update(status='success',stage='已完成')
    except Exception as error: state.update(status='failed',stage='操作失败',error=clean(str(error)))
    finally:
        state['finishedAt']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
        try: save(state)
        finally: lock.release()

def request(data):
    if data.get('method')=='control':
        # Upgrade worker runs without root. It can control only this fixed unit.
        action=data.get('action')
        if action not in ['start','stop','is-active','user']: raise RuntimeError('拒绝控制动作')
        if not lock.locked() or (read_state() or {}).get('action')!='upgrade': raise RuntimeError('无升级任务')
        args={'start':['start',UNIT],'stop':['stop',UNIT],'is-active':['is-active','--quiet',UNIT],'user':['show',UNIT,'--property=User','--value']}[action]
        return {'output':run(['/usr/bin/systemctl']+args)}
    if data.get('method')=='status':
        try: enabled=run(['/usr/bin/systemctl','is-enabled',UNIT])=='enabled'
        except Exception: enabled=False
        return {'available':True,'enabled':enabled,'operation':read_state()}
    action=data.get('action')
    if data.get('method')!='submit' or action not in ['restart','stop','check-update','upgrade','enable','disable']: raise RuntimeError('拒绝维护动作')
    if not Path('/etc/systemd/system/'+UNIT).is_file(): raise RuntimeError('主服务未注册')
    if not lock.acquire(False): raise RuntimeError('已有维护任务正在执行')
    state={'id':str(uuid.uuid4()),'action':action,'status':'queued','stage':'排队中','createdAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'output':'','previousBootId':str(data.get('bootId',''))[:100]}
    try: save(state)
    except Exception: lock.release();raise
    threading.Thread(target=execute,args=(state,),daemon=True).start()
    return dict(state)

def client(conn):
    with conn:
        try:
            _,uid,_=struct.unpack('3i',conn.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
            if uid not in [0,UID]: raise RuntimeError('无权限')
            conn.settimeout(5);raw=b''
            while b'\n' not in raw:
                block=conn.recv(1024)
                if not block: break
                raw+=block
                if len(raw)>4096: raise RuntimeError('请求过长')
            result=request(json.loads(raw.split(b'\n')[0]));conn.sendall((json.dumps({'ok':True,'data':result},ensure_ascii=False)+'\n').encode())
        except Exception as error: conn.sendall((json.dumps({'ok':False,'error':clean(str(error))},ensure_ascii=False)+'\n').encode())

if __name__=='__main__':
    STATE.parent.mkdir(mode=0o750,parents=True,exist_ok=True);os.chown(STATE.parent,0,GID)
    previous=read_state()
    if previous and previous.get('status') in ['queued','running']: previous.update(status='failed',stage='维护服务重启中断，请核对后重试');save(previous)
    try: os.unlink(SOCKET)
    except FileNotFoundError: pass
    server=socket.socket(socket.AF_UNIX);server.bind(SOCKET);os.chmod(SOCKET,0o660);os.chown(SOCKET,0,GID);server.listen(8)
    while True:
        conn,_=server.accept();threading.Thread(target=client,args=(conn,),daemon=True).start()
