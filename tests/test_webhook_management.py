"""Webhook management through real API sessions and canonical room authority."""
import asyncio
import copy
from contextlib import asynccontextmanager
import json
from pathlib import Path
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from integrations.configuration import load_configuration
from tests import test_moderation as fixture


class WebhookManagementTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.WarningTests.asyncTearDown
    request = fixture.WarningTests.request
    login = fixture.WarningTests.login
    managed = fixture.WarningTests.managed

    async def asyncSetUp(self):
        await fixture.WarningTests.asyncSetUp(self)
        self.policy = self.managed()
        self.policy['roles'][1]['permissions'] = ['manage_webhooks']
        self.users['@moderator:test'] = {'password': 'Correct password!', 'admin': False}
        self.policy['members']['@moderator:test'] = ['moderator']
        for room in ('!room:test', '!server:test'):
            self.rooms[room]['members']['@moderator:test'] = 'join'
            self.rooms[room]['powers']['users']['@moderator:test'] = 50
        self.folder = Path(self.directory.name) / 'bot-config'
        self.folder.mkdir()
        self.service.integrations.directory = self.folder
        self.service.integrations.enabled = True
        self.health_started = None
        self.health_release = None

        @asynccontextmanager
        async def health(*args, **kwargs):
            self.assertEqual(args[0], 'http://integrations:8080/health')
            if self.health_started is not None:
                self.health_started.set()
                await self.health_release.wait()
            _, revision = self.service.integrations.read()
            yield SimpleNamespace(status=200, json=AsyncMock(return_value={'ready': True, 'configuration': revision}))

        health_patch = patch.object(self.service.http, 'get', side_effect=health)
        health_patch.start()
        self.addCleanup(health_patch.stop)
        # Provision the existing read-only service identity without retaining an
        # administrator session for any delegated operation.
        owner, _, _ = await self.login('owner')
        await self.request('POST', '/api/auth/logout', {}, owner)

    def state(self):
        return self.service.integrations.read()

    async def create(self, cookie, admin=False, **changes):
        room = changes.get('roomId', '!room:test')
        data = {'id': 'builds', 'roomId': room, 'allowedUsers': sorted(self.rooms[room]['members']),
                'confirmation': room, 'revision': self.state()[1], **changes}
        return await self.request('POST', '/api/' + ('admin/' if admin else '') + 'integrations/hooks', data, cookie)

    async def created(self, cookie, **changes):
        response = await self.create(cookie, **changes)
        self.assertEqual(response.status, 201, await response.text())
        return await response.json()

    async def edit(self, cookie, method='PUT', identity='builds', admin=False, **changes):
        data = {'roomId': '!room:test', 'confirmation': identity, 'revision': self.state()[1], **changes}
        suffix = '/rotate' if method == 'POST' else ''
        return await self.request(method, '/api/' + ('admin/' if admin else '') + 'integrations/hooks/' + identity + suffix, data, cookie)

    async def inventory(self, cookie, room='!room:test', admin=False):
        return await self.request('GET', '/api/' + ('admin/' if admin else '') + 'integrations' + ('' if admin else '?roomId=' + room), cookie=cookie)

    async def test_metadata_creator_identity_and_secret_are_preserved_across_edits(self):
        moderator, _, _ = await self.login('moderator')
        before = int(time.time() * 1000)
        created = await self.created(moderator, name='  Nightly builds  ', avatarUrl='mxc://media.test/build_icon', enabled=False,
                                     createdBy='@forged:test', createdAt=1, created_by='@forged:test', created_at=1)
        first = copy.deepcopy(self.state()[0]['hooks']['builds'])
        self.assertEqual(first['name'], 'Nightly builds')
        self.assertEqual(first['avatar_url'], 'mxc://media.test/build_icon')
        self.assertFalse(first['enabled'])
        self.assertEqual(first['created_by'], '@moderator:test')
        self.assertGreaterEqual(first['created_at'], before)
        (self.folder / 'session.json').write_text('{"access_token":"private-bot-session-token"}')
        (self.folder / 'pickle.key').write_text('private-bot-store-key')
        response = await self.edit(moderator, name='Build results', avatarUrl='', enabled=True,
                                   createdBy='@forged:test', createdAt=0, secret_file='/config/session.json')
        self.assertEqual(response.status, 200, await response.text())
        self.assertNotIn('secret', await response.json())
        config, keys, _ = load_configuration(self.folder / 'bot.json')
        current = config['hooks']['builds']
        self.assertEqual((current['created_by'], current['created_at'], current['secret_file']),
                         (first['created_by'], first['created_at'], first['secret_file']))
        self.assertEqual(keys['builds'].decode(), created['secret'])
        listing = await self.inventory(moderator)
        self.assertEqual(listing.status, 200, await listing.text())
        value = await listing.json()
        self.assertTrue(value['applied'])
        self.assertEqual(value['hooks'][0]['name'], 'Build results')
        self.assertEqual(value['hooks'][0]['createdBy'], '@moderator:test')
        combined = json.dumps(value) + json.dumps([list(row) for row in self.service.store.db.execute('SELECT action,target,detail FROM audit')])
        for private in (created['secret'], 'private-bot-session-token', 'private-bot-store-key', 'secret_file'):
            self.assertNotIn(private, combined)
        self.assertEqual((self.folder / 'pickle.key').read_text(), 'private-bot-store-key')
        self.assertFalse(any('/make_room_admin' in path for _, path, _, _ in self.upstream_calls))

    async def test_legacy_missing_metadata_stays_visible_without_invented_creation_details(self):
        moderator, _, _ = await self.login('moderator')
        await self.created(moderator)
        config, _ = self.state()
        for key in ('name', 'avatar_url', 'enabled', 'created_by', 'created_at'):
            config['hooks']['builds'].pop(key, None)
        self.service.integrations.write(config)
        row = (await (await self.inventory(moderator)).json())['hooks'][0]
        self.assertEqual((row['name'], row['avatarUrl'], row['enabled'], row['createdBy'], row['createdAt']), ('builds', '', True, None, None))

    async def test_disabled_metadata_can_be_changed_but_enable_and_allowlist_edits_check_current_members(self):
        moderator, _, _ = await self.login('moderator')
        await self.created(moderator)
        self.rooms['!room:test']['members']['@newcomer:test'] = 'join'
        disabled = await self.edit(moderator, enabled=False)
        self.assertEqual(disabled.status, 200, await disabled.text())
        self.assertEqual((await self.edit(moderator, name='Paused hook')).status, 200)
        revision = self.state()[1]
        self.assertEqual((await self.edit(moderator, enabled=True)).status, 400)
        self.assertEqual((await self.edit(moderator, enabled=False, allowedUsers=['@moderator:test'])).status, 400)
        self.assertEqual(self.state()[1], revision)
        approved = sorted(self.rooms['!room:test']['members'])
        self.assertEqual((await self.edit(moderator, enabled=False, allowedUsers=approved)).status, 200)
        self.assertEqual((await self.edit(moderator, enabled=True)).status, 200)

    async def test_invalid_metadata_and_confirmation_never_create_secret_files(self):
        moderator, _, _ = await self.login('moderator')
        cases = [{'enabled': bad} for bad in ('false', 0, None)]
        cases += [{'name': bad} for bad in ('', '   ', 'line\nbreak', 'x' * 81, 12)]
        cases += [{'avatarUrl': bad} for bad in ('https://example/icon.png', 'mxc://media/id?token=leak', 'mxc://media/../secret', 'mxc://media/' + 'x' * 2048, None)]
        cases += [{'confirmation': '!wrong:test'}, {'allowedUsers': []}, {'allowedUsers': ['not-a-Matrix-user']}]
        for changes in cases:
            with self.subTest(changes=changes):
                response = await self.create(moderator, **changes)
                self.assertEqual(response.status, 400, await response.text())
        self.assertFalse((self.folder / 'bot.json').exists())
        self.assertEqual(list(self.folder.glob('managed-*.hmac')), [])

    async def test_destination_is_immutable_and_delegated_scope_never_exposes_other_hooks_or_pins(self):
        moderator, _, _ = await self.login('moderator')
        own = await self.created(moderator)
        owner, _, _ = await self.login('owner')
        self.rooms['!private:test'] = {'name': 'Private room', 'members': {'@owner:test': 'join'}, 'powers': {'users': {'@owner:test': 100}}}
        private = await self.created(owner, admin=True, id='private', roomId='!private:test', name='Private integration')
        config, _ = self.state()
        config['trusted_devices'] = {'@private:test': {'PRIVATE_DEVICE': 'A' * 43}}
        self.service.integrations.write(config)
        listing = await (await self.inventory(moderator)).json()
        self.assertEqual([row['id'] for row in listing['hooks']], ['builds'])
        self.assertEqual(listing['pins'], [])
        text = json.dumps(listing)
        for hidden in ('Private integration', '!private:test', 'PRIVATE_DEVICE', private['secret'], own['secret']):
            self.assertNotIn(hidden, text)
        for method in ('PUT', 'POST', 'DELETE'):
            self.assertEqual((await self.edit(moderator, method=method, identity='private')).status, 404)
        self.assertEqual((await self.inventory(moderator, room='!private:test')).status, 403)
        self.assertEqual((await self.inventory(moderator, admin=True)).status, 403)
        self.assertEqual((await self.create(moderator, admin=True, id='forbidden')).status, 403)
        pin = await self.request('POST', '/api/admin/integrations/pins', {'userId': '@alice:test', 'deviceId': 'PHONE', 'fingerprint': 'A' * 43, 'confirmation': 'VERIFIED', 'revision': self.state()[1]}, moderator)
        self.assertEqual(pin.status, 403)
        revision = self.state()[1]
        moved = await self.edit(owner, admin=True, roomId='!private:test')
        self.assertEqual(moved.status, 400, await moved.text())
        self.assertEqual(self.state()[1], revision)
        self.assertEqual(self.state()[0]['hooks']['builds']['room_id'], '!room:test')

    async def test_current_native_role_and_both_memberships_gate_each_read_and_write(self):
        moderator, _, _ = await self.login('moderator')
        await self.created(moderator)
        self.assertEqual((await self.inventory(moderator)).status, 200)
        cases = [
            (self.policy['roles'][1], 'permissions', []),
            (self.rooms['!room:test']['powers']['users'], '@moderator:test', 0),
            (self.rooms['!room:test']['powers'], 'state_default', 75),
            (self.rooms['!server:test']['members'], '@moderator:test', 'leave'),
            (self.rooms['!room:test']['members'], '@moderator:test', 'leave'),
        ]
        for mapping, key, denied in cases:
            with self.subTest(key=key, denied=denied):
                original = mapping.get(key)
                existed = key in mapping
                mapping[key] = denied
                self.assertEqual((await self.inventory(moderator)).status, 403)
                self.assertEqual((await self.edit(moderator, enabled=False)).status, 403)
                if existed: mapping[key] = original
                else: del mapping[key]
        self.assertEqual((await self.inventory(moderator)).status, 200)

    async def test_all_canonical_parent_category_rules_and_channel_override_are_checked(self):
        moderator, _, _ = await self.login('moderator')
        await self.created(moderator)
        second = self.managed('!second:test')
        self.rooms['!second:test']['members']['@moderator:test'] = 'join'
        second['members']['@moderator:test'] = ['moderator']
        self.assertEqual((await self.inventory(moderator)).status, 403)
        second['roles'][1]['permissions'] = ['manage_webhooks']
        second['categoryOverrides'] = {'restricted': {'roles': {'moderator': {'manage_webhooks': -1}}}}
        second['_resolved_categories'] = {'!room:test': 'forged-allowed-category'}
        self.extra['!second:test'].append({'type': 'io.tavern.server.layout', 'state_key': '', 'content': {
            'version': 1, 'categories': [{'id': 'restricted'}], 'channels': [{'id': '!room:test', 'category': 'restricted'}]}})
        self.assertEqual((await self.inventory(moderator)).status, 403)
        self.assertEqual((await self.edit(moderator, enabled=False)).status, 403)
        second['overrides'] = {'!room:test': {'users': {'@moderator:test': {'manage_webhooks': 1}}}}
        self.assertEqual((await self.inventory(moderator)).status, 200)
        self.assertEqual((await self.edit(moderator, enabled=False)).status, 200)
        second['version'] = 999
        self.assertEqual((await self.inventory(moderator)).status, 403)

    async def test_unmanaged_space_nonreciprocal_parent_and_active_temporary_ban_are_denied(self):
        moderator, _, _ = await self.login('moderator')
        await self.created(moderator)
        links = self.extra['!room:test']
        self.extra['!room:test'] = []
        self.assertEqual((await self.inventory(moderator)).status, 403)
        self.extra['!room:test'] = links
        child = self.extra['!server:test'][0]['content']
        child['via'] = []
        self.assertEqual((await self.inventory(moderator)).status, 403)
        child['via'] = ['test']
        self.extra['!room:test'].append({'type': 'm.room.create', 'state_key': '', 'content': {'type': 'm.space'}})
        self.assertEqual((await self.inventory(moderator)).status, 403)
        self.extra['!room:test'].pop()
        for scope in ('!room:test', '!server:test'):
            with self.subTest(scope=scope):
                self.extra[scope].append({'type': 'io.tavern.tempban', 'state_key': '@moderator:test', 'content': {'version': 1, 'until': int(time.time() * 1000) + 60000}})
                self.assertEqual((await self.inventory(moderator)).status, 403)
                self.assertEqual((await self.edit(moderator, enabled=False)).status, 403)
                self.extra[scope].pop()

    async def test_concurrent_revision_edits_do_not_overwrite_or_rotate_a_secret(self):
        moderator, _, _ = await self.login('moderator')
        created = await self.created(moderator)
        revision = self.state()[1]
        responses = await asyncio.gather(self.edit(moderator, name='One', revision=revision), self.edit(moderator, name='Two', revision=revision))
        self.assertEqual(sorted(response.status for response in responses), [200, 409])
        _, keys, _ = load_configuration(self.folder / 'bot.json')
        self.assertEqual(keys['builds'].decode(), created['secret'])
        self.assertEqual(self.service.store.db.execute("SELECT count(*) FROM audit WHERE action='webhook_updated'").fetchone()[0], 1)

    async def test_delegated_rotation_and_retirement_preserve_metadata_and_never_reuse_id(self):
        moderator, _, _ = await self.login('moderator')
        original = await self.created(moderator, name='Paused build hook', enabled=False, avatarUrl='mxc://media.test/icon')
        saved = copy.deepcopy(self.state()[0]['hooks']['builds'])
        response = await self.edit(moderator, method='POST')
        self.assertEqual(response.status, 200, await response.text())
        rotated = await response.json()
        self.assertNotEqual(rotated['secret'], original['secret'])
        current = self.state()[0]['hooks']['builds']
        for key in ('name', 'enabled', 'avatar_url', 'room_id', 'allowed_users', 'created_by', 'created_at'):
            self.assertEqual(current[key], saved[key])
        _, keys, _ = load_configuration(self.folder / 'bot.json')
        self.assertEqual(keys['builds'].decode(), rotated['secret'])
        self.assertEqual(len(list(self.folder.glob('managed-*.hmac'))), 1)
        self.assertNotIn(rotated['secret'], await (await self.inventory(moderator)).text())
        self.assertEqual((await self.edit(moderator, method='DELETE')).status, 200)
        self.assertEqual((await self.create(moderator)).status, 409)
        self.assertEqual(list(self.folder.glob('managed-*.hmac')), [])
        self.assertIn('builds', self.state()[0]['retired_hooks'])

    async def test_role_revoked_while_waiting_for_configuration_lock_prevents_creation(self):
        moderator, _, _ = await self.login('moderator')
        reached = asyncio.Event()
        rate = self.service.store.rate
        def observe(key, *args):
            result = rate(key, *args)
            if key.startswith('webhooks-write:'): reached.set()
            return result
        self.service.store.rate = observe
        await self.service.integrations.lock.acquire()
        pending = asyncio.create_task(self.create(moderator))
        try:
            await asyncio.wait_for(reached.wait(), 3)
            self.policy['roles'][1]['permissions'] = []
        finally:
            self.service.integrations.lock.release()
            response = await pending
        self.assertEqual(response.status, 403, await response.text())
        self.assertFalse((self.folder / 'bot.json').exists())
        self.assertEqual(list(self.folder.glob('managed-*.hmac')), [])

    async def test_session_revocation_cancels_both_inflight_and_serialized_waiting_writes(self):
        moderator, _, _ = await self.login('moderator')
        await self.created(moderator)
        before = (self.folder / 'bot.json').read_bytes()
        arrived, release, second_waiting = asyncio.Event(), asyncio.Event(), asyncio.Event()
        matrix = self.service.matrix
        async def hold(method, path, body=None, token=None, expected=True):
            result = await matrix(method, path, body, token, expected)
            if path.endswith('/state') and 'server' in path:
                arrived.set()
                await release.wait()
            return result
        self.service.matrix = hold
        rate = self.service.store.rate
        writes = 0
        def observe(key, *args):
            nonlocal writes
            result = rate(key, *args)
            if key.startswith('webhooks-write:'):
                writes += 1
                if writes == 2: second_waiting.set()
            return result
        self.service.store.rate = observe
        first = asyncio.create_task(self.edit(moderator, name='First'))
        second = None
        try:
            await asyncio.wait_for(arrived.wait(), 3)
            second = asyncio.create_task(self.edit(moderator, name='Second'))
            await asyncio.wait_for(second_waiting.wait(), 3)
            self.service.store.db.execute("DELETE FROM sessions WHERE user_id='@moderator:test'")
        finally:
            release.set()
            tasks = [first] + ([second] if second else [])
            responses = await asyncio.gather(*tasks)
        self.assertEqual([response.status for response in responses], [401, 401])
        self.assertEqual((self.folder / 'bot.json').read_bytes(), before)
        self.assertEqual(len(list(self.folder.glob('managed-*.hmac'))), 1)
        self.assertEqual(self.service.store.db.execute("SELECT count(*) FROM audit WHERE action='webhook_updated'").fetchone()[0], 0)

    async def test_health_await_cannot_return_inventory_after_membership_role_or_session_revocation(self):
        moderator, _, _ = await self.login('moderator')
        await self.created(moderator, name='Sensitive hook label')
        for revoked in ('role', 'membership', 'session'):
            with self.subTest(revoked=revoked):
                moderator, _, _ = await self.login('moderator')
                self.health_started, self.health_release = asyncio.Event(), asyncio.Event()
                pending = asyncio.create_task(self.inventory(moderator))
                try:
                    await asyncio.wait_for(self.health_started.wait(), 3)
                    if revoked == 'role': self.policy['roles'][1]['permissions'] = []
                    elif revoked == 'membership': self.rooms['!room:test']['members']['@moderator:test'] = 'leave'
                    else: self.service.store.db.execute("DELETE FROM sessions WHERE user_id='@moderator:test'")
                finally:
                    self.health_release.set()
                    response = await pending
                self.assertEqual(response.status, 401 if revoked == 'session' else 403, await response.text())
                self.assertNotIn('Sensitive hook label', await response.text())
                self.policy['roles'][1]['permissions'] = ['manage_webhooks']
                self.rooms['!room:test']['members']['@moderator:test'] = 'join'
                self.health_started = self.health_release = None

    async def test_instance_administrator_revoked_during_health_cannot_receive_global_inventory(self):
        owner, _, _ = await self.login('owner')
        await self.created(owner, admin=True, name='Private global hook')
        self.health_started, self.health_release = asyncio.Event(), asyncio.Event()
        pending = asyncio.create_task(self.inventory(owner, admin=True))
        try:
            await asyncio.wait_for(self.health_started.wait(), 3)
            self.users['@owner:test']['admin'] = False
        finally:
            self.health_release.set()
            response = await pending
        self.assertEqual(response.status, 403, await response.text())
        self.assertNotIn('Private global hook', await response.text())


if __name__ == '__main__':
    unittest.main()
