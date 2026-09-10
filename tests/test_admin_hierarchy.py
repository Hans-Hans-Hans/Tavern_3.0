import asyncio
import base64
import json
import unittest
from unittest.mock import patch
from urllib.parse import quote, unquote

from aiohttp import web

from api import admin_hierarchy as hierarchy
from api import admin_resources
from api.server import COOKIE
from tests import test_api as fixture

ROOT, CHILD, OWNER = '!space:test', '!child:test', '@owner:test'


def event(kind, content, key='', **extra):
    return {'type': kind, 'state_key': key, 'content': content, 'sender': OWNER,
            'event_id': '$' + kind + key, **extra}


def state(space=False, version='11', **creation):
    return [event('m.room.create', {'room_version': version, **({'type': 'm.space'} if space else {}), **creation}, origin_server_ts=1700000000000),
            event('m.room.name', {'name': 'Native server' if space else 'Native channel'}),
            event('m.room.member', {'membership': 'join', 'displayname': 'PRIVATE PROFILE'}, OWNER),
            event('m.room.encryption', {'algorithm': 'm.megolm.v1.aes-sha2'})]


class HierarchyTests(unittest.IsolatedAsyncioTestCase):
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login
    asyncTearDown = fixture.AccountAPITests.asyncTearDown

    async def asyncSetUp(self):
        await fixture.AccountAPITests.asyncSetUp(self)
        self.states = {ROOT: state(True), CHILD: state()}
        self.link(ROOT, CHILD)
        self.reads = []
        self.before = None

        async def native(request, payload):
            path = request.path
            if path.startswith('/_synapse/admin/v1/rooms/') and path.endswith('/state'):
                target = path.removeprefix('/_synapse/admin/v1/rooms/').removesuffix('/state')
                self.reads.append(target)
                if self.before:
                    result = await self.before(target)
                    if result is not None:
                        return result
                return web.json_response({'state': self.states[target]}) if target in self.states else web.json_response({}, status=404)
        self.upstream_response = native
        self.owner, _, _ = await self.login('owner')

    def link(self, parent, child):
        self.states[parent].append(event('m.space.child', {'via': ['test']}, child))
        self.states[child].append(event('m.space.parent', {'via': ['test'], 'canonical': True}, parent))

    async def page(self, target=ROOT, suffix='', cookie=None):
        return await self.request('GET', '/api/admin/rooms/' + quote(target, safe='') + '/hierarchy' + suffix, cookie=cookie or self.owner)

    async def test_native_admin_only_and_read_only_metadata_projection(self):
        ordinary, _, _ = await self.login()
        denied = await self.page(cookie=ordinary)
        self.assertEqual(denied.status, 403)
        self.assertEqual(self.reads, [])
        response = await self.page()
        self.assertEqual(response.status, 200, await response.text())
        data = await response.json()
        self.assertEqual(data['room']['creators'], [OWNER])
        self.assertEqual(data['room']['createdAt'], 1700000000000)
        self.assertEqual(data['room']['joinedMembers'], 1)
        self.assertIsNone(data['room']['storageBytes'])
        self.assertIsNone(data['room']['activityAt'])
        self.assertEqual(data['links'][0]['status'], 'confirmed')
        self.assertEqual(data['links'][0]['room']['roomId'], CHILD)
        encoded = json.dumps(data)
        self.assertNotIn('PRIVATE PROFILE', encoded)
        self.assertNotIn('event_id', encoded)
        self.assertNotIn('content', data)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        reads = [path for method, path, *_ in self.upstream_calls if path.startswith('/_synapse/admin/v1/rooms/')]
        self.assertTrue(all(path.endswith('/state') for path in reads))
        self.assertFalse(any('/messages' in path or '/join' in path or '/media/' in path for _, path, *_ in self.upstream_calls))

    async def test_v12_creator_and_additional_creator_come_from_native_create_not_users_power(self):
        target = '!' + base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip('=')
        self.states[target] = state(True, '12', additional_creators=['@second:test'], creator='@forged:test')
        self.states[target].append(event('m.room.power_levels', {'users': {}}))
        response = await self.page(target)
        self.assertEqual(response.status, 200)
        value = (await response.json())['room']
        self.assertEqual(value['creators'], [OWNER, '@second:test'])
        self.assertEqual(value['creatorAuthority'], 'inherent')
        self.assertEqual(value['roomVersion'], '12')
        self.assertNotIn('@forged:test', json.dumps(value))

    async def test_parent_requires_actual_space_and_current_reciprocal_links(self):
        reverse = await self.page(CHILD)
        self.assertEqual((await reverse.json())['links'][0]['direction'], 'parent')
        self.states[CHILD] = [item for item in self.states[CHILD] if item['type'] != 'm.space.parent']
        value = await self.page()
        self.assertEqual((await value.json())['links'][0]['status'], 'unconfirmed')
        self.states[CHILD].append(event('m.space.parent', {'via': ['test']}, ROOT))
        self.states[ROOT][0]['content'].pop('type')
        value = await self.page()
        self.assertEqual((await value.json())['links'][0]['status'], 'unconfirmed')

    async def test_missing_metadata_is_unknown_and_a_large_child_does_not_hide_the_known_parent(self):
        self.states[ROOT][0].pop('origin_server_ts')
        self.states[CHILD].append(event('private.opaque', {'blob': 'x' * hierarchy.MAX_BYTES}))
        response = await self.page()
        value = await response.json()
        self.assertEqual(value['room']['status'], 'available')
        self.assertIsNone(value['room']['createdAt'])
        self.assertIsNone(value['room']['archived'])
        self.assertEqual(value['links'][0]['status'], 'unavailable')
        self.assertIn('byte limit', value['links'][0]['reason'])
        self.assertNotIn('blob', json.dumps(value))

    async def test_cycles_do_not_recurse_and_unavailable_links_are_explicit(self):
        self.states[CHILD][0]['content']['type'] = 'm.space'
        self.link(CHILD, ROOT)
        self.states[ROOT].extend([event('m.space.child', {'via': ['test']}, ROOT),
                                  event('m.space.child', {'via': ['test']}, '!absent:test')])
        response = await self.page()
        self.assertEqual(response.status, 200)
        links = (await response.json())['links']
        self.assertTrue(any(row['status'] == 'cycle' for row in links))
        self.assertTrue(any(row['status'] == 'unavailable' and row['roomId'] == '!absent:test' for row in links))
        self.assertEqual(self.reads.count(ROOT), 2)
        self.assertLessEqual(len(self.reads), 5)

    async def test_malformed_identifier_route_and_candidate_never_reach_native(self):
        for target in ['!notvalid', '!' + 'A' * 42 + 'B', '!a:test/escaped', '!a\x00:test']:
            response = await self.page(target)
            self.assertIn(response.status, (400, 404))
        self.assertEqual(self.reads, [])
        self.states[ROOT].append(event('m.space.child', {'via': ['test']}, '!bad'))
        self.states[ROOT].append(event('m.space.child', {'via': ['test']}, '!\ud800:test'))
        self.states[ROOT].append(event('m.space.child', {'via': 'test'}, '!invalid:test'))
        result = await self.page()
        value = await result.json()
        self.assertEqual(value['omittedLinks'], 2)
        self.assertTrue(any(row['status'] == 'malformed' for row in value['links']))
        self.assertNotIn('!invalid:test', self.reads)

    async def test_pages_are_bounded_and_changed_native_source_revision_is_rejected(self):
        self.states = {ROOT: state(True)}
        for index in range(205):
            target = '!child%03d:test' % index
            self.states[target] = state()
            self.link(ROOT, target)
        first = await self.page()
        data = await first.json()
        self.assertEqual(len(data['links']), 20)
        self.assertTrue(data['truncated'])
        self.assertEqual(len(self.reads), 22)
        second = await self.page(suffix='?from=20&revision=' + data['revision'])
        following = await second.json()
        self.assertEqual(len(following['links']), 20)
        self.assertFalse({row['roomId'] for row in data['links']} & {row['roomId'] for row in following['links']})
        self.states[ROOT].pop()
        changed = await self.page(suffix='?from=40&revision=' + data['revision'])
        self.assertEqual(changed.status, 409)
        for suffix in ['?from=200', '?from=1', '?from=-1', '?from=20', '?from=0&revision=bad']:
            result = await self.page(suffix=suffix)
            self.assertEqual(result.status, 400)

    async def test_byte_event_and_duplicate_or_foreign_state_bounds_fail_without_exposure(self):
        original = list(self.states[ROOT])
        variants = [original + [original[0]],
                    [{**original[0], 'room_id': CHILD}],
                    [original[0], event('m.room.encryption', {'algorithm': {}})],
                    [{**original[0], 'content': {'type': {}}}],
                    original + [event('private.unrelated', {'secret': 's' * hierarchy.MAX_BYTES})],
                    [event('ignored', {}, str(index)) for index in range(hierarchy.MAX_EVENTS + 1)]]
        for events in variants:
            self.states[ROOT] = events
            response = await self.page()
            self.assertEqual(response.status, 200)
            data = await response.json()
            self.assertEqual(data['room']['status'], 'unavailable')
            self.assertEqual(data['links'], [])
            self.assertNotIn('secret', json.dumps(data))

    async def test_revoked_admin_or_session_during_native_read_cannot_publish(self):
        for action in ['admin', 'session']:
            self.users[OWNER]['admin'] = True
            self.owner, _, _ = await self.login('owner')
            async def change(target):
                if target == CHILD:
                    if action == 'admin':
                        self.users[OWNER]['admin'] = False
                    else:
                        self.service.store.db.execute('DELETE FROM sessions WHERE user_id=?', (OWNER,))
            self.before = change
            response = await self.page()
            self.assertIn(response.status, (401, 403))
            self.assertNotIn('Native server', await response.text())

    async def test_changed_source_after_counterpart_read_rejects_the_page(self):
        async def change(target):
            if target == CHILD:
                self.states[ROOT] = [item for item in self.states[ROOT] if item['type'] != 'm.space.child']
        self.before = change
        response = await self.page()
        self.assertEqual(response.status, 409)

    async def test_native_fanout_and_timeout_are_bounded(self):
        for index in range(8):
            child = '!other%d:test' % index
            self.states[child] = state()
            self.link(ROOT, child)
        active, highest = 0, 0
        async def delayed(target):
            nonlocal active, highest
            active += 1; highest = max(highest, active)
            try:
                await asyncio.sleep(.01)
            finally:
                active -= 1
        self.before = delayed
        response = await self.page()
        self.assertEqual(response.status, 200)
        self.assertLessEqual(highest, hierarchy.CONCURRENCY)
        with patch.object(hierarchy, 'PAGE_SECONDS', .001):
            response = await self.page()
        self.assertEqual(response.status, 503)

    async def test_streamed_existing_block_confirmation_cannot_mutate_after_session_or_admin_revocation(self):
        for revoke in ['session', 'admin']:
            self.users[OWNER]['admin'] = True
            self.owner, _, _ = await self.login('owner')
            entered, release = asyncio.Event(), asyncio.Event()
            original_body = admin_resources.body_json
            async def body(request):
                entered.set()
                return await original_body(request)
            async def chunks():
                yield b'{"block":true,'
                await release.wait()
                yield b'"confirmation":"!room:test"}'
            with patch.object(admin_resources, 'body_json', body):
                pending = asyncio.create_task(self.client.put('/api/admin/rooms/!room:test/block', data=chunks(),
                    headers={'Origin': fixture.ORIGIN, 'Cookie': COOKIE + '=' + self.owner, 'Content-Type': 'application/json'}))
                await asyncio.wait_for(entered.wait(), 2)
                if revoke == 'session':
                    self.service.store.db.execute('DELETE FROM sessions WHERE user_id=?', (OWNER,))
                else:
                    self.users[OWNER]['admin'] = False
                release.set()
                response = await asyncio.wait_for(pending, 2)
            self.assertIn(response.status, (401, 403), await response.text())
            self.assertFalse(self.rooms['!room:test'].get('blocked', False))
        self.assertFalse(any(method == 'PUT' and path.endswith('/block') for method, path, *_ in self.upstream_calls))

    async def test_existing_room_inventory_and_details_recheck_authority_before_returning(self):
        original = self.service.matrix
        for route, target in [('/api/admin/rooms', '/_synapse/admin/v1/rooms'), ('/api/admin/rooms/!room:test', '/_synapse/admin/v1/rooms/!room:test/members')]:
            self.users[OWNER]['admin'] = True
            async def revoke(method, path, *args, **kwargs):
                result = await original(method, path, *args, **kwargs)
                if unquote(path.split('?')[0]) == target:
                    self.users[OWNER]['admin'] = False
                return result
            with patch.object(self.service, 'matrix', revoke):
                response = await self.request('GET', route, cookie=self.owner)
            self.assertEqual(response.status, 403, await response.text())
            self.assertNotIn('Test room', await response.text())


if __name__ == '__main__':
    unittest.main()
