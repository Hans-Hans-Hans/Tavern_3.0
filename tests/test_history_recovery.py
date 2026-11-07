import copy
import re
import time
import unittest
from aiohttp import web
from tests.test_api import AccountAPITests
from api.security import totp

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

    async def test_passphrase_package_follows_account_without_verified_email_or_smtp(self):
        cookie, _, _ = await self.login()
        self.service.store.set('smtp', {'enabled': False})
        self.service.store.db.execute("UPDATE accounts SET verified=0 WHERE user_id='@alice:test'")
        saved = await self.request('POST', '/api/account/history/passphrase', {'package': PACKAGE, 'revision': None}, cookie)
        self.assertEqual(saved.status, 200, await saved.text())
        # A different login/device retrieves the same encrypted account package.
        other, _, _ = await self.login()
        status = await (await self.request('GET', '/api/account/history', cookie=other)).json()
        self.assertEqual(status['mode'], 'passphrase')
        self.assertTrue(status['passphraseConfigured'])
        self.assertFalse(status['setupRequired'])
        self.assertNotIn('package', status)
        restored = await self.request('GET', '/api/account/history/passphrase', cookie=other)
        self.assertEqual(restored.status, 200, await restored.text())
        self.assertEqual((await restored.json())['package'], PACKAGE)
        owner, _, _ = await self.login('owner')
        self.assertEqual((await self.request('GET', '/api/account/history/passphrase', cookie=owner)).status, 409)
        self.assertEqual((await self.request('GET', '/api/account/history/passphrase')).status, 401)
        self.service.send_email.assert_not_called()

    async def test_off_is_account_wide_and_preserves_packages_but_blocks_release(self):
        cookie, _ = await self.enrolled()
        code = await self.code(cookie)
        await self.request('POST', '/api/account/history/passphrase', {'package': PACKAGE, 'revision': None}, cookie)
        disabled = await self.request('POST', '/api/account/history/options', {'mode': 'off'}, cookie)
        self.assertEqual(disabled.status, 200)
        other, _, _ = await self.login()
        status = await (await self.request('GET', '/api/account/history', cookie=other)).json()
        self.assertEqual(status['mode'], 'off')
        self.assertTrue(status['configured'])
        self.assertTrue(status['passphraseConfigured'])
        self.assertEqual((await self.request('POST', '/api/account/history/complete', code, cookie)).status, 409)
        self.assertEqual((await self.request('POST', '/api/account/history/start', {}, other)).status, 409)
        self.assertEqual((await self.request('GET', '/api/account/history/passphrase', cookie=other)).status, 409)
        await self.request('POST', '/api/account/history/options', {'mode': 'passphrase'}, other)
        self.assertEqual((await self.request('GET', '/api/account/history/passphrase', cookie=other)).status, 200)

    async def test_passphrase_save_checks_revision_backup_session_and_origin(self):
        cookie, _, _ = await self.login()
        body = {'package': PACKAGE, 'revision': None}
        first = await self.request('POST', '/api/account/history/passphrase', body, cookie)
        self.assertEqual(first.status, 200)
        revision = (await first.json())['revision']
        self.assertEqual((await self.request('POST', '/api/account/history/passphrase', body, cookie)).status, 409)
        body['revision'] = revision
        self.assertEqual((await self.request('POST', '/api/account/history/passphrase', body, cookie, origin='https://evil.test')).status, 403)
        self.backup['version'] = '2'
        self.assertEqual((await self.request('POST', '/api/account/history/passphrase', body, cookie)).status, 409)
        self.assertEqual((await self.request('GET', '/api/account/history/passphrase', cookie=cookie)).status, 409)

    async def test_operator_prompt_waits_for_next_login_and_does_not_change_other_accounts(self):
        from api.configure_history import configure
        cookie, _ = await self.enrolled()
        configure(self.service.store, 'alice', disable_email=True)
        current = await (await self.request('GET', '/api/account/history', cookie=cookie)).json()
        self.assertEqual(current['mode'], 'off')
        self.assertFalse(current['setupRequired'])
        other, _, _ = await self.login()
        status = await (await self.request('GET', '/api/account/history', cookie=other)).json()
        self.assertTrue(status['setupRequired'])
        self.assertFalse(status['emailReady'])
        self.assertTrue(status['configured'])
        self.assertFalse(self.service.smtp()['enabled'])
        with self.assertRaises(ValueError):
            configure(self.service.store, 'missing')
        await self.request('POST', '/api/account/history/passphrase', {'package': PACKAGE, 'revision': None}, other)
        self.assertFalse((await (await self.request('GET', '/api/account/history', cookie=other)).json())['setupRequired'])

    async def test_disabled_email_cannot_enroll_or_send_but_can_select_passphrase(self):
        cookie, _ = await self.enrolled()
        self.service.store.set('smtp', {'enabled': False})
        self.assertEqual((await self.request('POST', '/api/account/history/options', {'mode': 'email'}, cookie)).status, 409)
        self.assertEqual((await self.request('POST', '/api/account/history/options', {'mode': 'passphrase'}, cookie)).status, 200)
        self.assertEqual((await self.request('POST', '/api/account/history/start', {}, cookie)).status, 409)
        self.service.send_email.assert_not_called()

    def authenticator(self):
        secret = 'JBSWY3DPEHPK3PXP'
        self.service.store.db.execute("UPDATE accounts SET totp=?,totp_counter=-1 WHERE user_id='@alice:test'", (self.service.store.seal(secret),))
        return totp(secret, int(time.time() // 30))

    async def factor_challenge(self, cookie, method, purpose):
        response = await self.request('POST', '/api/account/history/factor/start', {'method': method, 'purpose': purpose}, cookie)
        self.assertEqual(response.status, 200, await response.text())
        code = self.authenticator() if method == 'totp' else re.search(r'code is (\d{6})', self.service.send_email.call_args.args[2]).group(1)
        return {'method': method, 'challengeId': (await response.json())['challengeId'], 'code': code}

    async def factor_enrolled(self, method='totp'):
        cookie, _, _ = await self.login()
        if method == 'totp':
            self.authenticator()
            self.service.store.set('smtp', {'enabled': False})
        else:
            self.service.store.db.execute("UPDATE accounts SET email='alice@example.com',verified=1 WHERE user_id='@alice:test'")
        challenge = await self.factor_challenge(cookie, method, 'save')
        response = await self.request('POST', '/api/account/history/factor/save', {
            **challenge, 'password': 'Correct password!', 'package': PACKAGE, 'wrappingSecret': 'A'*43+'=', 'revision': None}, cookie)
        self.assertEqual(response.status, 200, await response.text())
        return cookie, (await response.json())['revision']

    async def test_authenticator_without_email_unlocks_same_history_on_new_device_and_rejects_replay(self):
        cookie, revision = await self.factor_enrolled()
        login = await (await self.request('POST', '/api/auth/login', {'username': 'alice', 'password': 'Correct password!'})).json()
        from api.server import COOKIE
        self.service.store.db.execute("UPDATE accounts SET totp_counter=-1 WHERE user_id='@alice:test'")
        response = await self.request('POST', '/api/auth/mfa', {'challengeId': login['challengeId'], 'method': 'totp', 'code': self.authenticator()})
        self.assertEqual(response.status, 200, await response.text())
        other = response.cookies[COOKIE].value
        status = await (await self.request('GET', '/api/account/history', cookie=other)).json()
        self.assertEqual(status['methods'], ['totp'])
        self.assertTrue(status['factorConfigured']['totp'])
        self.assertNotIn('wrappingSecret', str(status))
        self.assertNotIn('ciphertext', str(status))
        code = await self.factor_challenge(other, 'totp', 'recover')
        # Simulate advancing to a fresh OTP after enrollment.
        self.service.store.db.execute("UPDATE accounts SET totp_counter=-1 WHERE user_id='@alice:test'")
        response = await self.request('POST', '/api/account/history/factor/complete', code, other)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())['package'], PACKAGE)
        self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', code, other)).status, 400)
        next_code = await self.request('POST', '/api/account/history/factor/start', {'method': 'totp', 'purpose': 'recover'}, other)
        challenge = (await next_code.json())['challengeId']
        self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', {**code, 'challengeId': challenge}, other)).status, 400)
        self.service.send_email.assert_not_called()

    async def test_email_factor_releases_without_history_or_old_account_password(self):
        cookie, _ = await self.factor_enrolled('email')
        self.service.store.db.execute("UPDATE accounts SET credential_epoch=123 WHERE user_id='@alice:test'")
        code = await self.factor_challenge(cookie, 'email', 'recover')
        response = await self.request('POST', '/api/account/history/factor/complete', code, cookie)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())['wrappingSecret'], 'A'*43+'=')
        self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', code, cookie)).status, 400)

    async def test_methods_coexist_and_disabling_one_preserves_other_methods_and_packages(self):
        cookie, _ = await self.factor_enrolled('email')
        saved = await self.request('POST', '/api/account/history/passphrase', {'package': PACKAGE, 'revision': None}, cookie)
        self.assertEqual(saved.status, 200)
        status = await (await self.request('GET', '/api/account/history', cookie=cookie)).json()
        self.assertEqual(set(status['methods']), {'email', 'passphrase'})
        self.assertEqual((await self.request('GET', '/api/account/history/passphrase', cookie=cookie)).status, 200)
        code = await self.factor_challenge(cookie, 'email', 'recover')
        await self.request('POST', '/api/account/history/options', {'methods': ['passphrase']}, cookie)
        self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', code, cookie)).status, 409)
        self.assertEqual((await self.request('GET', '/api/account/history/passphrase', cookie=cookie)).status, 200)
        status = await (await self.request('POST', '/api/account/history/options', {'methods': []}, cookie)).json()
        self.assertTrue(status['factorConfigured']['email'])
        self.assertTrue(status['passphraseConfigured'])
        self.assertEqual(status['mode'], 'off')

    async def test_all_three_methods_coexist_and_totp_survives_email_and_passphrase_removal(self):
        cookie, _ = await self.factor_enrolled('email')
        self.authenticator()
        challenge = await self.factor_challenge(cookie, 'totp', 'save')
        saved = await self.request('POST', '/api/account/history/factor/save', {
            **challenge, 'password': 'Correct password!', 'package': PACKAGE, 'wrappingSecret': 'A'*43+'=', 'revision': None}, cookie)
        self.assertEqual(saved.status, 200, await saved.text())
        await self.request('POST', '/api/account/history/passphrase', {'package': PACKAGE, 'revision': None}, cookie)
        status = await (await self.request('GET', '/api/account/history', cookie=cookie)).json()
        self.assertEqual(set(status['methods']), {'email', 'totp', 'passphrase'})
        self.service.store.set('smtp', {'enabled': False})
        # A mail outage must not prevent retaining email while managing other methods.
        self.assertEqual((await self.request('POST', '/api/account/history/options', {'methods': ['totp', 'email', 'passphrase']}, cookie)).status, 200)
        challenge = await self.factor_challenge(cookie, 'totp', 'recover')
        self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', challenge, cookie)).status, 200)
        self.assertEqual((await self.request('POST', '/api/account/history/options', {'methods': ['totp']}, cookie)).status, 200)
        self.assertEqual((await self.request('GET', '/api/account/history/passphrase', cookie=cookie)).status, 409)
        challenge = await self.factor_challenge(cookie, 'totp', 'recover')
        self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', challenge, cookie)).status, 200)
        status = await (await self.request('GET', '/api/account/history', cookie=cookie)).json()
        self.assertTrue(status['factorConfigured']['email'])
        self.assertTrue(status['passphraseConfigured'])

    async def test_fifth_correct_email_code_is_accepted_but_a_replaced_authenticator_is_not(self):
        cookie, _ = await self.factor_enrolled('email')
        code = await self.factor_challenge(cookie, 'email', 'recover')
        for _ in range(4):
            self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', {**code, 'code': 'invalid'}, cookie)).status, 400)
        self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', code, cookie)).status, 200)
        self.authenticator()
        challenge = await self.factor_challenge(cookie, 'totp', 'save')
        saved = await self.request('POST', '/api/account/history/factor/save', {
            **challenge, 'password': 'Correct password!', 'package': PACKAGE, 'wrappingSecret': 'A'*43+'=', 'revision': None}, cookie)
        self.assertEqual(saved.status, 200, await saved.text())
        self.service.store.db.execute("UPDATE accounts SET totp=? WHERE user_id='@alice:test'", (self.service.store.seal('KRSXG5DSNFXGOIDB'),))
        self.assertEqual((await self.request('POST', '/api/account/history/factor/start', {'method': 'totp', 'purpose': 'recover'}, cookie)).status, 409)

    async def test_factor_is_device_bound_and_checks_email_backup_epoch_origin_and_session(self):
        cookie, _ = await self.factor_enrolled('email')
        code = await self.factor_challenge(cookie, 'email', 'recover')
        other, _, _ = await self.login()
        self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', code, other)).status, 409)
        self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', code, cookie, origin='https://attacker.test')).status, 403)
        self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', code)).status, 401)
        self.backup['version'] = '2'
        self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', code, cookie)).status, 409)
        self.backup['version'] = '1'
        self.service.store.db.execute("UPDATE accounts SET credential_epoch=123 WHERE user_id='@alice:test'")
        self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', code, cookie)).status, 409)
        self.service.store.db.execute("UPDATE accounts SET email='changed@example.com' WHERE user_id='@alice:test'")
        self.assertEqual((await self.request('POST', '/api/account/history/factor/start', {'method': 'email', 'purpose': 'recover'}, cookie)).status, 409)

    async def test_factor_save_requires_password_code_valid_revision_and_matching_native_backup(self):
        cookie, _, _ = await self.login()
        self.authenticator()
        code = await self.factor_challenge(cookie, 'totp', 'save')
        body = {**code, 'password': 'wrong', 'package': PACKAGE, 'wrappingSecret': 'A'*43+'=', 'revision': None}
        self.assertEqual((await self.request('POST', '/api/account/history/factor/save', body, cookie)).status, 403)
        self.assertEqual((await self.request('POST', '/api/account/history/factor/save', {**body, 'password': 'Correct password!', 'code': 'invalid'}, cookie)).status, 400)
        self.backup['version'] = '2'
        self.assertEqual((await self.request('POST', '/api/account/history/factor/save', {**body, 'password': 'Correct password!'}, cookie)).status, 409)
        status = await (await self.request('GET', '/api/account/history', cookie=cookie)).json()
        self.assertFalse(status['factorConfigured']['totp'])

    async def test_wrong_expired_codes_and_removed_authenticator_cannot_release_history(self):
        cookie, _ = await self.factor_enrolled()
        code = await self.factor_challenge(cookie, 'totp', 'recover')
        for _ in range(5):
            self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', {**code, 'code': 'invalid'}, cookie)).status, 400)
        self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', code, cookie)).status, 400)
        code = await self.factor_challenge(cookie, 'totp', 'recover')
        self.service.store.db.execute('UPDATE challenges SET expires=? WHERE id=?', (time.time()-1, code['challengeId']))
        self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', code, cookie)).status, 400)
        self.service.store.db.execute("UPDATE accounts SET totp=NULL WHERE user_id='@alice:test'")
        self.assertEqual((await self.request('POST', '/api/account/history/factor/start', {'method': 'totp', 'purpose': 'recover'}, cookie)).status, 409)

    async def test_revocation_during_factor_native_lookup_prevents_key_release(self):
        cookie, _ = await self.factor_enrolled('email')
        code = await self.factor_challenge(cookie, 'email', 'recover')
        original = self.service.matrix
        async def revoke(method, path, *args, **kwargs):
            result = await original(method, path, *args, **kwargs)
            if path == '/_matrix/client/v3/room_keys/version':
                self.service.store.db.execute("DELETE FROM sessions WHERE user_id='@alice:test'")
            return result
        self.service.matrix = revoke
        self.assertEqual((await self.request('POST', '/api/account/history/factor/complete', code, cookie)).status, 401)
