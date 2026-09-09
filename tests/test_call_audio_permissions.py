import unittest

from api.call_audio_permissions import WIRE_NAMES, attenuated, grant_permissions, observed_permissions, project, projected_claims, stored_permissions, twirp_permissions


class AudioPermissionTests(unittest.TestCase):
    def test_empty_source_intersection_denies_publish_without_revoking_data_or_video_subscription(self):
        baseline = grant_permissions({'canPublishSources': ['microphone'], 'canPublishData': True})
        muted = project(baseline, True, False)
        self.assertFalse(muted['canPublish'])
        self.assertTrue(muted['canPublishData'])
        self.assertTrue(muted['canSubscribe'])
        self.assertTrue(muted['tavernCanSubscribeAudio'])
        self.assertFalse(attenuated(baseline, muted))
        self.assertTrue(attenuated(muted, baseline))
        self.assertEqual(project(baseline, False, False), baseline)

    def test_deafen_preserves_publish_and_other_explicit_permissions(self):
        baseline = grant_permissions({'canPublish': False, 'canPublishData': True, 'canSubscribe': False, 'canUpdateOwnMetadata': True})
        projected = project(baseline, False, True)
        self.assertEqual({key: item for key, item in projected.items() if key != 'tavernCanSubscribeAudio'}, {key: item for key, item in baseline.items() if key != 'tavernCanSubscribeAudio'})
        claims = {'sub': 'user', 'video': {'roomJoin': True, 'room': 'alias'}}
        result = projected_claims(claims, projected)
        self.assertTrue(result['video']['canUpdateOwnMetadata'])
        self.assertNotIn('canUpdateMetadata', result['video'])
        self.assertNotIn('tavernCanSubscribeAudio', claims['video'])

    def test_strict_types_unknown_sources_and_unconfirmed_extension_fail(self):
        for value in ({'canPublish': 1}, {'tavernCanSubscribeAudio': None}, {'canPublishSources': ['audio']}, {'canPublishSources': ['camera', 'camera']}):
            with self.assertRaises(ValueError):
                grant_permissions(value)
        for value in ({}, {'tavernCanSubscribeAudio': 0}, {'tavernCanSubscribeAudio': False, 'canPublishSources': [True]}):
            with self.assertRaises(ValueError):
                observed_permissions(value)
        expected = grant_permissions({})
        self.assertEqual(observed_permissions(twirp_permissions(expected)), expected)
        observed = observed_permissions({'tavernCanSubscribeAudio': False})
        self.assertFalse(observed['canPublish'])
        self.assertFalse(observed['canSubscribe'])

    def test_actual_pinned_twirp_wire_names_and_ambiguous_aliases(self):
        # Captured from real pinned server ListParticipants over HTTP; ordinary
        # defaults are emitted and the optional explicit false is preserved.
        actual = {'agent': False, 'can_manage_agent_session': False, 'can_publish': True,
                  'can_publish_data': True, 'can_publish_sources': [], 'can_subscribe': True,
                  'can_subscribe_metrics': False, 'can_update_metadata': False, 'hidden': False,
                  'recorder': False, 'tavern_can_subscribe_audio': False}
        expected = project(grant_permissions({}), False, True)
        self.assertEqual(observed_permissions(actual), expected)
        for extra in ({'tavernCanSubscribeAudio': False}, {'tavernCanSubscribeAudio': True}, {'future_field': False}):
            with self.assertRaises(ValueError):
                observed_permissions({**actual, **extra})


if __name__ == '__main__':
    unittest.main()
