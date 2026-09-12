import importlib.util
from pathlib import Path
import sqlite3
import unittest
from types import SimpleNamespace
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from api.account_deactivation import Deactivations

spec = importlib.util.spec_from_file_location('social', Path(__file__).resolve().parents[1] / 'api/social.py')
social = importlib.util.module_from_spec(spec)
spec.loader.exec_module(social)

class SocialTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:', isolation_level=None)
        self.db.row_factory = sqlite3.Row
        social.ensure_schema(self.db)
        self.addCleanup(self.db.close)

    def test_only_recipient_accepts_or_rejects_and_only_sender_cancels(self):
        row = {'sender': '@a:local', 'target': '@b:local', 'status': 'pending'}
        self.assertTrue(social.authorized_transition(row, '@b:local', 'accept'))
        self.assertTrue(social.authorized_transition(row, '@b:local', 'reject'))
        self.assertFalse(social.authorized_transition(row, '@a:local', 'accept'))
        self.assertFalse(social.authorized_transition(row, '@attacker:local', 'reject'))
        self.assertTrue(social.authorized_transition(row, '@a:local', 'cancel'))
        self.assertFalse(social.authorized_transition(row, '@b:local', 'cancel'))
        row['status'] = 'accepted'
        self.assertFalse(social.authorized_transition(row, '@b:local', 'reject'))

    def test_only_one_active_relationship_per_pair_even_reverse_direction(self):
        self.db.execute('INSERT INTO social_requests VALUES(?,?,?,?,?,?)', ('one', '@a:local', '@b:local', 'pending', 1, 1))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('INSERT INTO social_requests VALUES(?,?,?,?,?,?)', ('two', '@b:local', '@a:local', 'pending', 2, 2))

    def test_snapshot_never_exposes_unrelated_requests_blocks_or_privacy(self):
        self.db.execute('INSERT INTO social_requests VALUES(?,?,?,?,?,?)', ('own', '@a:local', '@b:local', 'pending', 1, 1))
        self.db.execute('INSERT INTO social_requests VALUES(?,?,?,?,?,?)', ('private', '@c:local', '@d:local', 'pending', 2, 2))
        self.db.execute('INSERT INTO social_blocks VALUES(?,?,?)', ('@c:local', '@a:local', 2))
        self.db.execute('INSERT INTO social_preferences VALUES(?,?)', ('@c:local', 'nobody'))
        result = social.snapshot(self.db, '@a:local')
        self.assertEqual([r['id'] for r in result['requests']], ['own'])
        self.assertEqual(result['blocked'], [])
        self.assertEqual(result['privacy'], 'everyone')

class HandlerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db = sqlite3.connect(':memory:', isolation_level=None)
        self.db.row_factory = sqlite3.Row
        class Error(Exception):
            def __init__(self, status, message, *args): self.status, self.message = status, message
        async def body(request): return await request.json()
        social.helpers = lambda: (Error, body)
        self.matrix_writes = []
        self.on_profile = None
        async def matrix(method, path, body=None, token=None, expected=True):
            if method == 'PUT': self.matrix_writes.append((path, body))
            if '/profile/' in path and self.on_profile: self.on_profile()
            result = {'joined_rooms': []} if 'joined_rooms' in path else {'displayname': 'Member'} if '/profile/' in path else {}
            return result if expected else (200, result)
        def session(request):
            if not request.headers.get('Test-Session'):
                raise Error(401, 'Sign in')
            return {'user_id': request.headers['Test-Session'], 'id': 'session', 'token': 'encrypted'}
        service = SimpleNamespace(store=SimpleNamespace(db=self.db, open=lambda t: 'secret-server-token', rate=lambda *args: None), require_session=session, audit=lambda *args: None, matrix=matrix)
        @web.middleware
        async def errors(request, handler):
            try: return await handler(request)
            except Error as e: return web.json_response({'error': e.message}, status=e.status)
        app = web.Application(middlewares=[errors]); app['service'] = service
        service.deactivations = Deactivations(service, app)
        social.register_routes(app)
        self.client = TestClient(TestServer(app)); await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close(); self.db.close()

    async def request(self, method, path='', actor='@alice:local', body=None):
        return await self.client.request(method, '/api/social' + path, headers={'Test-Session': actor} if actor else {}, json=body)

    async def test_friend_code_persists_and_only_recipient_can_accept(self):
        state = await (await self.request('GET', actor='@bob:local')).json()
        code = state['friendCode']
        self.assertRegex(code, r'^TAV-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$')
        self.assertEqual((await (await self.request('GET', actor='@bob:local')).json())['friendCode'], code)
        response = await self.request('POST', '/requests', body={'target': code.lower().replace('-', ' '), 'server': 'https://local/'})
        self.assertEqual(response.status, 201)
        result = await response.json()
        self.assertNotEqual(result['friendCode'], code)
        row = result['requests'][0]
        self.assertEqual(row['target'], '@bob:local')
        self.assertEqual((await self.request('PATCH', '/requests/' + row['id'], body={'operation': 'accept'})).status, 403)
        self.assertEqual((await self.request('PATCH', '/requests/' + row['id'], actor='@bob:local', body={'operation': 'accept'})).status, 200)

    async def test_rotation_revokes_old_code_and_preserves_relationships(self):
        code = (await (await self.request('GET', actor='@bob:local')).json())['friendCode']
        self.assertEqual((await self.request('POST', '/requests', body={'target': code})).status, 201)
        response = await self.request('POST', '/friend-code', actor='@bob:local', body={'previousCode': code})
        self.assertEqual(response.status, 200)
        state = await response.json()
        self.assertNotEqual(state['friendCode'], code)
        self.assertEqual(len(state['requests']), 1)
        self.assertEqual((await self.request('POST', '/friend-code', actor='@bob:local', body={'previousCode': code})).status, 409)
        self.assertEqual((await self.request('POST', '/requests', actor='@carol:local', body={'target': code})).status, 400)
        self.assertEqual((await self.request('POST', '/requests', actor='@carol:local', body={'target': state['friendCode']})).status, 201)

    async def test_codes_do_not_bypass_privacy_blocks_or_account_authority(self):
        code = (await (await self.request('GET', actor='@bob:local')).json())['friendCode']
        self.assertEqual((await self.request('POST', '/friend-code', body={'previousCode': code, 'user_id': '@bob:local'})).status, 409)
        self.assertEqual((await self.request('POST', '/friend-code', actor='', body={'previousCode': code})).status, 401)
        self.assertEqual((await self.request('POST', '/requests', actor='@bob:local', body={'target': code})).status, 400)
        self.assertEqual((await self.request('POST', '/requests', body={'target': code, 'server': 'other.example'})).status, 400)
        await self.request('PUT', '/privacy', actor='@bob:local', body={'requests': 'nobody'})
        self.assertEqual((await self.request('POST', '/requests', body={'target': code})).status, 403)
        await self.request('PUT', '/privacy', actor='@bob:local', body={'requests': 'everyone'})
        await self.request('PUT', '/blocks/@alice:local', actor='@bob:local')
        self.assertEqual((await self.request('POST', '/requests', body={'target': code})).status, 403)
        self.assertEqual(self.db.execute('SELECT count(*) FROM social_requests').fetchone()[0], 0)

    async def test_revocation_during_profile_lookup_prevents_stale_code_use(self):
        code = (await (await self.request('GET', actor='@bob:local')).json())['friendCode']
        self.on_profile = lambda: social.rotate_code(self.db, '@bob:local', code)
        self.assertEqual((await self.request('POST', '/requests', body={'target': code})).status, 409)
        self.assertEqual(self.db.execute('SELECT count(*) FROM social_requests').fetchone()[0], 0)

    async def test_handler_ignores_forged_sender_and_enforces_accept_author(self):
        response = await self.request('POST', '/requests', body={'target': '@bob:local', 'sender': '@mallory:local'})
        self.assertEqual(response.status, 201)
        row = (await response.json())['requests'][0]
        self.assertEqual(row['sender'], '@alice:local')
        response = await self.request('PATCH', '/requests/' + row['id'], body={'operation': 'accept'})
        self.assertEqual(response.status, 403)
        response = await self.request('PATCH', '/requests/' + row['id'], actor='@mallory:local', body={'operation': 'accept'})
        self.assertEqual(response.status, 404)
        response = await self.request('PATCH', '/requests/' + row['id'], actor='@bob:local', body={'operation': 'accept'})
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())['requests'][0]['status'], 'accepted')

    async def test_block_removes_requests_and_updates_real_matrix_ignore_state(self):
        response = await self.request('POST', '/requests', body={'target': '@bob:local'})
        self.assertEqual(response.status, 201)
        response = await self.request('PUT', '/blocks/@alice:local', actor='@bob:local')
        self.assertEqual(response.status, 200)
        state = await response.json(); self.assertEqual(state['requests'], []); self.assertEqual(state['blocked'], ['@alice:local'])
        self.assertIn('m.ignored_user_list', self.matrix_writes[0][0]); self.assertIn('@alice:local', self.matrix_writes[0][1]['ignored_users'])
        response = await self.request('POST', '/requests', body={'target': '@bob:local'})
        self.assertEqual(response.status, 403)

    async def test_privacy_is_checked_server_side_and_missing_session_denied(self):
        response = await self.request('GET', actor=''); self.assertEqual(response.status, 401)
        response = await self.request('PUT', '/privacy', actor='@bob:local', body={'requests': 'shared_server'}); self.assertEqual(response.status, 200)
        response = await self.request('POST', '/requests', body={'target': '@bob:local'}); self.assertEqual(response.status, 403)
        response = await self.request('PUT', '/privacy', actor='@bob:local', body={'requests': 'nobody'}); self.assertEqual(response.status, 200)
        response = await self.request('POST', '/requests', body={'target': '@bob:local'}); self.assertEqual(response.status, 403)

    async def test_concurrent_block_during_profile_lookup_cannot_be_bypassed(self):
        self.on_profile = lambda: self.db.execute('INSERT INTO social_blocks VALUES(?,?,?)', ('@bob:local', '@alice:local', 1))
        response = await self.request('POST', '/requests', body={'target': '@bob:local'}); self.assertEqual(response.status, 403)
        self.assertEqual(self.db.execute('SELECT count(*) FROM social_requests').fetchone()[0], 0)

if __name__ == '__main__': unittest.main()
