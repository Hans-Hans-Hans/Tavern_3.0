import copy
import unittest

from aiohttp import web
from api.room_removal_scope import removal_scope
from api.server import APIError
from tests import test_api as fixture


class RemovalScopeTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.AccountAPITests.asyncTearDown
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login

    async def asyncSetUp(self):
        await fixture.AccountAPITests.asyncSetUp(self)
        self.actor, self.server, self.channel = '@alice:test', '!server:test', '!channel:test'
        def event(kind, body, key='', sender=self.actor):
            return {'type': kind, 'state_key': key, 'event_id': '$' + kind + key, 'sender': sender, 'content': body}
        self.event = event
        policy = {'version': 1, 'owner': self.actor, 'roles': [{'id': 'everyone', 'name': 'Member', 'position': 0, 'permissions': ['send_messages']}], 'members': {}, 'overrides': {}}
        self.states = {
            self.server: [event('m.room.create', {'type': 'm.space', 'm.federate': False}), event('m.room.name', {'name': 'Games'}),
                          event('m.room.member', {'membership': 'join'}, self.actor), event('io.tavern.roles', policy), event('m.space.child', {'via': ['test']}, self.channel)],
            self.channel: [event('m.room.create', {'m.federate': False}, sender='@delegate:test'), event('m.room.name', {'name': 'Gaming Voice'}),
                           event('m.room.encryption', {'algorithm': 'm.megolm.v1.aes-sha2'}), event('m.space.parent', {'canonical': True, 'via': ['test']}, self.server),
                           event('m.room.member', {'membership': 'join'}, self.actor), event('m.room.member', {'membership': 'join'}, '@bob:test')],
        }
        self.change_after = None
        async def native(request, payload):
            if request.path.startswith('/_matrix/client/v3/rooms/') and '/state/m.room.member/' in request.path:
                identity, actor = request.path.removeprefix('/_matrix/client/v3/rooms/').split('/state/m.room.member/')
                member = next((value for value in self.states.get(identity, []) if value['type'] == 'm.room.member' and value['state_key'] == actor), None)
                return web.json_response(member['content'] if member else {'membership': 'leave'})
            if request.path.startswith('/_synapse/admin/v1/rooms/') and request.path.endswith('/state'):
                identity = request.path.removeprefix('/_synapse/admin/v1/rooms/').removesuffix('/state')
                events = copy.deepcopy(self.states[identity])
                if self.change_after == identity:
                    self.states[self.server].append(event('m.space.child', {'via': ['test']}, '!new:test'))
                    self.change_after = None
                return web.json_response({'state': events})
            return None
        self.upstream_response = native
        await self.login('owner')
        cookie, _, _ = await self.login()
        self.cookie = cookie
        self.session = dict(self.service.store.db.execute('SELECT * FROM sessions WHERE cookie_hash=?', (self.service.store.digest(cookie),)).fetchone())
        self.upstream_calls.clear()

    async def test_server_review_lists_only_reciprocal_local_channels_then_the_server_without_mutations(self):
        plan = await removal_scope(self.service, self.session, self.server)
        self.assertEqual(plan['name'], 'Games')
        self.assertEqual([item['id'] for item in plan['targets']], [self.channel, self.server])
        self.assertEqual(plan['targets'][0]['parents'], [self.server])
        self.assertEqual(plan['targets'][0]['members'], 2)
        self.assertEqual(set(plan['revisions']), {self.server, self.channel})
        self.assertTrue(all(method == 'GET' for method, _, _, _ in self.upstream_calls))

    async def test_channel_review_requires_native_owner_not_an_asserted_role_or_high_power(self):
        plan = await removal_scope(self.service, self.session, self.channel)
        self.assertEqual([item['id'] for item in plan['targets']], [self.channel])
        self.states[self.server][0]['sender'] = '@someone:test'
        with self.assertRaises(APIError) as error:
            await removal_scope(self.service, self.session, self.channel)
        self.assertEqual(error.exception.status, 403)

    async def test_direct_messages_nested_servers_nonreciprocal_and_shared_channels_are_not_cascaded(self):
        original = copy.deepcopy(self.states)
        for modification in ('dm', 'nested', 'nonreciprocal', 'shared'):
            self.states = copy.deepcopy(original)
            if modification == 'dm':
                self.states[self.channel] = [event for event in self.states[self.channel] if event['type'] != 'm.space.parent']
            elif modification == 'nested':
                self.states[self.channel][0]['content']['type'] = 'm.space'
            elif modification == 'nonreciprocal':
                self.states[self.channel][3]['content']['canonical'] = False
            else:
                self.states['!other:test'] = copy.deepcopy(self.states[self.server])
                self.states[self.channel].append(self.event('m.space.parent', {'canonical': True, 'via': ['test']}, '!other:test'))
            with self.subTest(modification=modification), self.assertRaises(APIError):
                await removal_scope(self.service, self.session, self.server)

    async def test_a_new_channel_or_membership_change_invalidates_the_review(self):
        self.change_after = self.channel
        with self.assertRaises(APIError) as error:
            await removal_scope(self.service, self.session, self.server)
        self.assertEqual(error.exception.status, 409)
