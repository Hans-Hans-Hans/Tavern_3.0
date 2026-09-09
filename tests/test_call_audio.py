"""Actual cookie/API/issuer/Twirp boundaries with the native audio policy model."""
import asyncio
import copy
import json
import os
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import quote

from aiohttp import web
from aiohttp.test_utils import TestServer

from api.call_audio import AUDIO, PREVIOUS, audio_snapshot
from api.call_audio_permissions import WIRE_NAMES, grant_permissions, observed_permissions, project, twirp_permissions
from api.rtc_gateway import decode_jwt, RtcGateway
from api.server import APIError, COOKIE, body_json
from synapse_modules import tavern_policy as model
from tests import test_rtc_gateway as rtc

PARENT, OWNER, TARGET = '!server:test', '@owner:test', '@alice:test'


def native_event(kind, key, data, identity='$fixture', sender=OWNER):
    return {'type': kind, 'state_key': key, 'content': copy.deepcopy(data), 'event_id': identity, 'sender': sender}


class CallAudioTests(unittest.IsolatedAsyncioTestCase):
    request = rtc.RtcGatewayTests.request
    login = rtc.RtcGatewayTests.login
    token = rtc.RtcGatewayTests.token
    mint = rtc.RtcGatewayTests.mint
    authorize = rtc.RtcGatewayTests.authorize
    rows = rtc.RtcGatewayTests.rows
    due = rtc.RtcGatewayTests.due

    async def asyncSetUp(self):
        await rtc.RtcGatewayTests.asyncSetUp(self)
        self.toggle = patch.dict(os.environ, {'SFU_AUDIO_MODERATION_ENABLED': 'true'})
        self.toggle.start()
        self.rooms[PARENT] = copy.deepcopy(self.rooms[rtc.ROOM])
        self.extra = {rtc.ROOM: [native_event('m.space.parent', PARENT, {'canonical': True, 'via': ['test']})],
                      PARENT: [native_event('m.space.child', rtc.ROOM, {'via': ['test']})]}
        self.audio_events = {}
        self.save_count = 0
        self.native_write_hook = None
        original = self.upstream_response

        def state(identity):
            room = self.rooms[identity]
            creation = {'m.federate': False, **({'type': 'm.space'} if identity == PARENT else {})}
            return [native_event('m.room.create', '', creation), native_event('m.room.encryption', '', {'algorithm': 'm.megolm.v1.aes-sha2'}),
                    native_event('m.room.power_levels', '', room['powers']), native_event('m.room.name', '', {'name': room['name']}),
                    *[native_event('m.room.member', user, {'membership': membership}) for user, membership in room['members'].items()],
                    *self.extra.get(identity, []),
                    *[event for (scope, _), event in self.audio_events.items() if scope == identity]]
        self.native_state = state

        def mapping(identity):
            return {(item['type'], item['state_key']): SimpleNamespace(content=copy.deepcopy(item['content']), event_id=item['event_id'], sender=item['sender']) for item in state(identity)}
        self.mapping = mapping

        async def native(request, payload):
            if request.path.startswith('/_synapse/admin/v1/rooms/') and request.path.endswith('/state'):
                identity = request.path.removeprefix('/_synapse/admin/v1/rooms/').removesuffix('/state')
                if identity in self.rooms:
                    if self.native_hook:
                        response = await self.native_hook(request, payload)
                        if response is not None:
                            return response
                    return web.json_response({'state': state(identity)})
            if request.method == 'PUT' and '/state/' + AUDIO + '/' in request.path:
                identity, state_key = request.path.removeprefix('/_matrix/client/v3/rooms/').split('/state/' + AUDIO + '/')
                target = model.audio_target(state_key)
                user = self.tokens.get(request.headers.get('Authorization', '').removeprefix('Bearer '), ('',))[0]
                if self.native_write_hook:
                    await self.native_write_hook()
                async def get_room_state(room):
                    return mapping(room)
                policy = model.AudioModerationPolicy({'audio_moderation_enabled': os.environ['SFU_AUDIO_MODERATION_ENABLED'] == 'true'}, SimpleNamespace(get_room_state=get_room_state), model)
                probe = SimpleNamespace(type=AUDIO, room_id=identity, sender=user, state_key=state_key, content=payload)
                if await policy.check(probe, mapping(identity)) is not True:
                    return web.json_response({'errcode': 'M_FORBIDDEN'}, status=403)
                self.save_count += 1
                event_id = '$audio-' + str(self.save_count)
                self.audio_events[identity, target] = native_event(AUDIO, state_key, payload, event_id, user)
                return web.json_response({'event_id': event_id})
            return await original(request, payload)
        self.upstream_response = native
        self.support_value, self.support_status = {'version': 1}, 200
        self.support_raw = None
        self.sfu_failure = False
        self.sfu_after = None
        self.support_hook = None
        async def support(request):
            if self.support_hook:
                await self.support_hook()
            return web.Response(text=self.support_raw, content_type='application/json') if self.support_raw is not None else web.json_response(self.support_value, status=self.support_status)
        async def twirp(request):
            method, value = request.match_info['method'], await request.json()
            self.sfu_calls.append((method, value['room'], value))
            if self.sfu_failure:
                return web.json_response({'code': 'unavailable'}, status=503)
            if method == 'UpdateParticipant':
                for participant in self.participants:
                    if participant['identity'] == value['identity']:
                        participant['permission'] = value['permission']
            elif method == 'RemoveParticipant':
                self.participants[:] = [item for item in self.participants if item['identity'] != value['identity']]
            result = {'participants': copy.deepcopy(self.participants)} if method == 'ListParticipants' else {}
            # The pinned server's xtwirp defaults emit proto snake_case, proven
            # by the independent actual Go/HTTP probe, not browser JSON guesses.
            for participant in result.get('participants', []):
                if isinstance(participant.get('permission'), dict):
                    aliases = {canonical: wire for wire, canonical in WIRE_NAMES.items()}
                    participant['permission'] = {aliases.get(key, key): item for key, item in participant['permission'].items()}
            if self.sfu_after:
                await self.sfu_after(method)
            return web.json_response(result)
        app = web.Application()
        app.router.add_get('/tavern/sfu/audio-permissions', support)
        app.router.add_post('/twirp/livekit.RoomService/{method}', twirp)
        self.sfu_server = TestServer(app)
        await self.sfu_server.start_server()
        original_http = self.service.http
        class Http:
            def __getattr__(inner, key):
                return getattr(original_http, key)
            def route(inner, url):
                return str(self.sfu_server.make_url(url.removeprefix('http://livekit:7880'))) if url.startswith('http://livekit:7880/') else url
            def get(inner, url, **kwargs):
                return original_http.get(inner.route(url), **kwargs)
            def post(inner, url, **kwargs):
                return original_http.post(inner.route(url), **kwargs)
        self.service.http = Http()
        from api.call_moderation import CallModerator
        self.gateway.moderator.sfu = CallModerator.sfu.__get__(self.gateway.moderator)

    async def asyncTearDown(self):
        self.toggle.stop()
        if hasattr(self, 'sfu_server'):
            await self.sfu_server.close()
        await rtc.RtcGatewayTests.asyncTearDown(self)

    def saved(self, identity=rtc.ROOM, *, muted=False, deafened=False, event_id='$saved'):
        self.audio_events[identity, TARGET] = native_event(AUDIO, model.audio_state_key(TARGET), {'version': 1, 'muted': muted, 'deafened': deafened, PREVIOUS: None}, event_id)

    def path(self, room=rtc.ROOM, user=TARGET):
        return '/api/calls/audio/' + quote(room, safe='') + '/' + quote(user, safe='')

    async def controls(self, room=rtc.ROOM):
        response = await self.request('GET', self.path(room), cookie=self.owner_cookie)
        self.assertEqual(response.status, 200, await response.text())
        return await response.json()

    async def change(self, flag, value, room=rtc.ROOM, revision=None):
        current = await self.controls(room)
        return await self.request('POST', self.path(room), {'change': {flag: value}, 'revision': revision or current['revision'], 'confirmation': TARGET}, self.owner_cookie)

    async def connected(self):
        token = await self.mint()
        claims = decode_jwt(token, rtc.KEY, rtc.SECRET)
        self.participants.append({'identity': self.identity, 'permission': twirp_permissions(grant_permissions(claims['video']))})
        self.assertEqual((await self.authorize(token)).status, 204)
        return token

    async def test_real_native_cas_and_twirp_mute_deafen_are_independent_and_restore(self):
        await self.connected()
        before = copy.deepcopy(self.participants[0]['permission'])
        response = await self.change('muted', True)
        self.assertEqual(response.status, 200, await response.text())
        value = await response.json()
        self.assertTrue(value['saved'])
        self.assertEqual(value['local'], {'muted': True, 'deafened': False})
        self.assertEqual(value['enforcement']['status'], 'confirmed')
        permission = self.participants[0]['permission']
        self.assertEqual(permission['canPublishSources'], ['CAMERA', 'SCREEN_SHARE'])
        self.assertTrue(permission['tavernCanSubscribeAudio'])
        self.assertEqual((await self.change('deafened', True)).status, 200)
        self.assertFalse(self.participants[0]['permission']['tavernCanSubscribeAudio'])
        cleared = await self.change('muted', False)
        self.assertEqual(cleared.status, 200)
        self.assertTrue((await cleared.json())['enforcement']['rejoinRequired'])
        self.assertEqual(self.participants[0]['permission']['canPublishSources'], ['CAMERA', 'SCREEN_SHARE'])
        self.assertFalse(self.participants[0]['permission']['tavernCanSubscribeAudio'])
        self.assertEqual((await self.change('deafened', False)).status, 200)
        self.assertTrue(self.participants[0]['permission']['tavernCanSubscribeAudio'])
        self.participants.clear()  # The member chooses a fresh managed join.
        await self.connected()
        await self.due()
        self.assertEqual(self.participants[0]['permission'], before)
        self.assertEqual(self.rooms[rtc.ROOM]['members'][TARGET], 'join')

    async def test_server_flags_inherit_and_old_unrestricted_jwt_cannot_rejoin(self):
        old = await self.connected()
        response = await self.change('deafened', True, PARENT)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())['enforcement']['status'], 'pending')
        controls = await self.controls()
        self.assertFalse(controls['local']['deafened'])
        self.assertTrue(controls['effective']['deafened'])
        self.assertEqual({item['roomId'] for item in controls['scopes']}, {PARENT, rtc.ROOM})
        self.assertEqual((await self.authorize(old)).status, 403)
        new = await self.mint()
        self.assertFalse(decode_jwt(new, rtc.KEY, rtc.SECRET)['video']['tavernCanSubscribeAudio'])
        self.assertEqual((await self.authorize(new)).status, 204)

    async def test_unavailable_sfu_keeps_native_save_pending_and_worker_retries(self):
        await self.connected()
        self.sfu_failure = True
        response = await self.change('muted', True)
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertTrue(result['saved'])
        self.assertEqual(result['enforcement']['status'], 'pending')
        self.assertTrue(self.audio_events[rtc.ROOM, TARGET]['content']['muted'])
        self.sfu_failure = False
        await self.due()
        self.assertEqual((await self.controls())['enforcement']['status'], 'confirmed')

    async def test_stock_sfu_or_disabled_runtime_cannot_ignore_saved_restrictions(self):
        old = await self.connected()
        self.saved(deafened=True)
        self.support_value = {'server': 'ordinary livekit'}
        self.assertEqual((await self.token()).status, 503)
        self.assertEqual((await self.authorize(old)).status, 503)
        await self.due()
        self.assertEqual(self.participants, [])
        self.assertEqual(self.rooms[rtc.ROOM]['members'][TARGET], 'join')
        self.support_value = {'version': True}
        self.assertFalse((await self.controls())['available'])
        os.environ['SFU_AUDIO_MODERATION_ENABLED'] = 'false'
        self.assertEqual((await self.token()).status, 403)
        response = await self.change('deafened', False)
        self.assertEqual(response.status, 200, await response.text())
        self.assertFalse((await response.json())['local']['deafened'])

    async def test_current_hierarchy_confirmation_and_stale_native_revision_stop_writes(self):
        before = await self.controls()
        self.rooms[rtc.ROOM]['powers']['users'][TARGET] = 100
        self.assertEqual((await self.request('GET', self.path(), cookie=self.owner_cookie)).status, 403)
        self.rooms[rtc.ROOM]['powers']['users'][TARGET] = 50
        self.saved(deafened=True)
        response = await self.change('muted', True, revision=before['revision'])
        self.assertEqual(response.status, 409)
        current = await self.controls()
        response = await self.request('POST', self.path(), {'change': {'muted': True}, 'revision': current['revision'], 'confirmation': OWNER}, self.owner_cookie)
        self.assertEqual(response.status, 400)
        self.assertEqual(self.save_count, 0)

    async def test_revocation_during_capability_await_and_streamed_body_never_saves(self):
        current = await self.controls()
        async def revoke():
            self.rooms[rtc.ROOM]['members'][OWNER] = 'leave'
        self.support_hook = revoke
        response = await self.request('POST', self.path(), {'change': {'muted': True}, 'revision': current['revision'], 'confirmation': TARGET}, self.owner_cookie)
        self.assertEqual(response.status, 403)
        self.assertEqual(self.save_count, 0)
        self.support_hook = None
        self.rooms[rtc.ROOM]['members'][OWNER] = 'join'
        began, entered, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def body():
            yield b'{'
            began.set()
            await release.wait()
            yield json.dumps({'change': {'muted': True}, 'revision': current['revision'], 'confirmation': TARGET}).encode()[1:]
        async def actual_body(request, **kwargs):
            entered.set()
            return await body_json(request, **kwargs)
        with patch('api.call_audio.body_json', actual_body):
            task = asyncio.create_task(self.client.post(self.path(), headers={'Cookie': COOKIE + '=' + self.owner_cookie, 'Origin': rtc.ORIGIN, 'Content-Type': 'application/json'}, data=body()))
            await asyncio.wait_for(entered.wait(), 2)
            await began.wait()
            self.service.store.db.execute('DELETE FROM sessions WHERE user_id=?', (OWNER,))
            release.set()
            self.assertEqual((await task).status, 401)
        self.assertEqual(self.save_count, 0)

    async def test_restart_retains_baseline_and_native_intent_for_every_bound_device(self):
        await self.connected()
        self.saved(muted=True)
        baseline = self.rows()[0]['audio_baseline']
        replacement = RtcGateway(self.service)
        replacement.moderator = self.gateway.moderator
        self.gateway = self.service.rtc_gateway = replacement
        await self.due()
        self.assertEqual(self.rows()[0]['audio_baseline'], baseline)
        self.assertEqual(self.participants[0]['permission']['canPublishSources'], ['CAMERA', 'SCREEN_SHARE'])
        stored = json.dumps([dict(row) for row in self.rows()])
        for secret in (rtc.SECRET, 'fixture-openid-token', 'real-secret-token-'):
            self.assertNotIn(secret, stored)

    async def test_two_real_managed_devices_are_both_enforced_and_other_user_is_unchanged(self):
        await self.connected()
        cookie, profile, _ = await self.login()
        body = copy.deepcopy(self.body)
        body['member']['claimed_device_id'] = profile['deviceId']
        body['member']['id'] = 'second-member'
        response = await self.token(body, cookie=cookie)
        self.assertEqual(response.status, 200, await response.text())
        token = (await response.json())['jwt']
        claims = decode_jwt(token, rtc.KEY, rtc.SECRET)
        second = claims['sub']
        self.participants.append({'identity': second, 'permission': twirp_permissions(grant_permissions(claims['video']))})
        self.assertEqual((await self.authorize(token, cookie=cookie)).status, 204)
        # A separate exact registry binding, never a user-prefix inference.
        unrelated = dict(self.rows()[0])
        unrelated.update(identity='owner-device', user_id=OWNER)
        db = self.service.store.db
        db.execute('INSERT INTO rtc_admissions(' + ','.join(unrelated) + ') VALUES(' + ','.join('?' for _ in unrelated) + ')', tuple(unrelated.values()))
        untouched = {'identity': 'owner-device', 'permission': twirp_permissions(grant_permissions({}))}
        self.participants.append(copy.deepcopy(untouched))
        response = await self.change('deafened', True)
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertEqual(result['enforcement']['status'], 'confirmed')
        self.assertEqual(result['enforcement']['devices'], 2)
        self.assertTrue(all(item['permission']['tavernCanSubscribeAudio'] is False for item in self.participants if item['identity'] in (self.identity, second)))
        self.assertEqual(next(item for item in self.participants if item['identity'] == 'owner-device'), untouched)

    async def test_unknown_inventory_never_becomes_confirmed_and_late_state_change_remains_pending(self):
        await self.connected()
        self.participants.append({'identity': 'unmapped-opaque'})
        response = await self.change('muted', True)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())['enforcement']['status'], 'pending')
        self.assertIn({'identity': 'unmapped-opaque'}, self.participants)
        self.participants[:] = [item for item in self.participants if item['identity'] != 'unmapped-opaque']
        self.saved(muted=False, deafened=True, event_id='$before-enforcement')
        changed = False
        async def late(method):
            nonlocal changed
            if method == 'UpdateParticipant' and not changed:
                changed = True
                self.saved(muted=True, deafened=True, event_id='$changed-in-flight')
        self.sfu_after = late
        await self.due()
        self.assertTrue(self.rows()[0]['audio_pending'])
        self.assertNotEqual(self.rows()[0]['audio_revision'], (await audio_snapshot(self.service, rtc.ROOM, TARGET)).revision)
        self.sfu_after = None
        await self.due()
        self.assertFalse(self.rows()[0]['audio_pending'])
        self.assertFalse(self.participants[0]['permission']['tavernCanSubscribeAudio'])
        self.assertEqual(self.participants[0]['permission']['canPublishSources'], ['CAMERA', 'SCREEN_SHARE'])

    async def test_native_final_cas_denial_and_capability_revocation_publish_no_grants(self):
        current = await self.controls()
        async def stale():
            self.saved(deafened=True, event_id='$concurrent-native-save')
        self.native_write_hook = stale
        response = await self.request('POST', self.path(), {'change': {'muted': True}, 'revision': current['revision'], 'confirmation': TARGET}, self.owner_cookie)
        self.assertEqual(response.status, 403)
        self.assertEqual(self.save_count, 0)
        self.native_write_hook = None
        async def revoke():
            self.service.store.db.execute('DELETE FROM sessions WHERE id=?', (self.session['id'],))
        self.support_hook = revoke
        response = await self.token()
        self.assertEqual(response.status, 401)
        self.assertEqual(self.rows(), [])

    async def test_ignored_permission_extension_and_unsupported_fields_are_not_confirmation(self):
        await self.connected()
        async def ignore(method):
            if method == 'UpdateParticipant':
                self.participants[0]['permission'].pop('tavernCanSubscribeAudio', None)
        self.sfu_after = ignore
        response = await self.change('deafened', True)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())['enforcement']['status'], 'pending')
        self.assertTrue(self.rows()[0]['audio_pending'])

    async def test_departed_existing_target_can_be_cleared_while_off_without_enumeration(self):
        self.saved(deafened=True)
        self.rooms[rtc.ROOM]['members'][TARGET] = 'leave'
        os.environ['SFU_AUDIO_MODERATION_ENABLED'] = 'false'
        response = await self.change('deafened', False)
        self.assertEqual(response.status, 200, await response.text())
        self.assertFalse((await response.json())['local']['deafened'])
        self.assertEqual((await self.request('GET', self.path(user='@unknown:test'), cookie=self.owner_cookie)).status, 403)

    async def test_self_can_read_own_restriction_but_cannot_clear_it(self):
        self.saved(deafened=True)
        response = await self.request('GET', self.path(), cookie=self.cookie)
        self.assertEqual(response.status, 200, await response.text())
        value = await response.json()
        self.assertTrue(value['effective']['deafened'])
        self.assertEqual(value['permissions'], {'mute': False, 'deafen': False})
        response = await self.request('POST', self.path(), {'change': {'deafened': False}, 'revision': value['revision'], 'confirmation': TARGET}, self.cookie)
        self.assertEqual(response.status, 403)
        self.assertEqual(self.save_count, 0)
        self.rooms[rtc.ROOM]['members'][TARGET] = 'leave'
        self.assertEqual((await self.request('GET', self.path(), cookie=self.cookie)).status, 403)

    async def test_audio_only_publish_ceiling_is_not_unsafely_restored_after_clear(self):
        claims = {'roomJoin': True, 'room': rtc.room_alias(rtc.ROOM), 'canPublishSources': ['microphone']}
        self.issuer_result = {'url': rtc.ORIGIN.replace('https:', 'wss:') + '/livekit/sfu', 'jwt': rtc.signed(self.identity, video=claims)}
        await self.connected()
        response = await self.change('muted', True)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())['enforcement']['status'], 'confirmed')
        self.assertFalse(self.participants[0]['permission']['canPublish'])
        response = await self.change('muted', False)
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertEqual(result['enforcement']['status'], 'pending')
        self.assertTrue(result['enforcement']['rejoinRequired'])
        self.assertFalse(self.participants[0]['permission']['canPublish'])
        self.assertTrue(self.participants[0]['permission']['canPublishData'])
        # A fresh managed issuance is a new admission, not a guessed restoration
        # of a possibly external, same-value global publish denial.
        new = await self.mint()
        self.assertTrue(decode_jwt(new, rtc.KEY, rtc.SECRET)['video'].get('canPublish', True))

    async def test_unrelated_observed_permissions_and_video_limits_survive_full_update(self):
        await self.connected()
        current = self.participants[0]['permission']
        current.update(canPublishData=False, canSubscribe=False, canUpdateMetadata=True, canPublishSources=['SCREEN_SHARE'])
        response = await self.change('deafened', True)
        self.assertEqual(response.status, 200, await response.text())
        observed = self.participants[0]['permission']
        self.assertFalse(observed['canPublishData'])
        self.assertFalse(observed['canSubscribe'])
        self.assertTrue(observed['canUpdateMetadata'])
        self.assertEqual(observed['canPublishSources'], ['SCREEN_SHARE'])
        self.assertFalse(observed['tavernCanSubscribeAudio'])
        for _ in range(2):
            await self.due()
        self.assertEqual(self.participants[0]['permission']['canPublishSources'], ['SCREEN_SHARE'])
        # A pre-upgrade row has no provenance and may never broaden an observed
        # source mask during routine or deafen-only reconciliation either.
        self.service.store.db.execute('UPDATE rtc_admissions SET audio_last_muted=-1')
        await self.due()
        self.assertEqual(self.participants[0]['permission']['canPublishSources'], ['SCREEN_SHARE'])

    async def test_final_native_suspension_and_local_verification_change_are_not_hidden_by_audio_refresh(self):
        original = audio_snapshot
        count = 0
        async def snapshot(*args, **kwargs):
            nonlocal count
            result = await original(*args, **kwargs)
            count += 1
            if count == 2:
                self.users[TARGET]['suspended'] = True
            return result
        with patch('api.rtc_authority.audio_snapshot', snapshot):
            self.assertEqual((await self.token()).status, 403)
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.issuer_calls, [])
        self.users[TARGET]['suspended'] = False
        self.service.store.db.execute('UPDATE accounts SET email=?,verified=1 WHERE user_id=?', ('alice@example.com', TARGET))
        count = 0
        async def changed(*args, **kwargs):
            nonlocal count
            result = await original(*args, **kwargs)
            count += 1
            if count == 2:
                self.service.store.db.execute('UPDATE accounts SET verified=0 WHERE user_id=?', (TARGET,))
            return result
        with patch('api.rtc_authority.audio_snapshot', changed):
            self.assertEqual((await self.token()).status, 403)
        self.assertEqual(self.rows(), [])

    async def test_capability_response_bound_and_duplicate_security_fields_fail_closed(self):
        self.saved(deafened=True)
        for raw in ('{"version":1,"version":1}', '{"version":1,"padding":"' + 'x' * 2048 + '"}', '{"version":2}', 'ordinary livekit'):
            self.support_raw = raw
            self.assertEqual((await self.token()).status, 503)
            self.assertEqual(self.rows(), [])

    async def test_space_without_complete_registry_never_claims_idle_or_all_devices_confirmed(self):
        self.participants.append({'identity': 'unknown-preexisting-device'})
        response = await self.change('deafened', True, PARENT)
        self.assertEqual(response.status, 200, await response.text())
        value = await response.json()
        self.assertTrue(value['saved'])
        self.assertEqual(value['enforcement']['status'], 'pending')
        self.assertEqual(value['enforcement']['devices'], 0)
        self.assertIn({'identity': 'unknown-preexisting-device'}, self.participants)

    async def test_reread_archive_and_tombstone_changes_cannot_be_ignored_by_audio_fingerprint(self):
        token = await self.connected()
        for kind, value in (('io.tavern.channel', {'version': 1, 'kind': 'voice', 'archived': True}),
                            ('m.room.tombstone', {'replacement_room': '!replacement:test'})):
            count = 0
            async def changed(*args, **kwargs):
                nonlocal count
                result = await audio_snapshot(*args, **kwargs)
                count += 1
                if count == 1:
                    self.extra[rtc.ROOM].append(native_event(kind, '', value, '$changed-admission'))
                return result
            with patch('api.rtc_authority.audio_snapshot', changed):
                self.assertEqual((await self.authorize(token)).status, 403)
            self.extra[rtc.ROOM] = [item for item in self.extra[rtc.ROOM] if item['type'] != kind]

    async def test_same_value_external_source_mask_is_not_undone_by_mute_clear(self):
        await self.connected()
        self.assertEqual((await self.change('muted', True)).status, 200)
        # A same-value admin write has no distinct version in pinned LiveKit.
        self.participants[0]['permission']['canPublishSources'] = ['CAMERA', 'SCREEN_SHARE']
        response = await self.change('muted', False)
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertEqual(result['enforcement']['status'], 'pending')
        self.assertTrue(result['enforcement']['rejoinRequired'])
        self.assertEqual(self.participants[0]['permission']['canPublishSources'], ['CAMERA', 'SCREEN_SHARE'])
        await self.due()
        self.assertEqual(self.participants[0]['permission']['canPublishSources'], ['CAMERA', 'SCREEN_SHARE'])
        self.assertTrue(self.rows()[0]['audio_rejoin'])


if __name__ == '__main__':
    unittest.main()
