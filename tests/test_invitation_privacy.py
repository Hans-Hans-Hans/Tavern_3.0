import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from urllib.parse import urlencode

from api.invitation_privacy import POLICY, contact_signature
from synapse_modules.invitation_policy import InvitationPolicy
from tests import test_api as fixture


class InvitationAPITests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.AccountAPITests.asyncSetUp
    asyncTearDown = fixture.AccountAPITests.asyncTearDown
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login

    async def test_setting_uses_only_session_identity_and_preserves_other_account_data(self):
        response = await self.request('GET', '/api/social/invitation-privacy')
        self.assertEqual(response.status, 401)
        cookie, _, _ = await self.login()
        native = self.service.matrix
        stored = {'version': 1, 'anotherPreference': 'preserved'}
        async def matrix(method, path, body=None, token=None, expected=True):
            if path.endswith('/account_data/' + POLICY):
                self.assertIn('/user/%40alice%3Atest/', path)
                if method == 'PUT': stored.clear(); stored.update(body)
                return dict(stored) if expected else (200, dict(stored))
            return await native(method, path, body, token, expected=expected)
        self.service.matrix = matrix
        response = await self.request('GET', '/api/social/invitation-privacy', cookie=cookie)
        self.assertEqual(await response.json(), {'invitations': 'everyone'})
        response = await self.request('PUT', '/api/social/invitation-privacy', {'invitations': 'contacts', 'userId': '@owner:test'}, cookie=cookie)
        self.assertEqual(response.status, 200)
        self.assertEqual(stored, {'version': 1, 'anotherPreference': 'preserved', 'invitations': 'contacts'})
        response = await self.request('PUT', '/api/social/invitation-privacy', {'invitations': 'direct_only'}, cookie=cookie)
        self.assertEqual(response.status, 400)
        self.assertEqual(stored['invitations'], 'contacts')

    async def test_internal_consent_requires_scoped_fresh_signature_and_returns_only_boolean(self):
        sender, recipient = '@bob:test', '@alice:test'
        db = self.service.store.db
        db.execute('INSERT INTO social_requests VALUES(?,?,?,?,?,?)', ('friend', sender, recipient, 'accepted', 1, 1))
        key = b'k' * 32
        path = Path(self.directory.name) / 'privacy.key'; path.write_text(key.hex() + '\n')
        endpoint = '/api/internal/invitation-consent?' + urlencode({'sender': sender, 'recipient': recipient})
        async def consent(timestamp=None, sign_recipient=recipient, signature=None):
            timestamp = timestamp or str(int(time.time()))
            return await self.client.get(endpoint, headers={'X-Tavern-Privacy-Timestamp': timestamp, 'X-Tavern-Privacy-Signature': signature or contact_signature(key, timestamp, sender, sign_recipient)})
        with patch.dict(os.environ, {'PRIVACY_KEY_FILE': str(path)}):
            response = await self.client.get(endpoint); self.assertEqual(response.status, 403)
            response = await consent(str(int(time.time()) - 60)); self.assertEqual(response.status, 403)
            response = await consent(sign_recipient='@owner:test'); self.assertEqual(response.status, 403)
            response = await consent(); self.assertEqual(await response.json(), {'allowed': True})
            db.execute('INSERT INTO social_blocks VALUES(?,?,?)', (sender, recipient, 1))
            response = await consent(); self.assertEqual(await response.json(), {'allowed': False})
            db.execute('DELETE FROM social_blocks')
            db.execute("UPDATE social_requests SET status='removed'")
            response = await consent(); self.assertEqual(await response.json(), {'allowed': False})


class InvitationModuleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.key = b'k' * 32; path = Path(self.directory.name) / 'privacy.key'; path.write_text(self.key.hex())
        self.privacy, self.ignored, self.rooms, self.state = {}, {}, {}, {}
        async def account(user, kind): return self.privacy if kind == POLICY else self.ignored
        async def rooms(user): return self.rooms.get(user, [])
        async def state(room, event_filter=None): return self.state.get(room, {})
        self.api = SimpleNamespace(is_mine=lambda user: user.endswith(':test'), account_data_manager=SimpleNamespace(get_global=account), _store=SimpleNamespace(get_rooms_for_user=rooms), get_room_state=state, http_client=SimpleNamespace(get_json=AsyncMock(return_value={'allowed': True})))
        self.policy = InvitationPolicy({'privacy_api_url': 'http://api:8090', 'privacy_key_file': str(path)}, self.api)
        self.event = SimpleNamespace(type='m.room.member', sender='@bob:test', state_key='@alice:test', content={'membership': 'invite'})

    async def test_everyone_default_nobody_and_ignore_do_not_depend_on_optional_direct_flag(self):
        self.assertTrue(await self.policy.check(self.event))
        self.privacy['invitations'] = 'nobody'
        self.assertFalse(await self.policy.check(self.event))
        self.event.content['is_direct'] = False
        self.assertFalse(await self.policy.check(self.event))
        self.event.content['membership'] = 'join'
        self.assertTrue(await self.policy.check(self.event), 'Existing membership operations remain available')
        self.event.content['membership'] = 'invite'; self.privacy.clear()
        self.ignored['ignored_users'] = {'@bob:test': {}}
        self.assertFalse(await self.policy.check(self.event))

    async def test_contacts_signs_exact_pair_and_fails_closed_on_outage_or_non_boolean(self):
        self.privacy['invitations'] = 'contacts'
        self.assertTrue(await self.policy.check(self.event))
        args = self.api.http_client.get_json.call_args
        self.assertEqual(args.kwargs['args'], {'sender': '@bob:test', 'recipient': '@alice:test'})
        headers = args.kwargs['headers']; timestamp = headers[b'X-Tavern-Privacy-Timestamp'][0].decode()
        self.assertEqual(headers[b'X-Tavern-Privacy-Signature'][0].decode(), contact_signature(self.key, timestamp, '@bob:test', '@alice:test'))
        self.api.http_client.get_json.return_value = {'allowed': 'true'}
        self.assertFalse(await self.policy.check(self.event))
        self.api.http_client.get_json.side_effect = OSError('offline')
        self.assertFalse(await self.policy.check(self.event))

    async def test_shared_server_requires_actual_joined_space_for_both_people(self):
        self.privacy['invitations'] = 'shared_server'
        self.rooms = {'@alice:test': ['!shared:test'], '@bob:test': ['!shared:test']}
        def value(content): return SimpleNamespace(content=content)
        self.state['!shared:test'] = {('m.room.create', ''): value({}), ('m.room.member', '@alice:test'): value({'membership': 'join'}), ('m.room.member', '@bob:test'): value({'membership': 'join'})}
        self.assertFalse(await self.policy.check(self.event), 'An ordinary DM is not a shared server')
        self.state['!shared:test'][('m.room.create', '')].content['type'] = 'm.space'
        self.assertTrue(await self.policy.check(self.event))
        self.state['!shared:test'][('m.room.member', '@bob:test')].content['membership'] = 'leave'
        self.assertFalse(await self.policy.check(self.event))


if __name__ == '__main__': unittest.main()
