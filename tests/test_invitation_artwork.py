import unittest

from tests import test_api_community as fixture
from api.community_api import invitation_splash


class InvitationArtworkTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.CommunityAPITests.asyncTearDown
    request = fixture.CommunityAPITests.request
    login = fixture.CommunityAPITests.login
    create_invitation = fixture.CommunityAPITests.create_invitation
    add_user = fixture.CommunityAPITests.add_user

    async def asyncSetUp(self):
        await fixture.CommunityAPITests.asyncSetUp(self)
        self.branding = {'inviteSplash': 'mxc://test/shareable', 'banner': 'mxc://test/private-banner', 'welcome': 'Private server rules'}
        self.space = True
        self.artwork_reads = []
        self.after_artwork = None
        matrix = self.service.matrix

        async def native(method, path, *args, **kwargs):
            if path.endswith('/state/m.room.create/') or path.endswith('/state/io.tavern.server.branding/'):
                self.artwork_reads.append((path, kwargs.get('token')))
                if path.endswith('m.room.create/'):
                    return 200, {'type': 'm.space'} if self.space else {}
                if self.after_artwork:
                    self.after_artwork()
                return 200, self.branding
            return await matrix(method, path, *args, **kwargs)
        self.service.matrix = native

    async def preview(self, invitation, cookie=None):
        result = await self.request('GET', '/api/invitations/preview/' + invitation['token'], cookie=cookie)
        self.assertEqual(result.status, 200, await result.text())
        return await result.json()

    async def test_preview_uses_only_explicit_snapshot_without_private_state_or_tokens(self):
        owner, invitation = await self.create_invitation(splashMxc='mxc://test/forged')
        self.assertTrue(all(self.tokens[token][0] == '@owner:test' for _, token in self.artwork_reads))
        self.branding['inviteSplash'] = 'mxc://test/new-art'
        self.artwork_reads.clear(); self.upstream_calls.clear()
        value = await self.preview(invitation)
        self.assertEqual(value['splashMxc'], 'mxc://test/shareable')
        self.assertNotIn('Private', str(value)); self.assertNotIn('private-banner', str(value))
        self.assertEqual(self.artwork_reads, []); self.assertEqual(self.upstream_calls, [])
        stored = self.service.store.db.execute('SELECT * FROM invitations').fetchall()
        self.assertNotIn(invitation['token'], str([tuple(row) for row in stored]))
        listing = await self.request('GET', '/api/invitations', cookie=owner)
        self.assertNotIn(invitation['token'], await listing.text())

    async def test_restricted_artwork_requires_current_verified_recipient_and_active_account(self):
        _, invitation = await self.create_invitation(email='bob@example.com')
        self.assertEqual((await self.preview(invitation))['splashMxc'], '')
        bob = await self.add_user('bob')
        for email, verified in [('bob@example.com', 0), ('wrong@example.com', 1)]:
            self.service.store.db.execute('UPDATE accounts SET email=?,verified=? WHERE user_id=?', (email, verified, '@bob:test'))
            self.assertEqual((await self.preview(invitation, bob))['splashMxc'], '')
        self.service.store.db.execute("UPDATE accounts SET email='bob@example.com',verified=1 WHERE user_id='@bob:test'")
        self.assertEqual((await self.preview(invitation, bob))['splashMxc'], 'mxc://test/shareable')
        for flag in ('access_blocked', 'password_change_required'):
            self.service.store.db.execute('UPDATE accounts SET ' + flag + '=1 WHERE user_id=?', ('@bob:test',))
            self.assertEqual((await self.preview(invitation, bob))['splashMxc'], '')
            self.service.store.db.execute('UPDATE accounts SET ' + flag + '=0 WHERE user_id=?', ('@bob:test',))
        self.service.store.db.execute("UPDATE invitations SET revoked=1 WHERE id=?", (invitation['id'],))
        self.assertEqual((await self.request('GET', '/api/invitations/preview/' + invitation['token'], cookie=bob)).status, 404)

    async def test_domain_restriction_and_exhaustion_still_gate_artwork(self):
        _, invitation = await self.create_invitation(domain='example.com')
        bob = await self.add_user('bob')
        self.service.store.db.execute("UPDATE accounts SET email='bob@example.net',verified=1 WHERE user_id='@bob:test'")
        self.assertEqual((await self.preview(invitation, bob))['splashMxc'], '')
        self.service.store.db.execute("UPDATE accounts SET email='bob@example.com' WHERE user_id='@bob:test'")
        self.assertEqual((await self.preview(invitation, bob))['splashMxc'], 'mxc://test/shareable')
        self.service.store.db.execute('UPDATE invitations SET uses=max_uses WHERE id=?', (invitation['id'],))
        self.assertEqual((await self.request('GET', '/api/invitations/preview/' + invitation['token'], cookie=bob)).status, 404)

    async def test_only_spaces_share_artwork_and_issuer_is_rechecked_before_publication(self):
        self.space = False
        _, invitation = await self.create_invitation()
        self.assertEqual((await self.preview(invitation))['splashMxc'], '')
        self.assertFalse(any('branding' in path for path, _ in self.artwork_reads))
        self.space = True
        owner, _, _ = await self.login('owner')
        self.after_artwork = lambda: self.rooms['!room:test']['powers']['users'].update({'@owner:test': 0})
        denied = await self.request('POST', '/api/invitations', {'roomId': '!room:test'}, owner)
        self.assertEqual(denied.status, 403)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM invitations').fetchone()[0], 1)

    def test_artwork_rejects_external_urls_query_tokens_and_unbounded_values(self):
        for value in ('https://tracker.test/pixel', 'mxc://test/art?invite=secret', 'mxc://test/../secret', 'mxc://test/art#secret', 'mxc://test/' + 'a' * 1024, [], None):
            self.assertEqual(invitation_splash(value), '')
        self.assertEqual(invitation_splash('mxc://test/optimized-WebP_1'), 'mxc://test/optimized-WebP_1')
