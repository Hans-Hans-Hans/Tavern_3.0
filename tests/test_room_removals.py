import copy
import unittest
from unittest.mock import patch
from aiohttp import web
from api.server import APIError
from tests.test_room_removal_scope import RemovalScopeTests


class RoomRemovalTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = RemovalScopeTests.asyncTearDown
    request = RemovalScopeTests.request
    login = RemovalScopeTests.login

    async def asyncSetUp(self):
        await RemovalScopeTests.asyncSetUp(self)
        self.tasks, self.blocked, self.deletes, self.writes = {}, set(), [], []
        self.lose_ack = False
        policy = next(event for event in self.states[self.server] if event['type'] == 'io.tavern.roles')['content']
        policy.update(channelAdmissionVersion=1, channelAdmissions={self.channel: {'roleIds': ['everyone'], 'userIds': []}})
        self.states[self.server].append(self.event('io.tavern.server.layout', {'version': 1, 'categories': [{'id': 'games', 'name': 'Games'}], 'channels': [{'id': self.channel, 'category': 'games'}]}))
        previous = self.upstream_response
        async def native(request, payload):
            path = request.path
            if path.startswith('/_synapse/admin/v2/rooms/'):
                value = path.removeprefix('/_synapse/admin/v2/rooms/')
                if request.method == 'DELETE':
                    self.assertIn(value, {self.server, self.channel})
                    self.assertEqual(payload, {'block': True, 'purge': True, 'force_purge': False})
                    self.deletes.append(value); self.blocked.add(value)
                    identity = 'delete-' + str(len(self.deletes))
                    self.tasks[identity] = {'delete_id': identity, 'room_id': value, 'status': 'active', 'shutdown_room': None}
                    if self.lose_ack:
                        self.lose_ack = False
                        return web.json_response({'error': 'fixture acknowledgement unavailable'}, status=503)
                    return web.json_response({'delete_id': identity})
                if value.startswith('delete_status/'):
                    task = self.tasks.get(value.removeprefix('delete_status/'))
                    return web.json_response(task or {}, status=200 if task else 404)
                if value.endswith('/delete_status'):
                    tasks = [task for task in self.tasks.values() if task['room_id'] == value.removesuffix('/delete_status')]
                    return web.json_response({'results': tasks}, status=200 if tasks else 404)
            if path.startswith('/_synapse/admin/v1/rooms/'):
                value = path.removeprefix('/_synapse/admin/v1/rooms/')
                if value.endswith('/block'):
                    return web.json_response({'block': value.removesuffix('/block') in self.blocked})
                identity = value.split('/')[0]
                if identity not in self.states:
                    return web.json_response({'errcode': 'M_NOT_FOUND'}, status=404)
                if '/' not in value:
                    return web.json_response({'room_id': identity})
            if request.method == 'PUT' and path.startswith('/_matrix/client/v3/rooms/') and '/state/' in path:
                identity, suffix = path.removeprefix('/_matrix/client/v3/rooms/').split('/state/')
                kind, key = suffix.split('/', 1)
                existing = next((event for event in self.states[identity] if event['type'] == kind and event['state_key'] == key), None)
                if kind in {'io.tavern.roles', 'io.tavern.server.layout'}:
                    self.assertEqual(payload.get('io.tavern.previous_event'), existing['event_id'])
                self.writes.append((identity, kind, copy.deepcopy(payload), key))
                self.states[identity] = [event for event in self.states[identity] if event['type'] != kind or event['state_key'] != key]
                event = self.event(kind, copy.deepcopy(payload), key); event['event_id'] = '$write' + str(len(self.writes)); self.states[identity].append(event)
                return web.json_response({'event_id': event['event_id']})
            return await previous(request, payload)
        self.upstream_response = native

    async def review(self, identity=None):
        response = await self.request('POST', '/api/rooms/' + (identity or self.server) + '/removal-review', {}, cookie=self.cookie)
        self.assertEqual(response.status, 200, await response.text())
        return await response.json()

    async def action(self, job, action, data=None):
        response = await self.request('POST', '/api/room-removals/' + job['id'] + '/' + action, data or {}, cookie=self.cookie)
        self.assertEqual(response.status, 200, await response.text())
        return await response.json()

    def complete_native(self, identity, purge=True):
        task = next(task for task in self.tasks.values() if task['room_id'] == identity)
        task.update(status='complete', shutdown_room={'failed_to_kick_users': [], 'new_room_id': None})
        if purge:
            self.states.pop(identity)

    async def test_review_and_confirmation_are_separate_from_native_deletion_and_claim_the_exact_scope(self):
        job = await self.review()
        self.assertEqual(job['phase'], 'review'); self.assertEqual(self.deletes, [])
        response = await self.request('POST', '/api/room-removals/' + job['id'] + '/confirm', {'confirmation': 'wrong'}, cookie=self.cookie)
        self.assertEqual(response.status, 400)
        job = await self.action(job, 'confirm', {'confirmation': 'Games'})
        self.assertEqual(job['phase'], 'ready'); self.assertEqual(self.deletes, [])
        with self.assertRaises(APIError):
            self.service.room_removals.deny_calls(self.channel)
        competing = await self.review(self.channel)
        response = await self.request('POST', '/api/room-removals/' + competing['id'] + '/confirm', {'confirmation': 'Gaming Voice'}, cookie=self.cookie)
        self.assertEqual(response.status, 409)

    async def test_server_deletion_confirms_native_purge_and_parent_cleanup_before_deleting_the_space(self):
        job = await self.review(); job = await self.action(job, 'confirm', {'confirmation': 'Games'})
        job = await self.action(job, 'continue')
        self.assertEqual(self.deletes, [self.channel]); self.assertEqual(job['completed'], 0)
        job = await self.action(job, 'continue')
        self.assertEqual(self.deletes, [self.channel], 'Polling must not submit another native task.')
        self.complete_native(self.channel)
        job = await self.action(job, 'continue')
        self.assertEqual(job['completed'], 1); self.assertEqual(job['phase'], 'ready')
        self.assertEqual([kind for _, kind, _, _ in self.writes], ['io.tavern.roles', 'io.tavern.server.layout', 'm.space.child'])
        job = await self.action(job, 'continue')
        self.assertEqual(self.deletes, [self.channel, self.server])
        self.complete_native(self.server)
        job = await self.action(job, 'continue')
        self.assertEqual(job['phase'], 'complete'); self.assertEqual(job['completed'], 2)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM room_removal_claims').fetchone()[0], 0)

    async def test_a_lost_native_acknowledgement_is_reconciled_by_room_without_replaying_deletion(self):
        job = await self.review(self.channel); job = await self.action(job, 'confirm', {'confirmation': 'Gaming Voice'})
        self.lose_ack = True
        job = await self.action(job, 'continue'); self.assertEqual(job['phase'], 'attention')
        job = await self.action(job, 'continue', {'retry': True}); self.assertEqual(job['phase'], 'native_pending')
        self.assertEqual(self.deletes, [self.channel])
        self.complete_native(self.channel)
        job = await self.action(job, 'continue'); self.assertEqual(job['phase'], 'complete')
        self.assertEqual(self.deletes, [self.channel])

    async def test_a_native_complete_label_without_actual_absence_is_not_reported_as_deleted(self):
        job = await self.review(self.channel); job = await self.action(job, 'confirm', {'confirmation': 'Gaming Voice'})
        await self.action(job, 'continue'); self.complete_native(self.channel, purge=False)
        job = await self.action(job, 'continue')
        self.assertEqual(job['phase'], 'attention'); self.assertEqual(job['completed'], 0)
        self.assertEqual(self.writes, [])

    async def test_foreign_session_and_owner_loss_cannot_start_a_native_deletion(self):
        job = await self.review(self.channel); job = await self.action(job, 'confirm', {'confirmation': 'Gaming Voice'})
        stranger, _, _ = await self.login('owner')
        response = await self.request('POST', '/api/room-removals/' + job['id'] + '/continue', {}, cookie=stranger)
        self.assertEqual(response.status, 404)
        self.states[self.server][0]['sender'] = '@another:test'
        job = await self.action(job, 'continue'); self.assertEqual(job['phase'], 'attention')
        self.assertEqual(self.deletes, [])

    async def test_expired_or_changed_reviews_cannot_claim_rooms(self):
        job = await self.review(self.channel)
        self.service.store.db.execute('UPDATE room_removals SET created=0 WHERE id=?', (job['id'],))
        response = await self.request('POST', '/api/room-removals/' + job['id'] + '/confirm', {'confirmation': 'Gaming Voice'}, cookie=self.cookie)
        self.assertEqual(response.status, 409)
        job = await self.review(self.channel)
        self.states[self.server].append(self.event('m.room.member', {'membership': 'join'}, '@new:test'))
        response = await self.request('POST', '/api/room-removals/' + job['id'] + '/confirm', {'confirmation': 'Gaming Voice'}, cookie=self.cookie)
        self.assertEqual(response.status, 409)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM room_removal_claims').fetchone()[0], 0)

    async def test_journal_survives_service_recreation_and_account_list_retains_deleted_rooms(self):
        from api.room_removals import RoomRemovals
        job = await self.review(self.channel); job = await self.action(job, 'confirm', {'confirmation': 'Gaming Voice'})
        await self.action(job, 'continue')
        reopened = RoomRemovals(self.service)
        stored = reopened.load(job['id'], self.actor)
        self.assertEqual(stored['phase'], 'native_pending')
        self.complete_native(self.channel)
        await reopened.advance(stored, self.session, lambda: None)
        self.assertEqual(reopened.view(stored)['phase'], 'complete')
        response = await self.request('GET', '/api/room-removals', cookie=self.cookie)
        self.assertEqual((await response.json())['operations'][0]['phase'], 'complete')
        self.assertEqual(self.deletes, [self.channel])

    async def test_logout_during_service_credential_refresh_stops_native_delete(self):
        job = await self.review(self.channel); job = await self.action(job, 'confirm', {'confirmation': 'Gaming Voice'})
        original = self.service.service_token
        async def interrupted():
            token = await original()
            if self.service.store.db.execute('SELECT phase FROM room_removals WHERE id=?', (job['id'],)).fetchone()[0] == 'native_pending':
                self.service.store.db.execute('DELETE FROM sessions WHERE id=?', (self.session['id'],))
            return token
        with patch.object(self.service, 'service_token', interrupted):
            response = await self.request('POST', '/api/room-removals/' + job['id'] + '/continue', {}, cookie=self.cookie)
        self.assertEqual(response.status, 401)
        self.assertEqual(self.deletes, [])

    async def test_metadata_failure_resumes_without_redeleting_and_keeps_unrelated_layout(self):
        job = await self.review(self.channel); job = await self.action(job, 'confirm', {'confirmation': 'Gaming Voice'})
        await self.action(job, 'continue'); self.complete_native(self.channel)
        original = self.upstream_response
        async def unavailable(request, payload):
            if request.method == 'PUT' and 'io.tavern.server.layout' in request.path:
                return web.json_response({}, status=503)
            return await original(request, payload)
        self.upstream_response = unavailable
        job = await self.action(job, 'continue'); self.assertEqual(job['phase'], 'attention')
        self.assertEqual(job['completed'], 0)
        self.upstream_response = original
        job = await self.action(job, 'continue', {'retry': True}); self.assertEqual(job['phase'], 'complete')
        self.assertEqual(self.deletes, [self.channel])
        layout = next(e for e in self.states[self.server] if e['type'] == 'io.tavern.server.layout')['content']
        self.assertEqual(layout['categories'], [{'id': 'games', 'name': 'Games'}])

    async def test_new_channel_after_confirmation_pauses_server_deletion_without_expanding_scope(self):
        job = await self.review(); job = await self.action(job, 'confirm', {'confirmation': 'Games'})
        await self.action(job, 'continue'); self.complete_native(self.channel); await self.action(job, 'continue')
        self.states[self.server].append(self.event('m.space.child', {'via': ['test']}, '!new:test'))
        job = await self.action(job, 'continue'); self.assertEqual(job['phase'], 'attention')
        self.assertEqual(self.deletes, [self.channel])
