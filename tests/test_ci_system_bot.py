"""Portable guard/HTTP tests; actual nio provisioning belongs to isolated CI."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

spec=importlib.util.spec_from_file_location('ci_system_bot',Path(__file__).resolve().parents[1]/'scripts/ci-system-bot.py')
helper=importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)


def prepared():
    return {'runId':'a'*24,'botUserId':helper.BOT,'password':'A deliberate CI password!',
            'serverId':'!server:chat.example.test','channelId':'!channel:chat.example.test',
            'devices':{helper.OWNER:{'ALICE':'A'*43},helper.BOB:{'BOB':'B'*43}}}


class ControllerGuardTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name)
        self.config=self.root/'config'; self.data=self.root/'data'; self.cap=self.root/'capability'
        self.config.mkdir(); self.data.mkdir(); self.cap.write_text('ab'*32)
        patches=[patch.dict(os.environ,{'TAVERN_CI_SMOKE':'true','TAVERN_PUBLIC_URL':helper.ORIGIN}),
                 patch.object(helper,'CONFIG',self.config),patch.object(helper,'DATA',self.data),patch.object(helper,'CAPABILITY',self.cap)]
        for item in patches: item.start(); self.addCleanup(item.stop)
        self.client=TestClient(TestServer(helper.create_app())); await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close(); self.temp.cleanup()

    async def post(self,path,body=None,capability='ab'*32):
        return await self.client.post(path,json={} if body is None else body,headers={'X-Tavern-CI-Capability':capability})

    async def test_helper_health_is_distinct_from_provisioned_or_matrix_ready(self):
        health=await self.client.get('/health')
        self.assertEqual(await health.json(),{'helperReady':True})
        state=await self.post('/status')
        self.assertEqual(await state.json(),{'helperReady':True,'prepared':False,'running':False,'botReady':False,'deliveries':[],'identity':None})
        self.assertEqual((await self.post('/start')).status,409)

    async def test_controls_require_exact_run_capability_and_reject_unknown_fields(self):
        for capability in ('','ab'*31,'é'*64,'ff'*32):
            self.assertEqual((await self.post('/status',capability=capability)).status,403)
        self.assertEqual((await self.post('/status',{'url':'https://outside.example'})).status,400)
        self.assertEqual(list(self.config.iterdir()),[]); self.assertEqual(list(self.data.iterdir()),[])

    async def test_wrong_origin_or_non_ci_startup_is_rejected(self):
        for env in ({'TAVERN_CI_SMOKE':'false'},{'TAVERN_PUBLIC_URL':'https://tavern.hans-homelab.com'}):
            with patch.dict(os.environ,env), self.assertRaises(RuntimeError): helper.create_app()

    async def test_fixture_schema_cannot_choose_other_accounts_urls_rooms_or_extra_pins(self):
        self.assertTrue(helper.valid_prepare(prepared()))
        for change in ({'botUserId':'@user:chat.example.test'},{'serverId':'!server:real.example'},{'channelId':'!server:chat.example.test'},
                       {'runId':'../not-ci'},{'homeserver':'https://outside.example'},{'password':'short'},
                       {'devices':{helper.OWNER:{'A':'A'*43},helper.BOB:{'B':'B'*43,'UNKNOWN':'C'*43}}}):
            body=prepared()|change
            self.assertFalse(helper.valid_prepare(body),change)
            response=await self.post('/prepare',body)
            self.assertEqual(response.status,400,await response.text())
        self.assertEqual(list(self.config.iterdir()),[]); self.assertEqual(list(self.data.iterdir()),[])

    async def test_existing_configuration_and_crypto_store_are_never_replaced(self):
        path=self.config/'session.json'; original=b'{"private":"existing identity"}'; path.write_bytes(original)
        response=await self.post('/prepare',prepared())
        self.assertEqual(response.status,409); self.assertEqual(path.read_bytes(),original)
        path.unlink(); crypto=self.data/'crypto'; crypto.mkdir(); (crypto/'crypto.db').write_bytes(b'existing store')
        response=await self.post('/prepare',prepared())
        self.assertEqual(response.status,409); self.assertEqual((crypto/'crypto.db').read_bytes(),b'existing store')
        self.assertEqual(list(self.config.iterdir()),[])

    async def test_pin_fixture_only_restores_original_owning_browser_fingerprints(self):
        manifest=prepared(); manifest.pop('password'); manifest.update(deviceId='BOT',fingerprint='C'*43)
        (self.data/'ci-system-fixture.json').write_text(json.dumps(manifest))
        config={'homeserver':helper.HOMESERVER,'hooks':{helper.HOOK:{'room_id':manifest['channelId']}},'trusted_devices':manifest['devices'],
                'system_messages':{'api_url':'http://tavern-api:8090','secret_file':'/config/system-messages.hmac'}}
        (self.config/'bot.json').write_text(json.dumps(config))
        disabled=await self.post('/recipient-pins',{'enabled':False}); self.assertEqual(disabled.status,200)
        altered=json.loads((self.config/'bot.json').read_text()); self.assertEqual(altered['trusted_devices'],{helper.OWNER:manifest['devices'][helper.OWNER]})
        restored=await self.post('/recipient-pins',{'enabled':True}); self.assertEqual(restored.status,200)
        self.assertEqual(json.loads((self.config/'bot.json').read_text()),config)
        self.assertEqual((await self.post('/recipient-pins',{'enabled':True,'devices':{'untrusted':'value'}})).status,400)
