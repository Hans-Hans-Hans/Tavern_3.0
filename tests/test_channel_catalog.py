import copy
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from aiohttp import web
from tests import test_api as fixture
from synapse_modules.channel_capability import install


class ChannelCatalogTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.AccountAPITests.asyncTearDown
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login

    async def asyncSetUp(self):
        await fixture.AccountAPITests.asyncSetUp(self)
        self.server, self.actor = '!server:test', '@alice:test'
        self.ready, self.joined, self.changed = True, True, False
        self.policy = {'version': 1, 'owner': '@owner:test', 'roles': [{'id': 'everyone', 'name': 'Member', 'position': 0, 'permissions': ['join_calls']}],
                       'members': {}, 'overrides': {}, 'channelAdmissionVersion': 1,
                       'channelAdmissions': {'!allowed:test': {'roleIds': [], 'userIds': [self.actor]}, '!denied:test': {'roleIds': [], 'userIds': []}}}
        def event(kind, body, key='', sender='@owner:test'):
            return {'type': kind, 'state_key': key, 'event_id': '$' + kind + key, 'sender': sender, 'content': body}
        self.event = event
        self.parent = [event('m.room.create', {'type': 'm.space', 'm.federate': False}),
                       event('m.room.member', {'membership': 'join'}, self.actor), event('io.tavern.roles', self.policy)]
        self.states = {self.server: self.parent}
        for identity in self.policy['channelAdmissions']:
            self.parent.append(event('m.space.child', {'via': ['test']}, identity))
            self.states[identity] = [event('m.room.create', {'m.federate': False}), event('m.room.encryption', {'algorithm': 'm.megolm.v1.aes-sha2'}),
                                     event('m.space.parent', {'via': ['test'], 'canonical': True}, self.server),
                                     event('m.room.name', {'name': 'Allowed voice' if 'allowed' in identity else 'Hidden private name'}),
                                     event('io.tavern.channel', {'version': 1, 'kind': 'voice', 'archived': False})]
        async def native(request, payload):
            if request.path == '/_tavern/channel-admission':
                self.assertIsNone(request.headers.get('Authorization'))
                return web.json_response({'version': 1, 'ready': self.ready})
            if request.path == '/_matrix/client/v3/rooms/' + self.server + '/state/m.room.member/' + self.actor:
                return web.json_response({'membership': 'join' if self.joined else 'leave'})
            if request.path.startswith('/_synapse/admin/v1/rooms/') and request.path.endswith('/state'):
                identity = request.path.removeprefix('/_synapse/admin/v1/rooms/').removesuffix('/state')
                snapshot = copy.deepcopy(self.states[identity])
                if self.changed and identity == '!allowed:test':
                    self.policy['channelAdmissions'][identity]['userIds'] = []
                return web.json_response({'state': snapshot})
            return None
        self.upstream_response = native
        await self.login('owner')
        self.cookie, _, _ = await self.login()

    async def catalog(self):
        return await self.request('GET', '/api/servers/' + self.server + '/channels/available', cookie=self.cookie)

    async def test_discovery_shows_only_allowed_names_and_never_joins_or_reads_messages(self):
        self.upstream_calls.clear()
        response = await self.catalog()
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(await response.json(), {'channels': [{'id': '!allowed:test', 'name': 'Allowed voice', 'kind': 'voice', 'joined': False}], 'next': None})
        self.assertNotIn('Hidden private name', await response.text())
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertFalse(any('/messages' in path or '/join/' in path for _, path, _, _ in self.upstream_calls))
        self.assertFalse(any(method in ('PUT', 'DELETE') for method, _, _, _ in self.upstream_calls))

    async def test_capability_requires_a_session_and_live_native_readiness(self):
        response = await self.request('GET', '/api/channels/admission/capability')
        self.assertEqual(response.status, 401)
        response = await self.request('GET', '/api/channels/admission/capability', cookie=self.cookie)
        self.assertEqual(await response.json(), {'version': 1, 'available': True})
        self.ready = False
        response = await self.request('GET', '/api/channels/admission/capability', cookie=self.cookie)
        self.assertEqual(await response.json(), {'version': 1, 'available': False})
        self.assertEqual((await self.catalog()).status, 503)

    async def test_membership_loss_and_access_changes_never_disclose_a_stale_name(self):
        self.joined = False
        self.assertEqual((await self.catalog()).status, 403)
        self.joined, self.changed = True, True
        response = await self.catalog()
        self.assertIn(response.status, (409, 503))
        self.assertNotIn('Allowed voice', await response.text())


class NativeCapabilityTests(unittest.TestCase):
    def test_native_resource_reports_durable_worker_initialization_without_private_data(self):
        captured, headers = {}, {}
        worker = SimpleNamespace(ready=False)
        api = SimpleNamespace(register_web_resource=lambda path, resource: captured.update(path=path, resource=resource))
        with patch.dict('sys.modules', {'twisted.web.resource': SimpleNamespace(Resource=object)}):
            install(api, worker)
        self.assertEqual(captured['path'], '/_tavern/channel-admission')
        request = SimpleNamespace(setHeader=lambda key, value: headers.update({key: value}))
        self.assertEqual(json.loads(captured['resource'].render_GET(request)), {'version': 1, 'ready': False})
        worker.ready = True
        self.assertEqual(json.loads(captured['resource'].render_GET(request)), {'version': 1, 'ready': True})
        self.assertEqual(headers[b'Cache-Control'], b'no-store')
