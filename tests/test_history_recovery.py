import copy
import re
import time
import unittest
from aiohttp import web
from tests.test_api import AccountAPITests

PACKAGE={'version':1,'backupVersion':'1','publicKey':'a'*43,'salt':'A'*22+'==','iv':'A'*16,'ciphertext':'A'*64}
class EmailHistoryTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown=AccountAPITests.asyncTearDown
    request=AccountAPITests.request
    login=AccountAPITests.login
    async def asyncSetUp(self):
        await AccountAPITests.asyncSetUp(self)
        self.backup={'version':'1','algorithm':'m.megolm_backup.v1.curve25519-aes-sha2','auth_data':{'public_key':'a'*43}}
        async def upstream(request,payload):
            if request.path=='/_matrix/client/v3/room_keys/version':return web.json_response(self.backup)
        self.upstream_response=upstream

    async def enrolled(self):
        cookie,_,_=await self.login()
        self.service.store.db.execute("UPDATE accounts SET email='alice@example.com',verified=1 WHERE user_id='@alice:test'")
        status=await (await self.request('GET','/api/account/history',cookie=cookie)).json()
        response=await self.request('POST','/api/account/history',{'package':PACKAGE,'revision':None,'credentialEpoch':status['credentialEpoch']},cookie)
        self.assertEqual(response.status,200,await response.text())
        return cookie,(await response.json())['revision']

    async def code(self,cookie):
        response=await self.request('POST','/api/account/history/start',{},cookie)
        self.assertEqual(response.status,200,await response.text())
        code=re.search(r'code is (\d{6})',self.service.send_email.call_args.args[2]).group(1)
        return {'challengeId':(await response.json())['challengeId'],'code':code}

    async def test_ciphertext_requires_email_code_and_is_bound_to_one_device(self):
        cookie,revision=await self.enrolled()
        status=await (await self.request('GET','/api/account/history',cookie=cookie)).json()
        self.assertTrue(status['configured']);self.assertNotIn('package',status);self.assertNotIn('ciphertext',str(status))
        code=await self.code(cookie)
        other,_,_=await self.login()
        self.assertEqual((await self.request('POST','/api/account/history/complete',code,other)).status,409)
        response=await self.request('POST','/api/account/history/complete',code,cookie)
        self.assertEqual(response.status,200,await response.text());self.assertEqual((await response.json())['package'],PACKAGE)
        self.assertEqual((await self.request('POST','/api/account/history/complete',code,cookie)).status,400)

    async def test_wrong_codes_are_bounded_and_expired_codes_cannot_release_package(self):
        cookie,_=await self.enrolled();code=await self.code(cookie)
        for _ in range(5):self.assertEqual((await self.request('POST','/api/account/history/complete',{**code,'code':'wrong'},cookie)).status,400)
        self.assertEqual((await self.request('POST','/api/account/history/complete',code,cookie)).status,400)
        code=await self.code(cookie);self.service.store.db.execute('UPDATE challenges SET expires=?',(time.time()-1,))
        self.assertEqual((await self.request('POST','/api/account/history/complete',code,cookie)).status,400)

    async def test_email_password_backup_and_revision_changes_invalidate_release(self):
        cookie,revision=await self.enrolled();code=await self.code(cookie)
        self.service.store.db.execute("UPDATE accounts SET email='new@example.com' WHERE user_id='@alice:test'")
        self.assertEqual((await self.request('POST','/api/account/history/complete',code,cookie)).status,409)
        code=await self.code(cookie);self.service.store.db.execute("UPDATE accounts SET credential_epoch=123 WHERE user_id='@alice:test'")
        self.assertEqual((await self.request('POST','/api/account/history/complete',code,cookie)).status,409)
        self.assertTrue((await (await self.request('GET','/api/account/history',cookie=cookie)).json())['passwordChanged'])
        code=await self.code(cookie);self.backup['version']='2'
        self.assertEqual((await self.request('POST','/api/account/history/complete',code,cookie)).status,409)
        self.backup['version']='1'
        self.service.store.db.execute("UPDATE history_recovery SET revision='changed'")
        self.assertEqual((await self.request('POST','/api/account/history/complete',code,cookie)).status,409)

    async def test_invalid_save_stale_revision_cross_origin_and_missing_session_preserve_package(self):
        cookie,revision=await self.enrolled()
        status=await (await self.request('GET','/api/account/history',cookie=cookie)).json()
        body={'package':PACKAGE,'revision':revision,'credentialEpoch':status['credentialEpoch']}
        self.assertEqual((await self.request('POST','/api/account/history',{**body,'revision':None},cookie)).status,409)
        self.assertEqual((await self.request('POST','/api/account/history',{**body,'package':{**PACKAGE,'plaintext':'no'}},cookie)).status,400)
        self.assertEqual((await self.request('POST','/api/account/history',body,cookie,origin='https://attacker.test')).status,403)
        self.assertEqual((await self.request('POST','/api/account/history/complete',{},cookie=None)).status,401)
        self.assertEqual((await (await self.request('GET','/api/account/history',cookie=cookie)).json())['revision'],revision)

    async def test_password_confirmation_uses_native_login_and_logs_out_its_temporary_device(self):
        cookie,_=await self.enrolled()
        self.assertEqual((await self.request('POST','/api/account/history/password',{'password':'wrong'},cookie)).status,403)
        response=await self.request('POST','/api/account/history/password',{'password':'Correct password!'},cookie)
        self.assertEqual(response.status,200,await response.text());self.assertEqual(set(await response.json()),{'credentialEpoch'})
        self.assertEqual(self.upstream_calls[-1][1],'/_matrix/client/v3/logout')

    async def test_session_revocation_during_native_lookup_never_releases_package(self):
        cookie,_=await self.enrolled();code=await self.code(cookie)
        original=self.service.matrix
        async def revoke(method,path,*args,**kwargs):
            result=await original(method,path,*args,**kwargs)
            if path=='/_matrix/client/v3/room_keys/version':self.service.store.db.execute("DELETE FROM sessions WHERE user_id='@alice:test'")
            return result
        self.service.matrix=revoke
        self.assertEqual((await self.request('POST','/api/account/history/complete',code,cookie)).status,401)

    async def test_unverified_email_and_changed_native_backup_cannot_enroll_or_send_code(self):
        cookie,_=await self.enrolled()
        self.service.store.db.execute("UPDATE accounts SET verified=0 WHERE user_id='@alice:test'")
        self.assertEqual((await self.request('POST','/api/account/history/start',{},cookie)).status,409)
        self.service.store.db.execute("UPDATE accounts SET verified=1 WHERE user_id='@alice:test'")
        self.backup['auth_data']['public_key']='b'*43
        self.assertEqual((await self.request('POST','/api/account/history/start',{},cookie)).status,409)
        self.service.send_email.assert_not_called()
