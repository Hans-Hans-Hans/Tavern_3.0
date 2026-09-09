"""Run with the integration requirements installed; performs no network requests."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'integrations'))
try:
    import server
    from nio import AsyncClient,AsyncClientConfig
    from nio.store import SqliteStore
except ImportError:
    server=None

@unittest.skipIf(server is None,'Install integrations/requirements.txt to test the durable bot store')
class BotStore(unittest.IsolatedAsyncioTestCase):
    async def test_identity_and_encrypted_outbox_survive_reopen(self):
        import hashlib,hmac,time
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);config=root/'config';data=root/'data';config.mkdir();(data/'crypto').mkdir(parents=True)
            (config/'pickle.key').write_text('test-only-pickle-key');(config/'queue.key').write_text('ab'*32);(config/'builds.hmac').write_text('x'*32)
            settings={'homeserver':'https://example.invalid','hooks':{'builds':{'room_id':'!test:example.invalid','allowed_users':['@bot:example.invalid'],'secret_file':'/config/builds.hmac'}},'trusted_devices':{}}
            (config/'bot.json').write_text(json.dumps(settings));session={'user_id':'@bot:example.invalid','device_id':'TEST','access_token':'test-only'};(config/'session.json').write_text(json.dumps(session))
            c=AsyncClient(settings['homeserver'],user=session['user_id'],device_id='TEST',store_path=str(data/'crypto'),config=AsyncClientConfig(store=SqliteStore,store_name='crypto.db',encryption_enabled=True,pickle_key='test-only-pickle-key'))
            c.restore_login(session['user_id'],'TEST','test-only');fingerprint=c.olm.account.identity_keys['ed25519'];await c.close()
            (data/'identity.json').write_text(json.dumps({'user_id':session['user_id'],'device_id':'TEST','ed25519':fingerprint}))
            server.DATA=data;server.CONFIG=config/'bot.json';bridge=server.Bridge()
            body=b'{"text":"sensitive build result"}';stamp=str(int(time.time()));delivery='12345678-1234-4234-8234-123456789abc'
            signature='sha256='+hmac.new(b'x'*32,b'v1\nbuilds\n'+stamp.encode()+b'\n'+delivery.encode()+b'\n'+body,hashlib.sha256).hexdigest()
            class Request:
                match_info={'hook':'builds'};content_type='application/json';headers={'X-Tavern-Timestamp':stamp,'X-Tavern-Delivery':delivery,'X-Tavern-Signature':signature}
                async def read(self):return body
            self.assertEqual((await bridge.enqueue(Request())).status,202)
            self.assertEqual((await bridge.enqueue(Request())).status,200)
            self.assertEqual(bridge.db.execute('SELECT COUNT(*) FROM deliveries').fetchone()[0],1)
            ciphertext=bridge.db.execute('SELECT payload FROM deliveries').fetchone()[0];self.assertNotIn(b'sensitive',ciphertext)
            await bridge.client.close();bridge.db.close();bridge.lock.close()
            reopened=server.Bridge();self.assertEqual(reopened.client.olm.account.identity_keys['ed25519'],fingerprint);self.assertEqual(reopened.db.execute('SELECT COUNT(*) FROM deliveries').fetchone()[0],1)
            (config/'rotated.hmac').write_text('y'*32);settings['hooks']['builds']['secret_file']='/config/rotated.hmac';(config/'bot.json').write_text(json.dumps(settings))
            with self.assertRaises(server.web.HTTPUnauthorized):await reopened.enqueue(Request())
            settings['hooks']={};(config/'bot.json').write_text(json.dumps(settings));reopened.reload_configuration()
            row=reopened.db.execute('SELECT status,payload FROM deliveries').fetchone();self.assertEqual(row,('cancelled',None))
            await reopened.client.close();reopened.db.close();reopened.lock.close()
