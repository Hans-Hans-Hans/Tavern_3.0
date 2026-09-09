"""CI-only controller for the real integration process and its durable nio store.

Never mount this helper in a deployment. It starts dormant, listens only through
the CI loopback mapping, and requires the run's filesystem capability for every
control operation. Matrix credentials are accepted once and never returned.
"""
import asyncio
import base64
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import signal
import sqlite3
import sys

from aiohttp import ClientError, ClientSession, ClientTimeout, web

ORIGIN = 'https://chat.example.test'
HOMESERVER = 'http://synapse:8008'
BOT = '@cisystembot:chat.example.test'
OWNER = '@cialice:chat.example.test'
BOB = '@cibob:chat.example.test'
CONFIG, DATA = Path('/config'), Path('/data')
CAPABILITY = Path('/ci/tls/system-bot.capability')
HOOK = 'ci-system-notices'


def require_ci():
    if os.environ.get('TAVERN_CI_SMOKE') != 'true' or os.environ.get('TAVERN_PUBLIC_URL') != ORIGIN:
        raise RuntimeError('This controller requires the isolated CI stack.')


def room_id(value):
    if not isinstance(value, str): return False
    if re.fullmatch(r'![^\s/\\?#:\x00-\x1f\x7f]{1,200}:chat\.example\.test', value): return True
    if not re.fullmatch(r'![A-Za-z0-9_-]{43}', value): return False
    raw = base64.urlsafe_b64decode(value[1:] + '=')
    return len(raw) == 32 and base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=') == value[1:]


def valid_prepare(data):
    if (not isinstance(data, dict) or set(data) != {'runId', 'botUserId', 'password', 'serverId', 'channelId', 'devices'}
        or not isinstance(data['runId'], str) or not re.fullmatch(r'[a-f0-9]{24}', data['runId'])
        or data['botUserId'] != BOT or not isinstance(data['password'], str) or not 16 <= len(data['password']) <= 256
        or not room_id(data['serverId']) or not room_id(data['channelId']) or data['serverId'] == data['channelId']
        or not isinstance(data['devices'], dict) or set(data['devices']) != {OWNER, BOB}): return False
    for user, devices in data['devices'].items():
        if not isinstance(devices, dict) or len(devices) != 1: return False
        for device, fingerprint in devices.items():
            if (not isinstance(device, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', device)
                or not isinstance(fingerprint, str) or not re.fullmatch(r'[A-Za-z0-9+/]{43}=?', fingerprint)): return False
    return True


def write_new(path, data):
    with path.open('xb') as stream:
        path.chmod(0o600); stream.write(data); stream.flush(); os.fsync(stream.fileno())


def json_bytes(value): return (json.dumps(value, indent=2) + '\n').encode()


class Controller:
    def __init__(self): self.process, self.lock = None, asyncio.Lock()

    def manifest(self):
        path = DATA / 'ci-system-fixture.json'
        if not path.exists(): return None
        if path.is_symlink() or path.stat().st_size > 8192: raise RuntimeError('Invalid CI manifest')
        data = json.loads(path.read_bytes())
        if (not isinstance(data, dict) or set(data) != {'runId', 'botUserId', 'serverId', 'channelId', 'devices', 'deviceId', 'fingerprint'}
            or not valid_prepare({key: data[key] for key in ('runId','botUserId','serverId','channelId','devices')} | {'password':'not-a-real-password'})
            or not isinstance(data['deviceId'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',data['deviceId'])
            or not isinstance(data['fingerprint'], str) or not re.fullmatch(r'[A-Za-z0-9+/]{43}=?',data['fingerprint'])): raise RuntimeError('Invalid CI manifest')
        return data

    async def native_state(self, token, room):
        from urllib.parse import quote
        async with ClientSession(timeout=ClientTimeout(total=15), trust_env=False) as http:
            async with http.get(HOMESERVER + '/_matrix/client/v3/rooms/' + quote(room, safe='') + '/state',
                                headers={'Authorization':'Bearer '+token}, allow_redirects=False) as response:
                raw=bytearray()
                async for chunk in response.content.iter_chunked(8192):
                    raw.extend(chunk)
                    if len(raw)>262144: raise RuntimeError('CI room state exceeded its bound')
                if response.status!=200: raise RuntimeError('Could not verify native CI room')
                value=json.loads(raw)
                if not isinstance(value,list) or len(value)>100: raise RuntimeError('Invalid CI room state')
                return {(item['type'],item['state_key']):item for item in value}

    async def verify_rooms(self, token, data):
        parent=await self.native_state(token,data['serverId'])
        child=await self.native_state(token,data['channelId'])
        for identity,current,kind in ((data['serverId'],parent,'server'),(data['channelId'],child,'channel')):
            create=current.get(('m.room.create',''),{})
            body=create.get('content',{})
            # Syntax never establishes locality for v12. This method gates the
            # durable prepared manifest and sender startup after the trusted CI
            # creator/capability handoff and fixed-homeserver bot joins.
            hashed = ':' not in identity
            if (not room_id(identity) or (body.get('room_version') == '12') != hashed
                or create.get('sender')!=OWNER or body.get('m.federate') is not False
                or body.get('additional_creators') is not None
                or current.get(('m.room.member',OWNER),{}).get('content',{}).get('membership')!='join'
                or body.get('io.tavern.ci_system')!=data['runId']
                or current.get(('m.room.name',''),{}).get('content',{}).get('name')!='CI system notices '+data['runId']+' '+kind
                or current.get(('m.room.member',BOT),{}).get('content',{}).get('membership')!='join'):
                raise RuntimeError('Only the newly created isolated CI fixture is permitted')
        if (parent[('m.room.create','')]['content'].get('type')!='m.space'
            or child[('m.room.create','')]['content'].get('type') is not None
            or child.get(('m.room.encryption',''),{}).get('content',{}).get('algorithm')!='m.megolm.v1.aes-sha2'
            or parent.get(('m.space.child',data['channelId']),{}).get('content',{}).get('via')!=['chat.example.test']
            or child.get(('m.space.parent',data['serverId']),{}).get('content',{})!={'canonical':True,'via':['chat.example.test']}):
            raise RuntimeError('Invalid isolated encrypted CI destination')
        members={user for (kind,user),item in child.items() if kind=='m.room.member' and item['content'].get('membership')=='join'}
        if members!={OWNER,BOB,BOT}: raise RuntimeError('Unexpected CI recipient')

    async def prepare(self, data):
        if not valid_prepare(data): raise web.HTTPBadRequest(text='Invalid isolated fixture')
        if self.process is not None or self.manifest() is not None: raise web.HTTPConflict(text='CI bot is already prepared')
        if CONFIG.is_symlink() or DATA.is_symlink() or any(CONFIG.iterdir()): raise web.HTTPConflict(text='Refusing to replace bot configuration')
        if any(path.name!='crypto' or not path.is_dir() or path.is_symlink() or any(path.iterdir()) for path in DATA.iterdir()):
            raise web.HTTPConflict(text='Refusing to replace bot data')
        from nio import AsyncClient, AsyncClientConfig, ErrorResponse, LoginResponse, SyncResponse
        from nio.store import SqliteStore
        os.umask(0o077)
        for name,value in (('queue.key',secrets.token_hex(32)),('pickle.key',secrets.token_urlsafe(48)),(HOOK+'.hmac',secrets.token_urlsafe(48))):
            write_new(CONFIG/name,(value+'\n').encode())
        config={'homeserver':HOMESERVER,'hooks':{HOOK:{'name':'CI system notices','room_id':data['channelId'],
                'allowed_users':[OWNER,BOB,BOT],'secret_file':'/config/'+HOOK+'.hmac','enabled':True}},'trusted_devices':data['devices']}
        write_new(CONFIG/'bot.json',json_bytes(config))
        (DATA/'crypto').mkdir(exist_ok=True)
        client=AsyncClient(HOMESERVER,user=BOT,store_path=str(DATA/'crypto'),config=AsyncClientConfig(store=SqliteStore,store_name='crypto.db',
            store_sync_tokens=True,encryption_enabled=True,pickle_key=(CONFIG/'pickle.key').read_text().strip(),request_timeout=15,max_timeouts=1))
        try:
            result=await client.login(data['password'],device_name='CI Tavern system notice bot')
            if not isinstance(result,LoginResponse) or client.user_id!=BOT or not client.device_id or not client.olm:
                raise RuntimeError('CI bot sign-in failed')
            fingerprint=client.olm.account.identity_keys['ed25519']
            write_new(CONFIG/'session.json',json_bytes({'user_id':BOT,'device_id':client.device_id,'access_token':client.access_token}))
            write_new(DATA/'identity.json',json_bytes({'user_id':BOT,'device_id':client.device_id,'ed25519':fingerprint}))
            if not isinstance(await client.sync(timeout=0,full_state=True),SyncResponse): raise RuntimeError('CI bot initial sync failed')
            if isinstance(await client.keys_upload(),ErrorResponse): raise RuntimeError('CI bot key upload failed')
            # These IDs came from the guarded Node creator in this same run;
            # verify all native markers before enabling the actual sender.
            for room in (data['serverId'],data['channelId']):
                if isinstance(await client.join(room),ErrorResponse): raise RuntimeError('Explicit CI bot join failed')
            await self.verify_rooms(client.access_token,data)
            if not isinstance(await client.sync(timeout=0,full_state=True),SyncResponse): raise RuntimeError('CI bot joined sync failed')
            manifest={key:data[key] for key in ('runId','botUserId','serverId','channelId','devices')}
            manifest.update(deviceId=client.device_id,fingerprint=fingerprint)
            write_new(DATA/'ci-system-fixture.json',json_bytes(manifest))
        finally:
            data.pop('password',None)
            await client.close()
        return {'prepared':True,'deviceId':manifest['deviceId'],'fingerprint':manifest['fingerprint']}

    async def start(self):
        if self.manifest() is None: raise web.HTTPConflict(text='Prepare the isolated bot first')
        if self.process is not None and self.process.returncode is None: return {'running':True}
        # No shell interpolation, user arguments or external executable paths.
        self.process=await asyncio.create_subprocess_exec(sys.executable,'/app/server.py',cwd='/app',stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL,start_new_session=True)
        return {'running':True}

    async def stop(self):
        process=self.process
        if process is not None and process.returncode is None:
            # asyncio.run handles SIGINT by cancelling main, which executes
            # the real Bridge.stop finally block and closes SQLite/nio first.
            process.send_signal(signal.SIGINT)
            try: await asyncio.wait_for(process.wait(),20)
            except asyncio.TimeoutError:
                process.kill(); await process.wait()
                raise RuntimeError('CI bot did not stop cleanly; do not claim restart recovery')
        self.process=None
        return {'running':False}

    async def pins(self, enabled):
        if type(enabled) is not bool or self.manifest() is None: raise web.HTTPBadRequest(text='Invalid CI pin operation')
        if self.process is not None and self.process.returncode is None: raise web.HTTPConflict(text='Stop the bot before this CI fixture change')
        path=CONFIG/'bot.json'
        if path.is_symlink() or path.stat().st_size>32768: raise RuntimeError('Invalid isolated bot configuration')
        config=json.loads(path.read_bytes()); manifest=self.manifest()
        if (config.get('homeserver')!=HOMESERVER or set(config.get('hooks',{}))!={HOOK}
            or config['hooks'][HOOK].get('room_id')!=manifest['channelId']): raise RuntimeError('CI destination changed')
        config['trusted_devices']=manifest['devices'] if enabled else {OWNER:manifest['devices'][OWNER]}
        temp=CONFIG/('.ci-'+secrets.token_hex(12)+'.tmp')
        write_new(temp,json_bytes(config)); os.replace(temp,path)
        return {'pinsEnabled':enabled}

    async def status(self):
        manifest=self.manifest(); running=self.process is not None and self.process.returncode is None
        ready=False
        if running:
            try:
                async with ClientSession(timeout=ClientTimeout(total=3),trust_env=False) as http:
                    async with http.get('http://127.0.0.1:8080/health',allow_redirects=False) as response:
                        raw=await response.content.read(8193)
                        if len(raw)>8192: raise ValueError()
                        result=json.loads(raw)
                        ready=response.status==200 and isinstance(result,dict) and result.get('ready') is True
            except (ClientError,OSError,ValueError,asyncio.TimeoutError): pass
        entries=[]; path=DATA/'outbox.db'
        if path.exists():
            with sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True,timeout=2) as db:
                exists=db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='system_deliveries'").fetchone()
                if exists: entries=[{'id':identity,'status':status,'eventId':event} for identity,status,event in db.execute('SELECT id,status,event_id FROM system_deliveries ORDER BY id LIMIT 100')]
        return {'helperReady':True,'prepared':manifest is not None,'running':running,'botReady':ready,'deliveries':entries,
            'identity':{'userId':BOT,'deviceId':manifest['deviceId'],'fingerprint':manifest['fingerprint']} if manifest else None}


def create_app():
    require_ci(); controller=Controller()
    @web.middleware
    async def protected(request,handler):
        if request.path=='/health' and request.method=='GET': return await handler(request)
        try:
            if CAPABILITY.is_symlink() or CAPABILITY.stat().st_size>128: raise ValueError()
            secret=CAPABILITY.read_text().strip()
            supplied=request.headers.get('X-Tavern-CI-Capability','')
            if (not re.fullmatch(r'[a-f0-9]{64}',secret) or not re.fullmatch(r'[a-f0-9]{64}',supplied)
                or not hmac.compare_digest(secret,supplied)): raise ValueError()
        except (OSError,ValueError): raise web.HTTPForbidden(text='CI capability required') from None
        try: return await handler(request)
        except web.HTTPException: raise
        except Exception: return web.json_response({'error':'The isolated CI bot operation failed.'},status=500)
    app=web.Application(middlewares=[protected],client_max_size=32768)
    async def health(request): return web.json_response({'helperReady':True})
    async def control(request):
        if request.content_type!='application/json': raise web.HTTPUnsupportedMediaType()
        data=await request.json()
        if not isinstance(data,dict): raise web.HTTPBadRequest()
        action=request.match_info['action']
        async with controller.lock:
            if action=='prepare':
                async with asyncio.timeout(120): result=await controller.prepare(data)
            elif action=='recipient-pins' and set(data)=={'enabled'}: result=await controller.pins(data['enabled'])
            elif data: raise web.HTTPBadRequest()
            elif action=='start': result=await controller.start()
            elif action=='stop': result=await controller.stop()
            elif action=='status': result=await controller.status()
            else: raise web.HTTPNotFound()
        return web.json_response(result,headers={'Cache-Control':'no-store'})
    async def close(app): await controller.stop()
    app.router.add_get('/health',health)
    app.router.add_post('/{action:prepare|start|stop|status|recipient-pins}',control)
    app.on_cleanup.append(close)
    return app


if __name__=='__main__': web.run_app(create_app(),host='0.0.0.0',port=8086,access_log=None)
