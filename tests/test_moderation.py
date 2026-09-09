import copy
from pathlib import Path
import shutil
import sys
import unittest

from api.room_authority import policy_model
from tests import test_api as fixture


class WarningTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.AccountAPITests.asyncTearDown
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login

    async def asyncSetUp(self):
        await fixture.AccountAPITests.asyncSetUp(self)
        self.extra = {}
        original = self.service.matrix
        async def matrix(method, path, body=None, token=None, expected=True):
            value = await original(method, path, body, token, expected)
            if path.startswith('/_synapse/admin/v1/rooms/') and path.endswith('/state'):
                from urllib.parse import unquote
                identity = unquote(path.removeprefix('/_synapse/admin/v1/rooms/').removesuffix('/state'))
                if expected: value['state'].extend(copy.deepcopy(self.extra.get(identity, [])))
            return value
        self.service.matrix = matrix

    async def issue(self, cookie, target='@alice:test', **changes):
        return await self.request('POST', '/api/moderation/warnings', {'roomId': '!room:test', 'targetId': target, 'confirmation': target, 'reason': 'Private behavior guidance', **changes}, cookie)

    def managed(self, parent='!server:test'):
        policy = {'version': 1, 'owner': '@serverowner:test', 'roles': [{'id': 'everyone', 'name': 'Member', 'position': 0, 'permissions': []}, {'id': 'moderator', 'name': 'Moderator', 'position': 10, 'permissions': ['manage_messages']}], 'members': {'@owner:test': ['moderator']}, 'overrides': {}, 'categoryOverrides': {}}
        self.rooms[parent] = {'name': 'Server', 'members': {'@owner:test': 'join', '@alice:test': 'join'}, 'powers': {'users': {'@owner:test': 50}, 'users_default': 0}}
        self.extra.setdefault('!room:test', []).append({'type': 'm.space.parent', 'state_key': parent, 'content': {'canonical': True, 'via': ['test']}})
        self.extra[parent] = [{'type': 'm.space.child', 'state_key': '!room:test', 'content': {'via': ['test']}}, {'type': 'io.tavern.roles', 'state_key': '', 'content': policy}]
        return policy

    async def test_private_warning_delivery_encryption_read_state_and_withdrawal(self):
        owner, _, _ = await self.login('owner'); alice, _, _ = await self.login()
        result = await self.issue(owner); self.assertEqual(result.status, 201, await result.text()); warning = await result.json()
        raw = self.service.store.db.execute('SELECT reason FROM moderation_warnings').fetchone()[0]; self.assertNotIn('behavior guidance', raw)
        self.assertNotIn('behavior guidance', str(list(self.service.store.db.execute('SELECT detail FROM audit'))))
        mine = await (await self.request('GET', '/api/moderation/warnings/mine', cookie=alice)).json()
        self.assertEqual(mine['unread'], 1); self.assertEqual(mine['warnings'][0]['reason'], 'Private behavior guidance')
        self.assertEqual((await self.request('POST', '/api/moderation/warnings/read', {'throughId': warning['id']}, owner)).status, 404)
        self.assertEqual((await self.request('POST', '/api/moderation/warnings/read', {'throughId': warning['id']}, alice)).status, 200)
        mine = await (await self.request('GET', '/api/moderation/warnings/mine', cookie=alice)).json(); self.assertEqual(mine['unread'], 0); self.assertTrue(mine['warnings'][0]['read'])
        self.rooms['!room:test']['members']['@alice:test'] = 'leave'
        self.assertEqual((await self.request('GET', '/api/moderation/warnings/mine', cookie=alice)).status, 200)
        result = await self.request('POST', '/api/moderation/warnings/' + str(warning['id']) + '/withdraw', {'confirmation': '@alice:test'}, owner)
        self.assertEqual(result.status, 200); self.assertEqual((await result.json())['status'], 'withdrawn')
        self.assertFalse(any('send/' in path or '/state/io.tavern.warning' in path for _, path, _, _ in self.upstream_calls))

    async def test_admin_does_not_bypass_membership_native_power_or_equal_rank(self):
        owner, _, _ = await self.login('owner'); alice, _, _ = await self.login()
        self.assertEqual((await self.issue(owner, '@owner:test')).status, 403)
        self.assertEqual((await self.issue(alice, '@owner:test')).status, 403)
        self.rooms['!room:test']['powers']['users']['@owner:test'] = 50
        self.assertEqual((await self.issue(owner)).status, 403)
        self.rooms['!room:test']['powers']['users']['@owner:test'] = 100
        self.rooms['!room:test']['members']['@owner:test'] = 'leave'
        self.assertEqual((await self.issue(owner)).status, 403)
        self.assertEqual((await self.request('GET', '/api/moderation/warnings?roomId=!room:test', cookie=owner)).status, 403)

    async def test_canonical_category_and_channel_rules_are_checked_fresh(self):
        owner, _, _ = await self.login('owner'); policy = self.managed()
        policy['categoryOverrides'] = {'restricted': {'roles': {'moderator': {'manage_messages': -1}}}}
        self.extra['!server:test'].append({'type': 'io.tavern.server.layout', 'state_key': '', 'content': {'version': 1, 'categories': [{'id': 'restricted'}], 'channels': [{'id': '!room:test', 'category': 'restricted'}]}})
        policy['_resolved_categories'] = {'!room:test': 'forged-allowed-category'}
        self.assertEqual((await self.issue(owner)).status, 403)
        policy['overrides']['!room:test'] = {'users': {'@owner:test': {'manage_messages': 1}}}
        self.assertEqual((await self.issue(owner)).status, 201)
        policy['members']['@alice:test'] = ['moderator']
        self.assertEqual((await self.issue(owner)).status, 403)
        self.rooms['!server:test']['members']['@owner:test'] = 'leave'
        self.assertEqual((await self.request('GET', '/api/moderation/warnings?roomId=!room:test', cookie=owner)).status, 403)

    async def test_all_canonical_parents_deny_invalid_policy_and_revoked_session(self):
        owner, _, _ = await self.login('owner'); self.managed(); other = self.managed('!second:test')
        other['roles'][1]['permissions'] = []
        self.assertEqual((await self.issue(owner)).status, 403)
        other['roles'][1]['permissions'] = ['manage_messages']; other['version'] = 999
        self.assertEqual((await self.issue(owner)).status, 403)
        other['version'] = 1
        original = self.service.matrix
        async def revoke(method, path, body=None, token=None, expected=True):
            value = await original(method, path, body, token, expected)
            if path.endswith('/state') and 'second' in path:
                self.service.store.db.execute("DELETE FROM sessions WHERE user_id='@owner:test'")
            return value
        self.service.matrix = revoke
        self.assertEqual((await self.issue(owner)).status, 401)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM moderation_warnings').fetchone()[0], 0)

    async def test_moderator_pagination_and_target_filter_do_not_expose_other_rooms(self):
        owner, _, _ = await self.login('owner'); alice, _, _ = await self.login()
        db = self.service.store.db
        for index in range(55):
            db.execute('INSERT INTO moderation_warnings(room_id,target,actor,reason,created) VALUES(?,?,?,?,?)', ('!room:test', '@alice:test', '@owner:test', self.service.store.seal(str(index)), index))
        db.execute('INSERT INTO moderation_warnings(room_id,target,actor,reason,created) VALUES(?,?,?,?,?)', ('!private:test', '@other:test', '@owner:test', self.service.store.seal('other room'), 99))
        value = await (await self.request('GET', '/api/moderation/warnings?roomId=!room:test&targetId=@alice:test', cookie=owner)).json()
        self.assertEqual(len(value['warnings']), 50); self.assertIsNotNone(value['next'])
        second = await (await self.request('GET', '/api/moderation/warnings?roomId=!room:test&before=' + str(value['next']), cookie=owner)).json(); self.assertEqual(len(second['warnings']), 5)
        mine = await (await self.request('GET', '/api/moderation/warnings/mine', cookie=alice)).json(); self.assertEqual(mine['unread'], 55)
        self.assertFalse(any(row['roomId'] == '!private:test' for row in value['warnings'] + mine['warnings']))

    async def test_policy_loader_reads_the_same_deployed_module_without_app_code_copies(self):
        directory = self.config.synapse_config.parent / 'tavern_modules'; directory.mkdir()
        for path in (Path(__file__).resolve().parent.parent / 'synapse_modules').glob('*.py'): shutil.copyfile(path, directory / path.name)
        original_path = list(sys.path)
        model = policy_model(self.service)
        self.assertEqual(Path(model.__file__).parent, directory)
        self.assertEqual(sys.path, original_path)
        policy = self.managed(); self.assertTrue(model.valid_policy(policy)); self.assertIn('manage_messages', model.permissions(policy, '@owner:test'))


if __name__ == '__main__': unittest.main()
