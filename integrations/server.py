"""A single durable Matrix encryption endpoint for signed incoming webhooks.

No automatic invitations, fingerprint trust, plaintext Matrix fallback, or outbound forwarding.
"""
import asyncio
import fcntl
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import secrets
import sqlite3
import time

from aiohttp import web
from Crypto.Cipher import AES
from nio import AsyncClient, AsyncClientConfig, ErrorResponse, RoomSendResponse, SyncResponse
from nio.store import SqliteStore
from protocol import authenticate, transaction
from configuration import cancel_unconfigured, load_configuration, message_content, persist_destinations
from system_messages import SystemDeliveries, notice_content, identifier as system_identifier

DATA=Path('/data'); CONFIG=Path('/config/bot.json')

class Bridge:
    def __init__(self):
        os.umask(0o077)
        self.lock=(DATA/'bridge.lock').open('a');fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.config,self.secrets,self.configuration=load_configuration(CONFIG);session=json.loads((CONFIG.parent/'session.json').read_text())
        initial_stat=CONFIG.stat();self.config_stamp=(initial_stat.st_ino,initial_stat.st_mtime_ns,initial_stat.st_size)
        self.pins=self.config.get('trusted_devices',{});self.hooks=self.config['hooks']
        self.queue_key=bytes.fromhex((CONFIG.parent/'queue.key').read_text().strip())
        if len(self.queue_key)!=32: raise RuntimeError('Queue key must contain 32 random bytes encoded as hex')
        identity_path=DATA/'identity.json'
        if not identity_path.exists() or not (DATA/'crypto/crypto.db').exists():raise RuntimeError('Provision the bot once before startup; refusing to recreate a lost encryption store')
        self.identity=json.loads(identity_path.read_text())
        if any(session[k]!=self.identity[k] for k in ['user_id','device_id']):raise RuntimeError('Session identity differs from the durable crypto store')
        config=AsyncClientConfig(store=SqliteStore,store_name='crypto.db',store_sync_tokens=True,encryption_enabled=True,
            pickle_key=(CONFIG.parent/'pickle.key').read_text().strip(),request_timeout=30,max_limit_exceeded=3,max_timeouts=3)
        self.client=AsyncClient(self.config['homeserver'],user=session['user_id'],device_id=session['device_id'],store_path=str(DATA/'crypto'),config=config)
        self.client.restore_login(session['user_id'],session['device_id'],session['access_token'])
        if not self.client.olm or not hmac.compare_digest(self.client.olm.account.identity_keys['ed25519'],self.identity['ed25519']):raise RuntimeError('Encryption device fingerprint changed')
        self.db=sqlite3.connect(DATA/'outbox.db');self.db.execute('PRAGMA journal_mode=WAL');self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS deliveries(hook TEXT,delivery TEXT,payload BLOB,nonce BLOB,tag BLOB,status TEXT,attempts INTEGER DEFAULT 0,next_attempt INTEGER,event_id TEXT,PRIMARY KEY(hook,delivery))');self.db.commit()
        self.db.execute('CREATE TABLE IF NOT EXISTS hook_destinations(hook TEXT PRIMARY KEY,room TEXT NOT NULL)');self.db.commit()
        persist_destinations(self.db,self.config);cancel_unconfigured(self.db,self.hooks)
        self.matrix_lock=asyncio.Lock();self.last_sync=0
        self.ready=False;self.last_error='';self.rate={}
        self.system_messages=SystemDeliveries(self,CONFIG.parent)
    def reload_configuration(self):
        current_stat=CONFIG.stat();stamp=(current_stat.st_ino,current_stat.st_mtime_ns,current_stat.st_size)
        if stamp==self.config_stamp:return
        config,keys,revision=load_configuration(CONFIG)
        if revision==self.configuration:self.config_stamp=stamp;return
        if config['homeserver']!=self.config['homeserver']:raise RuntimeError('Changing bot homeserver requires explicit identity provisioning')
        persist_destinations(self.db,config)
        for hook in set(self.hooks)&set(config['hooks']):
            if self.hooks[hook]['room_id']!=config['hooks'][hook]['room_id']:raise RuntimeError('Existing webhook destinations are immutable')
        cancel_unconfigured(self.db,config['hooks'])
        self.config,self.secrets,self.configuration=config,keys,revision
        self.config_stamp=stamp
        self.hooks,self.pins=config['hooks'],config.get('trusted_devices',{})
    async def start(self):
        identity=await self.client.whoami()
        if isinstance(identity,ErrorResponse) or identity.user_id!=self.identity['user_id'] or identity.device_id!=self.identity['device_id']:raise RuntimeError('Bot access token identity mismatch')
        response=await asyncio.wait_for(self.client.sync(timeout=0,full_state=True),60)
        if not isinstance(response,SyncResponse):raise RuntimeError('Initial Matrix sync failed')
        # No auto-join: an operator must explicitly join the configured room with this bot session.
        if self.client.should_upload_keys:
            if isinstance(await self.client.keys_upload(),ErrorResponse):raise RuntimeError('Encryption key upload failed')
        self.last_sync=time.monotonic();self.sync_task=asyncio.create_task(self.synchronize())
        self.worker=asyncio.create_task(self.deliver());self.ready=True
        self.system_worker=asyncio.create_task(self.system_messages.deliver())
    async def synchronize(self):
        while True:
            async with self.matrix_lock:
                self.reload_configuration()
                response=await asyncio.wait_for(self.client.sync(timeout=1000,set_presence='offline'),45)
                if not isinstance(response,SyncResponse):raise RuntimeError('Matrix sync failed')
                self.last_sync=time.monotonic()
                operations=[]
                if self.client.should_upload_keys:operations.append(await self.client.keys_upload())
                if self.client.should_query_keys:operations.append(await self.client.keys_query())
                if self.client.should_claim_keys:operations.append(await self.client.keys_claim(self.client.get_users_for_key_claiming()))
                operations.extend(await self.client.send_to_device_messages())
                if any(isinstance(result,ErrorResponse) for result in operations):raise RuntimeError('Matrix encryption synchronization failed')
            await asyncio.sleep(0)
    async def recipients(self,hook):
        target=self.hooks[hook];room_id=target['room_id']
        if isinstance(await self.client.joined_members(room_id),ErrorResponse):raise RuntimeError('Cannot establish room membership')
        if self.client.should_query_keys and isinstance(await self.client.keys_query(),ErrorResponse):raise RuntimeError('Cannot establish recipient keys')
        room=self.client.rooms.get(room_id)
        if not room or not room.encrypted:raise RuntimeError('Bot must already be joined to the configured encrypted room')
        if set(room.users)-set(target['allowed_users']):
            self.client.invalidate_outbound_session(room_id);raise RuntimeError('Room has an unapproved participant')
        expected_devices=set()
        for user in room.users:
            devices=list(self.client.device_store.active_user_devices(user))
            if user!=self.client.user_id and not devices:raise RuntimeError('Participant encryption keys are unavailable')
            for device in devices:
                if user==self.client.user_id and device.id==self.client.device_id:continue
                expected=self.pins.get(user,{}).get(device.id)
                if not expected or not hmac.compare_digest(expected,device.ed25519):
                    self.client.unverify_device(device);self.client.invalidate_outbound_session(room_id);raise RuntimeError('Recipient device needs independently verified fingerprint approval')
                self.client.verify_device(device);expected_devices.add((user,device.id))
        return room_id,expected_devices
    async def enqueue(self,request):
        if request.content_type!='application/json':raise web.HTTPUnsupportedMediaType()
        raw=await request.read();delivery=request.headers.get('X-Tavern-Delivery','')
        # Configuration changes cannot race recipient approval/key sharing.
        async with self.matrix_lock:
            try:self.reload_configuration()
            except (OSError,ValueError,RuntimeError):raise web.HTTPServiceUnavailable(text='Integration configuration is unavailable')
        hook=request.match_info['hook']
        if hook not in self.hooks or not self.hooks[hook].get('enabled',True):raise web.HTTPNotFound()
        try:text=authenticate(hook,request.headers.get('X-Tavern-Timestamp',''),delivery,request.headers.get('X-Tavern-Signature',''),raw,self.secrets[hook])
        except (ValueError,TypeError):raise web.HTTPUnauthorized(text='Invalid signed request')
        previous=self.db.execute('SELECT status,event_id FROM deliveries WHERE hook=? AND delivery=?',(hook,delivery)).fetchone()
        if previous:return web.json_response({'status':previous[0],'event_id':previous[1]},status=200)
        now=int(time.time());bucket=self.rate.get(hook,[]);bucket=[t for t in bucket if t>now-60]
        if len(bucket)>=60:raise web.HTTPTooManyRequests()
        if self.db.execute("SELECT COUNT(*) FROM deliveries WHERE status='pending'").fetchone()[0]>=10000:raise web.HTTPServiceUnavailable(text='Delivery queue is full')
        bucket.append(now);self.rate[hook]=bucket
        cipher=AES.new(self.queue_key,AES.MODE_GCM,nonce=secrets.token_bytes(12));cipher.update((hook+'\n'+delivery).encode());ciphertext,tag=cipher.encrypt_and_digest(text.encode())
        with self.db:self.db.execute('INSERT INTO deliveries(hook,delivery,payload,nonce,tag,status,next_attempt) VALUES(?,?,?,?,?,?,?)',(hook,delivery,ciphertext,cipher.nonce,tag,'pending',now))
        return web.json_response({'status':'pending','delivery_id':delivery},status=202)
    async def deliver(self):
        while True:
            row=self.db.execute("SELECT hook,delivery,payload,nonce,tag,attempts FROM deliveries WHERE status='pending' AND next_attempt<=? ORDER BY next_attempt LIMIT 1",(int(time.time()),)).fetchone()
            if not row:await asyncio.sleep(1);continue
            await self.deliver_one(row)
    async def deliver_one(self,row):
        hook,delivery,payload,nonce,tag,attempts=row
        try:
            if self.sync_task.done():raise RuntimeError('Matrix synchronization stopped')
            async with self.matrix_lock:
                self.reload_configuration()
                if hook not in self.hooks or not self.hooks[hook].get('enabled',True):
                    with self.db:self.db.execute("UPDATE deliveries SET status='cancelled',payload=NULL,nonce=NULL,tag=NULL WHERE hook=? AND delivery=? AND status='pending'",(hook,delivery))
                    return
                # A selected row may have been cancelled while this worker waited for the
                # lock. Re-enabling a hook must never resurrect an old delivery.
                pending=self.db.execute('SELECT status FROM deliveries WHERE hook=? AND delivery=?',(hook,delivery)).fetchone()
                if not pending or pending[0]!='pending':return
                room,expected=await self.recipients(hook)
                # Per-message rotation keeps departed recipients out even when membership was refreshed outside /sync.
                self.client.invalidate_outbound_session(room)
                shared=await self.client.share_group_session(room,ignore_unverified_devices=False)
                if isinstance(shared,ErrorResponse) or not expected.issubset(shared.users_shared_with):raise RuntimeError('Some approved devices did not receive encryption keys')
                cipher=AES.new(self.queue_key,AES.MODE_GCM,nonce=nonce);cipher.update((hook+'\n'+delivery).encode());text=cipher.decrypt_and_verify(payload,tag).decode()
                content=message_content(hook,self.hooks[hook],text)
                result=await self.client.room_send(room,'m.room.message',content,tx_id=transaction(hook,delivery),ignore_unverified_devices=False)
                if not isinstance(result,RoomSendResponse):raise RuntimeError('Homeserver did not accept the encrypted message')
            with self.db:self.db.execute("UPDATE deliveries SET status='sent',payload=NULL,nonce=NULL,tag=NULL,event_id=? WHERE hook=? AND delivery=?",(result.event_id,hook,delivery))
            self.last_error=''
        except Exception as error:
            # Log failure category, never payload, token, device keys or homeserver error bodies.
            self.last_error=type(error).__name__;logging.warning('Delivery blocked (%s); inspect configured membership and fingerprint pins',self.last_error)
            with self.db:self.db.execute("UPDATE deliveries SET attempts=attempts+1,next_attempt=? WHERE hook=? AND delivery=? AND status='pending'",(int(time.time())+min(300,2**min(attempts+1,8)),hook,delivery))
    async def send_system_notice(self,identity,source,permission,authorize):
        # Called under the existing Matrix lock. Public webhook approvals and
        # native policy still apply; this route never invents recipient trust.
        if self.sync_task.done():raise RuntimeError('Matrix synchronization stopped')
        hook=source['hookId']
        if hook not in self.hooks or not self.hooks[hook].get('enabled',True) or self.hooks[hook]['room_id']!=source['channelId']:return None
        room,expected=await self.recipients(hook)
        members=set(self.client.rooms[room].users)
        if members!=set(permission['audience']):raise RuntimeError('System notice audience changed')
        fresh=await authorize(identity)
        if fresh is None:return None
        if fresh!=permission:raise RuntimeError('System notice authorization changed')
        self.reload_configuration()
        if self.configuration!=permission['configurationRevision']:raise RuntimeError('System notice device approvals changed')
        self.client.invalidate_outbound_session(room)
        shared=await self.client.share_group_session(room,ignore_unverified_devices=False)
        if isinstance(shared,ErrorResponse) or not expected.issubset(shared.users_shared_with):raise RuntimeError('Some approved devices did not receive encryption keys')
        fresh=await authorize(identity)
        if fresh is None:self.client.invalidate_outbound_session(room);return None
        if fresh!=permission:self.client.invalidate_outbound_session(room);raise RuntimeError('System notice authorization changed')
        self.reload_configuration()
        if self.configuration!=permission['configurationRevision']:self.client.invalidate_outbound_session(room);raise RuntimeError('System notice device approvals changed')
        # Public hook transactions are exactly tavern-<hex digest>. Keep a
        # disjoint prefix even if an operator names a public hook "system".
        system_transaction='tavern-system-'+hashlib.sha256(identity.encode()).hexdigest()
        result=await self.client.room_send(room,'m.room.message',notice_content(source),tx_id=system_transaction,ignore_unverified_devices=False)
        if not isinstance(result,RoomSendResponse) or not system_identifier(getattr(result,'event_id',None),'$'):raise RuntimeError('Homeserver did not confirm the encrypted system notice')
        return result.event_id
    async def health(self,request):
        healthy=self.ready and not self.sync_task.done() and not self.worker.done() and not self.system_worker.done() and time.monotonic()-self.last_sync<60
        return web.json_response({'ready':healthy,'configuration':self.configuration},status=200 if healthy else 503)
    async def stop(self):
        self.ready=False
        for task in [self.worker,self.sync_task,self.system_worker]:task.cancel()
        await asyncio.gather(self.worker,self.sync_task,self.system_worker,return_exceptions=True);await self.system_messages.close();await self.client.close();self.db.close();self.lock.close()

async def main():
    bridge=Bridge();await bridge.start();app=web.Application(client_max_size=131072)
    app.router.add_post('/hooks/{hook}',bridge.enqueue);app.router.add_get('/health',bridge.health)
    app.router.add_post('/internal/system-deliveries',bridge.system_messages.enqueue)
    runner=web.AppRunner(app,access_log=None);await runner.setup();await web.TCPSite(runner,'0.0.0.0',8080).start()
    try:
        done,_=await asyncio.wait([bridge.sync_task,bridge.worker,bridge.system_worker],return_when=asyncio.FIRST_COMPLETED)
        for task in done:task.result()
        raise RuntimeError('Background service stopped')
    finally:await runner.cleanup();await bridge.stop()

if __name__=='__main__':
    logging.basicConfig(level=logging.WARNING)
    library_log=logging.getLogger('nio');library_log.handlers=[logging.NullHandler()];library_log.propagate=False
    asyncio.run(main())
