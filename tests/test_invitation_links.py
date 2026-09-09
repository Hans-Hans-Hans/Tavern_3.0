import asyncio
import re
import time
import unittest

from api import invitation_links
from api.room_authority import room_id
from api.server import APIError
from aiohttp import web
from tests import test_invitation_roles as role_fixture

V12_ROOM = '!Nhcu5BS-UMnFX7hBVfVSoXiD7OgH6iRT-xyIuqDnpYQ'


class RoomIdentifierTests(unittest.TestCase):
    def test_supported_legacy_and_domainless_native_room_ids(self):
        for value in ['!room:test', '!room:example.org:8448', '!room:[::1]:8448', V12_ROOM, '!' + 'A' * 43]:
            self.assertEqual(room_id(value), value)

    def test_malformed_room_ids_do_not_become_native_authority_targets(self):
        for value in [None, True, '', '!short', '!' + 'A' * 42, '!' + 'A' * 44, '!' + 'A' * 42 + 'B', V12_ROOM + '=', V12_ROOM + '/state', '!a/b:test', '!a\\b:test', '!a?b:test', '!a#b:test', '!a\x00:test', '!a\n:test', '!a\x7f:test', '!a :test', '!:test', '!room:', '!' + 'a' * 255 + ':' + 'b' * 255]:
            with self.subTest(value=value), self.assertRaises(APIError):
                room_id(value)


class InvitationLinkTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = role_fixture.InvitationRoleTests.asyncTearDown
    request = role_fixture.InvitationRoleTests.request
    login = role_fixture.InvitationRoleTests.login
    add_user = role_fixture.InvitationRoleTests.add_user
    create_invitation = role_fixture.InvitationRoleTests.create_invitation

    async def asyncSetUp(self):
        await role_fixture.InvitationRoleTests.asyncSetUp(self)
        self.policy['roles'][3]['permissions'].append('manage_server')

    async def create_named(self, name='guild-night', cookie=None, **options):
        cookie = cookie or (await self.login('owner'))[0]
        response = await self.request('POST', '/api/invitations', {'roomId': '!room:test', 'customSlug': name, **options}, cookie)
        return response, await response.json()

    async def test_name_shares_the_existing_record_counter_roles_and_email_restrictions(self):
        response, invite = await self.create_named(email='bob@example.com', defaultRoleIds=['reader'], sendEmail=True)
        self.assertEqual(response.status, 201, invite)
        self.assertEqual(invite['url'], 'https://tavern.example.com/invite/guild-night')
        self.assertIn(invite['url'], self.service.send_email.call_args.args[2])
        self.assertEqual(invite['customSlug'], 'guild-night')
        bob = await self.add_user('bob')
        denied = await self.request('POST', '/api/invitations/redeem', {'token': 'v:guild-night'}, bob)
        self.assertEqual(denied.status, 403)
        self.service.store.db.execute("UPDATE accounts SET email='bob@example.com',verified=1 WHERE user_id='@bob:test'")
        accepted = await self.request('POST', '/api/invitations/redeem', {'token': 'v:guild-night'}, bob)
        self.assertEqual(accepted.status, 200, await accepted.text())
        self.assertIn('reader', self.policy['members']['@bob:test'])
        resumed = await self.request('POST', '/api/invitations/redeem', {'token': invite['token']}, bob)
        self.assertEqual(resumed.status, 200)
        self.assertEqual(self.service.store.db.execute('SELECT uses FROM invitations').fetchone()[0], 1)
        self.assertFalse(any(token.startswith('impersonation-') for token in self.tokens))

    async def test_named_and_random_handles_share_atomic_last_use(self):
        _, invite = await self.create_named()
        bob, charlie = await self.add_user('bob'), await self.add_user('charlie')
        responses = await asyncio.gather(
            self.request('POST', '/api/invitations/redeem', {'token': 'v:guild-night'}, bob),
            self.request('POST', '/api/invitations/redeem', {'token': invite['token']}, charlie))
        self.assertEqual(sorted(response.status for response in responses), [200, 409])
        self.assertEqual(self.service.store.db.execute('SELECT uses FROM invitations').fetchone()[0], 1)

    async def test_duplicate_creation_is_atomic_and_name_survives_row_deletion(self):
        owner = (await self.login('owner'))[0]
        results = await asyncio.gather(self.create_named(cookie=owner), self.create_named(cookie=owner))
        self.assertEqual(sorted(response.status for response, _ in results), [201, 409])
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM invitations').fetchone()[0], 1)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM invitation_link_names').fetchone()[0], 1)
        self.service.store.db.execute('DELETE FROM invitations')
        invitation_links.schema(self.service.store)
        response, value = await self.create_named(cookie=owner)
        self.assertEqual(response.status, 409, value)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM invitations').fetchone()[0], 0)
        preview = await self.request('GET', '/api/invitations/preview/v:guild-night')
        self.assertEqual(preview.status, 404)

    async def test_invalid_and_reserved_names_do_not_reserve_or_create(self):
        owner = (await self.login('owner'))[0]
        for name in ['Abc', 'a', 'ab', 'a' * 49, 'a--b', '-abc', 'abc-', 'admin', 'api', 'a/b', 'a%2Fb', 'a\nb', 'a b', 'a_b', 1, True, [], {}]:
            response, value = await self.create_named(name, owner)
            self.assertEqual(response.status, 400, (name, value))
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM invitations').fetchone()[0], 0)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM invitation_link_names').fetchone()[0], 0)

    async def test_custom_names_need_manage_server_and_native_state_power(self):
        alice = (await self.login())[0]
        self.policy['roles'][3]['permissions'].remove('manage_server')
        response, _ = await self.create_named(cookie=alice)
        self.assertEqual(response.status, 403)
        ordinary = await self.request('POST', '/api/invitations', {'roomId': '!room:test'}, alice)
        self.assertEqual(ordinary.status, 201)
        self.policy['roles'][3]['permissions'].append('manage_server')
        self.rooms['!room:test']['powers']['state_default'] = 75
        response, _ = await self.create_named(cookie=alice)
        self.assertEqual(response.status, 403)
        self.rooms['!room:test']['powers']['state_default'] = 50
        response, value = await self.create_named(cookie=alice)
        self.assertEqual(response.status, 201, value)

    async def test_non_space_federated_and_departed_issuers_cannot_publish_names(self):
        owner = (await self.login('owner'))[0]
        for creation in ({'m.federate': False}, {'type': 'm.space'}, {'type': 'm.space', 'm.federate': True}):
            self.create_content = creation
            response, _ = await self.create_named(cookie=owner)
            self.assertEqual(response.status, 400)
        self.create_content = {'type': 'm.space', 'm.federate': False}
        self.rooms['!room:test']['members']['@owner:test'] = 'leave'
        response, _ = await self.create_named(cookie=owner)
        self.assertEqual(response.status, 403)

    async def test_roleless_server_allows_only_the_native_creator(self):
        original = self.service.matrix
        async def without_policy(method, path, body=None, token=None, expected=True):
            result = await original(method, path, body, token, expected)
            if path.startswith('/_synapse/admin/v1/rooms/') and path.endswith('/state'):
                result['state'] = [event for event in result['state'] if event['type'] != self.model.POLICY]
            return result
        self.service.matrix = without_policy
        alice = (await self.login())[0]
        self.rooms['!room:test']['powers']['users']['@alice:test'] = 100
        self.assertEqual((await self.create_named(cookie=alice))[0].status, 403)
        response, value = await self.create_named()
        self.assertEqual(response.status, 201, value)

    async def test_domainless_room_version_12_creator_power_applies_to_creation_and_redemption(self):
        self.create_content['room_version'] = '12'
        self.rooms[V12_ROOM] = self.rooms.pop('!room:test')
        self.rooms[V12_ROOM]['powers'] = {'users': {}, 'users_default': 0, 'state_default': 50, 'invite': 50}
        owner = (await self.login('owner'))[0]
        response, invitation = await self.create_named(cookie=owner, roomId=V12_ROOM)
        self.assertEqual(response.status, 201, invitation)
        self.assertEqual(invitation['roomId'], V12_ROOM)
        ordinary = await self.request('POST', '/api/invitations', {'roomId': V12_ROOM}, owner)
        self.assertEqual(ordinary.status, 201, await ordinary.text())
        alice = (await self.login())[0]
        self.assertEqual((await self.create_named('other-guild', alice, roomId=V12_ROOM))[0].status, 403)
        self.create_content['additional_creators'] = ['@alice:test']
        self.assertEqual((await self.create_named('other-guild', alice, roomId=V12_ROOM))[0].status, 201)
        bob = await self.add_user('bob')
        # Model the pinned v12 native invite rule at the HTTP test boundary;
        # the baseline fixture's older users-only rule cannot express it.
        async def native_v12(request, payload):
            if request.path.endswith('/invite'):
                token = request.headers.get('Authorization', '').removeprefix('Bearer ')
                actor = self.tokens.get(token, (None,))[0]
                if actor == '@owner:test' and self.rooms[V12_ROOM]['members'].get(actor) == 'join':
                    self.rooms[V12_ROOM]['members'][payload['user_id']] = 'invite'
                    return web.json_response({})
        self.upstream_response = native_v12
        accepted = await self.request('POST', '/api/invitations/redeem', {'token': 'v:guild-night'}, bob)
        self.assertEqual(accepted.status, 200, await accepted.text())
        self.assertEqual((await accepted.json())['roomId'], V12_ROOM)
        self.assertEqual(self.rooms[V12_ROOM]['members']['@bob:test'], 'join')
        self.assertFalse(any(token.startswith('impersonation-') for token in self.tokens))

    async def test_invalid_native_room_ids_are_rejected_before_creating_a_named_invitation(self):
        owner = (await self.login('owner'))[0]
        for identity in ['!short', '!' + 'A' * 42 + 'B', V12_ROOM + '=', V12_ROOM + '/state', '!a\x00:test', '!room:', '!' + 'A' * 512]:
            response, value = await self.create_named(cookie=owner, roomId=identity)
            self.assertEqual(response.status, 400, value)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM invitation_link_names').fetchone()[0], 0)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM invitations').fetchone()[0], 0)
        # A well-shaped hash is not a grant: native membership still must exist.
        self.assertEqual((await self.create_named(cookie=owner, roomId='!' + 'A' * 43))[0].status, 404)

    async def test_email_verification_loss_during_issuer_read_denies_before_reservation(self):
        await self.create_named(email='bob@example.com')
        bob = await self.add_user('bob')
        self.service.store.db.execute("UPDATE accounts SET email='bob@example.com',verified=1 WHERE user_id='@bob:test'")
        async def unverify():
            self.service.store.db.execute("UPDATE accounts SET verified=0 WHERE user_id='@bob:test'")
        self.after_state = unverify
        response = await self.request('POST', '/api/invitations/redeem', {'token': 'v:guild-night'}, bob)
        self.assertEqual(response.status, 403)
        self.assertEqual((await response.json())['errcode'], 'EMAIL_VERIFICATION_REQUIRED')
        self.assertNotIn('@bob:test', self.rooms['!room:test']['members'])
        self.assertEqual(self.service.store.db.execute('SELECT uses FROM invitations').fetchone()[0], 0)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM invitation_redemptions').fetchone()[0], 0)

    async def test_email_change_during_temporary_login_denies_before_native_invite(self):
        await self.create_named(domain='example.com')
        bob = await self.add_user('bob')
        self.service.store.db.execute("UPDATE accounts SET email='bob@example.com',verified=1 WHERE user_id='@bob:test'")
        original = self.service.matrix
        async def change_email(method, path, body=None, token=None, expected=True):
            result = await original(method, path, body, token, expected)
            if path.startswith('/_synapse/admin/v1/users/') and path.endswith('/login'):
                self.service.store.db.execute("UPDATE accounts SET email='bob@another.test' WHERE user_id='@bob:test'")
            return result
        self.service.matrix = change_email
        response = await self.request('POST', '/api/invitations/redeem', {'token': 'v:guild-night'}, bob)
        self.assertEqual(response.status, 403)
        self.assertNotIn('@bob:test', self.rooms['!room:test']['members'])
        self.assertEqual(self.service.store.db.execute('SELECT state FROM invitation_redemptions').fetchone()[0], 'reserved')
        self.assertFalse(any(token.startswith('impersonation-') for token in self.tokens))

    async def test_verification_loss_after_native_invite_denies_join_without_claiming_rollback(self):
        await self.create_named(email='bob@example.com')
        bob = await self.add_user('bob')
        self.service.store.db.execute("UPDATE accounts SET email='bob@example.com',verified=1 WHERE user_id='@bob:test'")
        original = self.service.matrix
        async def unverify_after_invite(method, path, body=None, token=None, expected=True):
            result = await original(method, path, body, token, expected)
            if path.endswith('/invite'):
                self.service.store.db.execute("UPDATE accounts SET verified=0 WHERE user_id='@bob:test'")
            return result
        self.service.matrix = unverify_after_invite
        response = await self.request('POST', '/api/invitations/redeem', {'token': 'v:guild-night'}, bob)
        self.assertEqual(response.status, 403)
        self.assertEqual(self.rooms['!room:test']['members']['@bob:test'], 'invite')
        self.assertFalse(any(token.startswith('impersonation-') for token in self.tokens))

    async def test_actual_account_cleanup_retains_permanent_name_reservation(self):
        alice = (await self.login())[0]
        response, value = await self.create_named(cookie=alice)
        self.assertEqual(response.status, 201, value)
        identity = self.service.deactivations.begin('@alice:test', False)
        self.service.deactivations.mark_confirmed(identity)
        self.service.deactivations.cleanup(identity)
        self.assertEqual(self.service.store.db.execute('SELECT revoked FROM invitations').fetchone()[0], 1)
        self.assertEqual(self.service.store.db.execute('SELECT slug FROM invitation_link_names').fetchone()[0], 'guild-night')
        self.assertEqual((await self.create_named())[0].status, 409)

    async def test_successful_named_registration_redeems_with_the_new_session(self):
        await self.create_named(email='new@example.com')
        self.service.store.set('policy', {'registrationMode': 'invite'})
        started = await self.request('POST', '/api/auth/register/start', {'username': 'newuser', 'password': 'A strong new password!', 'confirmation': 'A strong new password!', 'email': 'new@example.com', 'inviteToken': 'v:guild-night'})
        self.assertEqual(started.status, 200, await started.text())
        identity = (await started.json())['challengeId']
        code = re.search(r'\b\d{6}\b', self.service.send_email.call_args.args[2])[0]
        complete = await self.request('POST', '/api/auth/register/complete', {'challengeId': identity, 'code': code})
        self.assertEqual(complete.status, 200, await complete.text())
        self.assertEqual((await complete.json())['invitationRoomId'], '!room:test')
        self.assertEqual(self.rooms['!room:test']['members']['@newuser:test'], 'join')

    async def test_authority_and_session_changes_during_reads_prevent_publication(self):
        alice = (await self.login())[0]
        async def revoke_role():
            self.policy['roles'][3]['permissions'].remove('manage_server')
        self.after_state = revoke_role
        response, _ = await self.create_named(cookie=alice)
        self.assertEqual(response.status, 403)
        self.policy['roles'][3]['permissions'].append('manage_server')
        async def revoke_session():
            self.service.store.db.execute("DELETE FROM sessions WHERE user_id='@alice:test'")
        self.after_state = revoke_session
        response, _ = await self.create_named(cookie=alice)
        self.assertEqual(response.status, 401)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM invitation_link_names').fetchone()[0], 0)

    async def test_revocation_expiry_and_cleanup_cannot_retarget_or_reuse_names(self):
        owner, invite = await self.create_invitation(customSlug='guild-night')
        response = await self.request('DELETE', '/api/invitations/' + invite['id'], cookie=owner)
        self.assertEqual(response.status, 200)
        self.assertEqual((await self.request('GET', '/api/invitations/preview/v:guild-night')).status, 404)
        self.assertEqual((await self.create_named(cookie=owner))[0].status, 409)
        self.service.store.db.execute('UPDATE invitations SET revoked=0,expires=?', (time.time() - 1,))
        self.assertEqual((await self.request('GET', '/api/invitations/preview/v:guild-night')).status, 404)
        self.assertEqual((await self.create_named(cookie=owner))[0].status, 409)

    async def test_revocation_during_temporary_token_login_prevents_native_invite(self):
        owner, invite = await self.create_invitation(customSlug='guild-night')
        bob = await self.add_user('bob')
        original = self.service.matrix
        async def revoke_before_token(method, path, body=None, token=None, expected=True):
            result = await original(method, path, body, token, expected)
            if path.startswith('/_synapse/admin/v1/users/') and path.endswith('/login'):
                self.service.store.db.execute('UPDATE invitations SET revoked=1 WHERE id=?', (invite['id'],))
            return result
        self.service.matrix = revoke_before_token
        response = await self.request('POST', '/api/invitations/redeem', {'token': 'v:guild-night'}, bob)
        self.assertEqual(response.status, 404)
        self.assertNotIn('@bob:test', self.rooms['!room:test']['members'])
        self.assertFalse(any(token.startswith('impersonation-') for token in self.tokens))
        self.assertEqual(self.service.store.db.execute('SELECT state FROM invitation_redemptions').fetchone()[0], 'reserved')

    async def test_expiry_after_native_invite_preserves_invitation_but_prevents_join(self):
        _, invite = await self.create_invitation(customSlug='guild-night')
        bob = await self.add_user('bob')
        original = self.service.matrix
        async def expire_after_invite(method, path, body=None, token=None, expected=True):
            result = await original(method, path, body, token, expected)
            if path.endswith('/invite'):
                self.service.store.db.execute('UPDATE invitations SET expires=? WHERE id=?', (time.time() - 1, invite['id']))
            return result
        self.service.matrix = expire_after_invite
        response = await self.request('POST', '/api/invitations/redeem', {'token': 'v:guild-night'}, bob)
        self.assertEqual(response.status, 404)
        self.assertEqual(self.rooms['!room:test']['members']['@bob:test'], 'invite')
        self.assertFalse(any(token.startswith('impersonation-') for token in self.tokens))

    async def test_named_invitation_is_rechecked_during_email_registration(self):
        await self.create_named(email='new@example.com')
        self.service.store.set('policy', {'registrationMode': 'invite'})
        started = await self.request('POST', '/api/auth/register/start', {'username': 'newuser', 'password': 'A strong new password!', 'confirmation': 'A strong new password!', 'email': 'new@example.com', 'inviteToken': 'v:guild-night'})
        self.assertEqual(started.status, 200, await started.text())
        identity = (await started.json())['challengeId']
        code = re.search(r'\b\d{6}\b', self.service.send_email.call_args.args[2])[0]
        self.service.store.db.execute('UPDATE invitations SET revoked=1')
        complete = await self.request('POST', '/api/auth/register/complete', {'challengeId': identity, 'code': code})
        self.assertEqual(complete.status, 404)
        self.assertNotIn('@newuser:test', self.users)


if __name__ == '__main__':
    unittest.main()
