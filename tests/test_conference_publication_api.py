"""Real HTTP cookie/issuer/signaling/Twirp boundaries; no SFU media simulation claim."""
import copy
import os
import unittest

from api.call_audio_permissions import SOURCES, grant_permissions, project
from api.rtc_gateway import decode_jwt
from tests import test_call_audio as audio
from tests import test_rtc_gateway as rtc


def policy(**rights):
    return {'version': 1, 'callPublicationVersion': 1, 'owner': audio.OWNER,
        'roles': [{'id': 'everyone', 'name': 'Member', 'position': 0,
                   'permissions': ['join_calls', 'send_messages', *[key for key in ('speak', 'video', 'screen_share') if rights.get(key, True)]]}],
        'members': {}, 'overrides': {}, 'categoryOverrides': {}}


class PublicationAPITests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = audio.CallAudioTests.asyncSetUp
    asyncTearDown = audio.CallAudioTests.asyncTearDown
    request = rtc.RtcGatewayTests.request
    login = rtc.RtcGatewayTests.login
    token = rtc.RtcGatewayTests.token
    mint = rtc.RtcGatewayTests.mint
    authorize = rtc.RtcGatewayTests.authorize
    rows = rtc.RtcGatewayTests.rows
    due = rtc.RtcGatewayTests.due
    connected = audio.CallAudioTests.connected
    controls = audio.CallAudioTests.controls
    path = audio.CallAudioTests.path

    def set_policy(self, value, identity=audio.PARENT):
        self.extra.setdefault(identity, [])[:] = [item for item in self.extra.get(identity, []) if item['type'] != 'io.tavern.roles']
        self.extra[identity].append(audio.native_event('io.tavern.roles', '', value, '$roles-current'))

    async def test_speak_denial_removes_every_audio_source_and_old_jwt_cannot_signal(self):
        old = await self.mint()
        self.set_policy(policy(speak=False))
        self.assertEqual((await self.authorize(old)).status, 403)
        token = await self.mint()
        claims = decode_jwt(token, rtc.KEY, rtc.SECRET)
        self.assertEqual(claims['video']['canPublishSources'], ['camera', 'screen_share'])
        self.assertTrue(claims['video']['canPublishData'])
        self.assertEqual((await self.authorize(token)).status, 204)
        value = await self.controls()
        self.assertFalse(value['publication']['speak']); self.assertTrue(value['publication']['video'])

    async def test_camera_and_screen_roles_are_independent_and_empty_mask_closes_publish_not_data(self):
        for rights, expected in [({'video': False}, ['microphone', 'screen_share', 'screen_share_audio']),
                                 ({'screen_share': False}, ['camera', 'microphone']),
                                 ({'speak': False, 'video': False, 'screen_share': False}, [])]:
            self.set_policy(policy(**rights))
            token = await self.mint(); claims = decode_jwt(token, rtc.KEY, rtc.SECRET)
            self.assertEqual(claims['video']['canPublishSources'], expected)
            self.assertEqual(claims['video']['canPublish'], bool(expected))
            self.assertTrue(claims['video']['canPublishData'])
            self.assertEqual((await self.authorize(token)).status, 204)

    async def test_current_role_revocation_enforces_active_participant_and_restore_keeps_observed_ceiling(self):
        await self.connected()
        self.set_policy(policy(video=False))
        await self.due()
        self.assertEqual(self.participants[0]['permission']['canPublishSources'], ['MICROPHONE', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO'])
        self.set_policy(policy())
        await self.due()
        self.assertEqual(self.participants[0]['permission']['canPublishSources'], ['MICROPHONE', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO'])
        self.assertTrue(self.rows()[0]['audio_rejoin'])
        self.participants.clear()
        await self.connected(); await self.due()
        self.assertEqual(self.participants[0]['permission']['canPublishSources'], [])

    async def test_original_and_observed_source_and_global_publish_ceilings_are_never_broadened(self):
        await self.connected()
        self.set_policy(policy(speak=False))
        self.participants[0]['permission']['canPublishSources'] = ['SCREEN_SHARE']
        self.participants[0]['permission']['canPublishData'] = False
        await self.due()
        self.assertEqual(self.participants[0]['permission']['canPublishSources'], ['SCREEN_SHARE'])
        self.assertFalse(self.participants[0]['permission']['canPublishData'])
        self.participants[0]['permission']['canPublish'] = False
        self.set_policy(policy())
        await self.due()
        self.assertFalse(self.participants[0]['permission']['canPublish'])
        baseline = grant_permissions({'canPublishSources': ['microphone'], 'canPublishData': False})
        result = project(baseline, False, False, {'speak': False, 'video': True, 'screen_share': True})
        self.assertFalse(result['canPublish']); self.assertFalse(result['canPublishData'])

    async def test_missing_feature_capability_or_preupgrade_baseline_fails_closed_only_when_constrained(self):
        token = await self.mint()
        self.support_status = 404
        self.assertEqual((await self.authorize(token)).status, 204)
        self.set_policy(policy(speak=False))
        self.assertEqual((await self.authorize(token)).status, 503)
        response = await self.token()
        self.assertNotEqual(response.status, 200)
        self.support_status = 200
        os.environ['SFU_AUDIO_MODERATION_ENABLED'] = 'false'
        self.assertEqual((await self.authorize(token)).status, 403)
        os.environ['SFU_AUDIO_MODERATION_ENABLED'] = 'true'
        self.service.store.db.execute("UPDATE rtc_admissions SET audio_baseline=''")
        self.assertEqual((await self.authorize(token)).status, 403)

    async def test_role_change_during_final_native_reads_cannot_publish_stale_grant(self):
        self.set_policy(policy())
        counter = 0
        async def changed(request, payload):
            nonlocal counter
            if request.path.endswith('/state'):
                counter += 1
                if counter == 4: self.set_policy(policy(speak=False))
        self.native_hook = changed
        response = await self.token()
        # Either a complete current restriction is returned or the changed
        # observation is rejected; an unrestricted stale JWT is never emitted.
        if response.status == 200:
            value = await response.json()
            self.assertNotIn('microphone', decode_jwt(value['jwt'], rtc.KEY, rtc.SECRET)['video'].get('canPublishSources', list(SOURCES)))
        else: self.assertIn(response.status, (403, 503))

    async def test_all_reciprocal_ancestors_apply_even_when_nearer_space_has_own_policy(self):
        top = '!top:test'; self.rooms[top] = copy.deepcopy(self.rooms[audio.PARENT])
        # Fixture state builder recognizes its primary Space; provide the same
        # native create type for the additional ancestor without bypassing reads.
        self.extra[top] = [audio.native_event('m.room.create', '', {'type': 'm.space', 'm.federate': False}),
                           audio.native_event('m.space.child', audio.PARENT, {'via': ['test']})]
        self.extra[audio.PARENT].append(audio.native_event('m.space.parent', top, {'via': ['test'], 'canonical': True}))
        self.set_policy(policy(), audio.PARENT)
        self.set_policy(policy(screen_share=False), top)
        token = await self.mint()
        self.assertEqual(decode_jwt(token, rtc.KEY, rtc.SECRET)['video']['canPublishSources'], ['camera', 'microphone'])
