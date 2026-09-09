"""Signed ingestion and configuration through real cookie/HTTP/native boundaries."""
import asyncio
import copy
import json
import os
from pathlib import Path
import time
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp import web
from api import system_messages as system
from synapse_modules import tavern_policy as model
from tests import test_api as account_fixture, test_moderation as fixture
from tests.test_system_messages_native import event, states, settings, SERVER, ROOM, OWNER, BOT, ALICE


class SystemMessagesAPITests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.WarningTests.asyncTearDown
    request = fixture.WarningTests.request
    login = fixture.WarningTests.login

    async def asyncSetUp(self):
        await fixture.WarningTests.asyncSetUp(self)
        await self.service.system_messages.close(self.app)
        self.manager=self.service.system_messages
        self.folder=Path(self.directory.name)/'bot'; self.folder.mkdir()
        self.service.integrations.directory=self.folder; self.service.integrations.enabled=True
        (self.folder/'session.json').write_text(json.dumps({'user_id':BOT,'device_id':'BOTDEVICE','access_token':'never-return-bot-token'}))
        (self.folder/'system-messages.hmac').write_text('34'*32)
        self.private_key=Path(self.directory.name)/'native.key'; self.private_key.write_text('12'*32)
        env=patch.dict(os.environ,{'PRIVACY_KEY_FILE':str(self.private_key)}); env.start(); self.addCleanup(env.stop)
        self.users[BOT]={'password':'Correct password!','admin':False,'creation_ts':int(time.time())-86400,'deactivated':False,'is_guest':False,'locked':False,'suspended':False}
        parent,child=states(); self.native={SERVER:parent,ROOM:child}
        for identity,current in self.native.items():
            self.rooms[identity]={'name':'System room','members':{user:'join' for user in (OWNER,ALICE,BOT)},'powers':{'users':{OWNER:100,BOT:50},'users_default':0}}
            self.extra[identity]=[{'type':kind,'state_key':key,'content':value.content,'event_id':value.event_id,'sender':value.sender}
                for (kind,key),value in current.items() if kind not in ('m.room.member','m.room.power_levels','m.room.encryption')]
        self.config={'homeserver':self.config.synapse_url,'hooks':{'notices':{'room_id':ROOM,'allowed_users':[OWNER,ALICE,BOT],'enabled':True,'name':'Server notices','secret_file':'/config/notices.hmac'}},
            'trusted_devices':{},'retired_hooks':[],'system_messages':{'api_url':system.API_ORIGIN,'secret_file':'/config/system-messages.hmac'}}
        self.service.integrations.write(self.config)
        self.owner,_,_=await self.login('owner')
        self.writes=[]
        async def upstream(request,payload):
            if request.method=='PUT' and '/state/'+system.SYSTEM_MESSAGES in request.path:
                self.writes.append(payload)
                previous=next(item for item in self.extra[SERVER] if item['type']==system.SYSTEM_MESSAGES)
                if payload['io.tavern.previous_event']!=previous['event_id']:
                    return web.json_response({'errcode':'M_FORBIDDEN'},status=409)
                previous.update(content=copy.deepcopy(payload),event_id='$saved')
                return web.json_response({'event_id':'$saved'})
        self.upstream_response=upstream

    def source(self,**changes):
        return {'version':1,'eventId':'$join','serverId':SERVER,'configEventId':'$config','channelId':ROOM,'hookId':'notices','userId':ALICE,
                'change':'join','occurredAt':int(time.time()*1000),'audience':[OWNER,ALICE,BOT],**changes}

    async def signed(self,path,data,purpose='system-events',key=None,**changes):
        raw=json.dumps(data,separators=(',',':')).encode()
        headers=system.headers(key or bytes.fromhex('12'*32),purpose,raw)
        headers['Origin']=account_fixture.ORIGIN; headers.update(changes)
        return await self.client.post(path,data=raw,headers=headers)

    async def ingest(self,**changes):
        response=await self.signed('/api/internal/system-events',self.source(**changes))
        self.assertIn(response.status,(200,202),await response.text())
        return self.service.store.db.execute('SELECT * FROM system_message_deliveries ORDER BY created DESC LIMIT 1').fetchone()

    def add_state(self,room,kind,body,key='',identity='$added'):
        self.extra[room]=[item for item in self.extra.get(room,[]) if (item['type'],item['state_key'])!=(kind,key)]
        self.extra[room].append({'type':kind,'state_key':key,'content':body,'event_id':identity,'sender':OWNER})

    def policy(self,send=True):
        return {'version':1,'owner':OWNER,'roles':[{'id':'everyone','name':'Member','position':0,'permissions':['send_messages','manage_messages'] if send else []}],
                'members':{},'overrides':{},'categoryOverrides':{}}

    async def test_signed_ingestion_is_durable_sealed_deduplicated_and_scoped(self):
        first=await self.ingest(); again=await self.ingest()
        self.assertEqual(first['id'],again['id'])
        self.assertNotIn(ALICE,first['envelope'])
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM system_message_deliveries').fetchone()[0],1)
        permission=await self.manager.authorize(first)
        self.assertEqual(permission['audience'],sorted([OWNER,ALICE,BOT]))
        self.assertEqual(permission['botDeviceId'],'BOTDEVICE')
        self.assertEqual(permission['configurationRevision'],self.service.integrations.read()[1])
        self.manager.finish(first['id'],'sent',event='$notice')
        await self.ingest()
        self.assertIsNone(await self.manager.authorize(first))
        self.assertIsNone(self.service.store.db.execute('SELECT envelope FROM system_message_deliveries').fetchone()[0])

    async def test_hmac_purpose_signature_expiry_and_schema_fail_closed(self):
        for kwargs in ({'purpose':'system-authorize'},{'key':bytes.fromhex('99'*32)},{'X-Tavern-System-Signature':'é'*64},{'X-Tavern-System-Timestamp':'1'}):
            response=await self.signed('/api/internal/system-events',self.source(),**kwargs)
            self.assertEqual(response.status,403,await response.text())
        response=await self.signed('/api/internal/system-events',self.source(audience=[OWNER,OWNER]))
        self.assertEqual(response.status,400)
        await self.ingest(occurredAt=1)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM system_message_deliveries').fetchone()[0],0)

    async def test_roleless_creator_settings_work_but_native_threshold_and_malformed_policy_deny(self):
        response=await self.request('GET','/api/servers/'+SERVER+'/system-messages',cookie=self.owner)
        self.assertEqual(response.status,200,await response.text()); value=await response.json()
        self.assertTrue(value['ready']); self.assertEqual(value['destinations'][0]['hookId'],'notices')
        self.assertNotIn('never-return-bot-token',json.dumps(value))
        self.rooms[SERVER]['powers']['events']={system.SYSTEM_MESSAGES:101}
        self.assertEqual((await self.request('GET','/api/servers/'+SERVER+'/system-messages',cookie=self.owner)).status,403)
        self.rooms[SERVER]['powers']['events']={}
        self.add_state(SERVER,model.POLICY,{'version':999})
        self.assertEqual((await self.request('GET','/api/servers/'+SERVER+'/system-messages',cookie=self.owner)).status,403)

    async def test_unexpected_inventory_failure_logs_stage_and_class_without_configuration_or_credentials(self):
        secret = 'never-log-bot-token-or-private-configuration'
        with patch.object(self.service.integrations, 'read', side_effect=TypeError(secret)):
            with self.assertLogs('tavern.system_messages', level='ERROR') as logs:
                response = await self.request('GET', '/api/servers/'+SERVER+'/system-messages', cookie=self.owner)
            body = await response.json()
            self.assertEqual(response.status, 500)
            self.assertEqual(body['errcode'], 'SYSTEM_NOTICES_UNAVAILABLE')
            self.assertEqual(logs.output, ['ERROR:tavern.system_messages:System notice settings failed at read_configuration (TypeError).'])
            self.assertNotIn(secret, json.dumps(body) + '\n'.join(logs.output))
            self.assertNotIn('never-return-bot-token', json.dumps(body) + '\n'.join(logs.output))
        recovered = await self.request('GET', '/api/servers/'+SERVER+'/system-messages', cookie=self.owner)
        self.assertEqual(recovered.status, 200)
        self.assertTrue((await recovered.json())['ready'])
        self.assertEqual(self.writes, [])

    async def test_missing_initial_route_and_bridge_configuration_return_the_real_off_inventory(self):
        self.extra[SERVER] = [item for item in self.extra[SERVER] if item['type'] != system.SYSTEM_MESSAGES]
        self.config.pop('system_messages'); self.config.pop('retired_hooks')
        self.service.integrations.write(self.config)
        response = await self.request('GET', '/api/servers/'+SERVER+'/system-messages', cookie=self.owner)
        self.assertEqual(response.status, 200, await response.text()); data = await response.json()
        self.assertTrue(data['enabled']); self.assertTrue(data['ready'])
        self.assertIsNone(data['settings']); self.assertIsNone(data['eventId'])
        self.assertEqual(data['destinations'], [{'hookId':'notices','roomId':ROOM,'name':'Server notices'}])
        self.assertEqual(data['counts'], {}); self.assertEqual(self.writes, [])

    async def test_configuration_put_is_native_cas_and_exact_confirmation(self):
        data={'settings':settings(**{'io.tavern.previous_event':'$config'}),'confirmation':SERVER}
        wrong=await self.request('PUT','/api/servers/'+SERVER+'/system-messages',{**data,'confirmation':'!wrong:test'},self.owner)
        self.assertEqual(wrong.status,400); self.assertEqual(self.writes,[])
        response=await self.request('PUT','/api/servers/'+SERVER+'/system-messages',data,self.owner)
        self.assertEqual(response.status,200,await response.text()); self.assertEqual((await response.json())['eventId'],'$saved')
        self.assertEqual(self.writes[0],data['settings'])
        stale=await self.request('PUT','/api/servers/'+SERVER+'/system-messages',data,self.owner)
        self.assertEqual(stale.status,409,await stale.text())

    async def test_missing_bot_session_has_honest_inventory_and_can_disable(self):
        (self.folder/'session.json').unlink()
        response=await self.request('GET','/api/servers/'+SERVER+'/system-messages',cookie=self.owner)
        self.assertEqual(response.status,200,await response.text()); self.assertFalse((await response.json())['ready'])
        enabled=await self.request('PUT','/api/servers/'+SERVER+'/system-messages',{'settings':settings(**{'io.tavern.previous_event':'$config'}),'confirmation':SERVER},self.owner)
        self.assertEqual(enabled.status,503)
        disabled=await self.request('PUT','/api/servers/'+SERVER+'/system-messages',{'settings':settings(enabled=False,**{'io.tavern.previous_event':'$config'}),'confirmation':SERVER},self.owner)
        self.assertEqual(disabled.status,200,await disabled.text())

    async def test_current_audience_and_original_space_membership_are_both_required(self):
        row=await self.ingest()
        self.rooms[ROOM]['members']['@stranger:test']='join'
        self.assertIsNone(await self.manager.authorize(row))
        self.rooms[ROOM]['members'].pop('@stranger:test')
        self.rooms[SERVER]['members'][ALICE]='leave'
        self.assertIsNone(await self.manager.authorize(row))
        self.rooms[ROOM]['members'][ALICE]='leave'
        permission=await self.manager.authorize(row)
        self.assertEqual(permission['audience'],sorted([OWNER,BOT]))

    async def test_leave_is_cancelled_when_departed_account_remains_in_destination(self):
        row=await self.ingest(change='leave',audience=[OWNER,BOT])
        self.rooms[SERVER]['members'][ALICE]='leave'
        self.assertIsNone(await self.manager.authorize(row))
        self.rooms[ROOM]['members'][ALICE]='leave'
        self.assertIsNotNone(await self.manager.authorize(row))

    async def test_all_parent_category_and_destination_policies_restrict_bot(self):
        row=await self.ingest()
        self.add_state(SERVER,model.POLICY,self.policy())
        self.assertIsNotNone(await self.manager.authorize(row))
        self.add_state(ROOM,model.POLICY,self.policy(False))
        self.assertIsNone(await self.manager.authorize(row))
        self.add_state(ROOM,model.POLICY,self.policy())
        ancestor='!ancestor:test'
        self.rooms[ancestor]={'name':'Ancestor','members':{BOT:'join'},'powers':{'users':{OWNER:100}}}
        self.add_state(ancestor,'m.room.create',{'type':'m.space','m.federate':False})
        self.add_state(ancestor,'m.space.child',{'via':['test']},key=SERVER)
        self.add_state(ancestor,model.POLICY,self.policy(False))
        self.add_state(SERVER,'m.space.parent',{'canonical':True,'via':['test']},key=ancestor)
        self.assertIsNone(await self.manager.authorize(row))
        self.add_state(ancestor,model.POLICY,self.policy())
        self.assertIsNotNone(await self.manager.authorize(row))
        self.add_state(ancestor,'m.space.parent',{'canonical':True,'via':['test']},key=SERVER)
        self.add_state(SERVER,'m.space.child',{'via':['test']},key=ancestor)
        self.assertIsNone(await self.manager.authorize(row))

    async def test_suspension_native_power_and_route_revision_cancel_delivery(self):
        row=await self.ingest()
        self.users[BOT]['suspended']=True
        with self.assertRaises(system.APIError): await self.manager.authorize(row)
        self.users[BOT]['suspended']=False
        self.rooms[ROOM]['powers']['events']={'m.room.encrypted':51}
        self.assertIsNone(await self.manager.authorize(row))
        self.rooms[ROOM]['powers']['events']={}
        self.add_state(SERVER,system.SYSTEM_MESSAGES,settings(),identity='$changed')
        self.assertIsNone(await self.manager.authorize(row))

    async def test_changes_during_native_availability_wait_are_rechecked(self):
        row=await self.ingest(); original=self.service.matrix
        async def changed(method,path,body=None,token=None,expected=True):
            result=await original(method,path,body,token,expected)
            if '/_synapse/admin/v2/users/' in path and 'bot' in path:
                self.rooms[ROOM]['members']['@new:test']='join'
            return result
        self.service.matrix=changed
        self.assertIsNone(await self.manager.authorize(row))

    async def test_suspension_during_final_scope_refresh_cannot_authorize_bot(self):
        row=await self.ingest(); original=self.service.matrix
        account_seen=False
        async def changed(method,path,body=None,token=None,expected=True):
            nonlocal account_seen
            result=await original(method,path,body,token,expected)
            if '/_synapse/admin/v2/users/' in path and 'bot' in path: account_seen=True
            elif account_seen and path.endswith('/state'): self.users[BOT]['suspended']=True
            return result
        self.service.matrix=changed
        self.assertIsNone(await self.manager.authorize(row))
        self.assertTrue(self.users[BOT]['suspended'])

    async def test_email_verification_revoked_during_scope_refresh_cannot_authorize_bot(self):
        await self.login('bot')
        self.service.store.db.execute('UPDATE accounts SET email=?,verified=1 WHERE user_id=?',('bot@example.test',BOT))
        self.add_state(SERVER,'io.tavern.server.eligibility',{'version':1,'requireVerifiedEmail':True,'minimumAccountAgeSeconds':0,'io.tavern.previous_event':None})
        row=await self.ingest()
        self.assertIsNotNone(await self.manager.authorize(row))
        original=self.service.matrix; eligibility=system.require_room_eligibility; checked=False
        async def require(*args):
            nonlocal checked
            await eligibility(*args)
            checked=True
        async def changed(method,path,body=None,token=None,expected=True):
            result=await original(method,path,body,token,expected)
            if checked and path.endswith('/state'):
                self.service.store.db.execute('UPDATE accounts SET verified=0 WHERE user_id=?',(BOT,))
            return result
        self.service.matrix=changed
        with patch.object(system,'require_room_eligibility',require):
            self.assertIsNone(await self.manager.authorize(row))
        self.assertFalse(system.account_status(self.service,BOT)['emailVerified'])

    async def test_malformed_bot_session_json_has_recoverable_unconfigured_inventory(self):
        for invalid in (None,[],{'user_id':BOT,'device_id':'x'*256}):
            (self.folder/'session.json').write_text(json.dumps(invalid))
            response=await self.request('GET','/api/servers/'+SERVER+'/system-messages',cookie=self.owner)
            self.assertEqual(response.status,200,await response.text())
            self.assertFalse((await response.json())['ready'])

    async def test_logout_during_streamed_settings_body_cannot_write_or_create_bridge(self):
        started,release=asyncio.Event(),asyncio.Event()
        data=json.dumps({'settings':settings(**{'io.tavern.previous_event':'$config'}),'confirmation':SERVER}).encode()
        async def chunks():
            yield data[:10]; started.set(); await release.wait(); yield data[10:]
        device=self.service.store.db.execute('SELECT device_id FROM sessions WHERE cookie_hash=?',(self.service.store.digest(self.owner),)).fetchone()[0]
        task=asyncio.create_task(self.client.put('/api/servers/'+SERVER+'/system-messages',data=chunks(),headers={'Content-Type':'application/json','Origin':account_fixture.ORIGIN,'Cookie':account_fixture.COOKIE+'='+self.owner,'Authorization':'Bearer cookie-session:'+device}))
        await started.wait(); await self.request('POST','/api/auth/logout',{},self.owner); release.set()
        response=await task
        self.assertEqual(response.status,401,await response.text()); self.assertEqual(self.writes,[])

    async def test_worker_reconciles_durable_bot_ack_and_wipes_cancelled_payload(self):
        row=await self.ingest()
        self.manager.request_bot=AsyncMock(return_value={'status':'pending','eventId':''})
        await self.manager.sweep()
        self.assertEqual(self.service.store.db.execute('SELECT status FROM system_message_deliveries').fetchone()[0],'pending')
        self.service.store.db.execute('UPDATE system_message_deliveries SET next_attempt=0')
        self.manager.request_bot.return_value={'status':'sent','eventId':'$notice'}
        await self.manager.sweep()
        record=self.service.store.db.execute('SELECT status,sent_event,envelope FROM system_message_deliveries').fetchone()
        self.assertEqual(tuple(record),('sent','$notice',None))
        await self.ingest(eventId='$another'); self.service.integrations.enabled=False
        await self.manager.sweep()
        record=self.service.store.db.execute("SELECT status,reason,envelope FROM system_message_deliveries WHERE event_id='$another'").fetchone()
        self.assertEqual(tuple(record),('cancelled','disabled',None))

    async def test_worker_recovers_after_transient_sweep_failure_and_stops_cleanly(self):
        recovered=asyncio.Event(); calls=0
        async def sweep():
            nonlocal calls
            calls+=1
            if calls==1: raise OSError('private database details must not enter logs')
            recovered.set()
        self.manager.sweep=sweep
        with patch.object(system,'SWEEP_INTERVAL',0.001), self.assertLogs(system.LOG,level='WARNING') as captured:
            await self.manager.start(self.app)
            await asyncio.wait_for(recovered.wait(),1)
            self.assertFalse(self.manager.worker.done())
            await self.manager.close(self.app)
        self.assertGreaterEqual(calls,2)
        self.assertNotIn('private database',str(captured.output))
        self.assertTrue(self.manager.worker.cancelled())

    async def test_bot_authorization_route_requires_own_signing_purpose_and_hides_payload(self):
        row=await self.ingest()
        response=await self.signed('/api/internal/system-deliveries/authorize',{'id':row['id']},purpose='system-authorize',key=bytes.fromhex('34'*32))
        self.assertEqual(response.status,200,await response.text()); value=await response.json()
        self.assertIs(value['allow'],True); self.assertNotIn('source',value)
        wrong=await self.signed('/api/internal/system-deliveries/authorize',{'id':row['id']},key=bytes.fromhex('34'*32))
        self.assertEqual(wrong.status,403)

    async def test_exact_signed_internal_post_needs_no_cookie_or_browser_origin(self):
        from synapse_modules.server_system_messages import signed_headers
        # The API authenticates the exact transmitted bytes; canonicaljson is
        # a Synapse runtime dependency, not an API-test dependency.
        raw=json.dumps(self.source(), sort_keys=True, separators=(',', ':')).encode()
        headers={key.decode():values[0].decode() for key,values in signed_headers(bytes.fromhex('12'*32),'system-events',raw).items()}
        response=await self.client.post('/api/internal/system-events',data=raw,headers=headers)
        self.assertEqual(response.status,202,await response.text())
        self.assertNotIn('Set-Cookie',response.headers)
        for path in ('/api/internal/system-events/','/api/servers/'+SERVER+'/system-messages'):
            response=await self.client.put(path,data=raw,headers=headers)
            self.assertEqual(response.status,403)
