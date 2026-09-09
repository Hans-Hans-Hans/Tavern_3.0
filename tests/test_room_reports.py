import asyncio
import copy
import json
import sqlite3
import time
from types import SimpleNamespace
import unittest

from api.room_reports import schema
from tests import test_moderation as fixture


class ReportMigrationTests(unittest.TestCase):
    def test_existing_private_reports_are_never_opted_into_room_review(self):
        db = sqlite3.connect(':memory:'); db.row_factory = sqlite3.Row
        db.execute('CREATE TABLE reports(id INTEGER PRIMARY KEY,room_id TEXT,reason TEXT,note TEXT)')
        db.execute("INSERT INTO reports VALUES(1,'!room:test','Sensitive old report','Private administrator note')")
        schema(SimpleNamespace(db=db)); schema(SimpleNamespace(db=db))
        row = db.execute('SELECT * FROM reports').fetchone()
        self.assertEqual(row['audience'], 'platform'); self.assertEqual(row['room_verified'], 0)
        self.assertEqual(row['note'], 'Private administrator note')
        self.assertEqual(db.execute('SELECT count(*) FROM room_report_reviews').fetchone()[0], 0)
        db.close()


class RoomReportTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.WarningTests.asyncTearDown
    request = fixture.WarningTests.request
    login = fixture.WarningTests.login
    managed = fixture.WarningTests.managed

    async def asyncSetUp(self):
        await fixture.WarningTests.asyncSetUp(self)
        self.policy = self.managed(); self.policy['roles'][1]['permissions'] = ['manage_reports']
        self.users['@moderator:test'] = {'password': 'Correct password!', 'admin': False}
        self.policy['members']['@moderator:test'] = ['moderator']
        for identity in ['!room:test', '!server:test']:
            self.rooms[identity]['members']['@moderator:test'] = 'join'
            self.rooms[identity]['powers']['users']['@moderator:test'] = 50
        self.event_room = '!room:test'
        original = self.service.matrix
        async def matrix(method, path, body=None, token=None, expected=True):
            result = await original(method, path, body, token, expected)
            if '/event/' in path and expected:
                result.update(room_id=self.event_room, sender='@alice:test')
            return result
        self.service.matrix = matrix
        # Normal deployment provisions the dedicated service identity when its
        # first administrator signs in. Delegated tests retain no admin session.
        owner, _, _ = await self.login('owner')
        await self.request('POST', '/api/auth/logout', {}, owner)

    async def submit(self, cookie, **changes):
        return await self.request('POST', '/api/reports', {'kind': 'message', 'roomId': '!room:test', 'eventId': '$event', 'reason': 'Reported harassment', 'evidence': 'Explicitly supplied excerpt', **changes}, cookie)

    async def shared(self, cookie):
        response = await self.submit(cookie, audience='room'); self.assertEqual(response.status, 201, await response.text())
        return (await response.json())['id']

    async def queue(self, cookie, room='!room:test', query=''):
        return await self.request('GET', '/api/moderation/reports?roomId=' + room + query, cookie=cookie)

    async def review(self, cookie, identity, **changes):
        return await self.request('PUT', '/api/moderation/reports/' + str(identity), {'roomId': '!room:test', 'status': 'reviewing', 'note': 'Private room moderator draft', 'revision': 0, **changes}, cookie)

    async def test_default_private_audience_and_admin_notes_never_reach_delegated_queue(self):
        alice, _, _ = await self.login(); moderator, _, _ = await self.login('moderator'); owner, _, _ = await self.login('owner')
        private = await self.submit(alice); self.assertEqual(private.status, 201)
        private_id = (await private.json())['id']; shared = await self.shared(alice)
        await self.request('PUT', '/api/admin/reports/' + str(shared), {'status': 'resolved', 'note': 'Platform-only investigation details'}, owner)
        response = await self.queue(moderator); self.assertEqual(response.status, 200, await response.text()); data = await response.json()
        self.assertEqual([row['id'] for row in data['reports']], [shared]); self.assertEqual(data['reports'][0]['status'], 'open')
        self.assertNotIn('Platform-only', json.dumps(data)); self.assertNotIn('platform_status', json.dumps(data))
        self.assertEqual((await self.request('GET', '/api/moderation/reports/' + str(private_id) + '?roomId=!room:test', cookie=moderator)).status, 404)
        self.assertEqual((await self.review(moderator, private_id)).status, 404)
        self.assertEqual((await self.request('GET', '/api/admin/reports', cookie=moderator)).status, 403)

    async def test_room_reviews_encrypt_notes_preserve_platform_review_and_do_not_expose_notes_to_reporter(self):
        alice, _, _ = await self.login(); moderator, _, _ = await self.login('moderator'); owner, _, _ = await self.login('owner')
        identity = await self.shared(alice)
        await self.request('PUT', '/api/admin/reports/' + str(identity), {'status': 'reviewing', 'note': 'Platform administrator note'}, owner)
        response = await self.review(moderator, identity, status='resolved'); self.assertEqual(response.status, 200, await response.text())
        result = await response.json(); self.assertEqual(result['revision'], 1); self.assertEqual(result['reviewer'], '@moderator:test')
        stored = self.service.store.db.execute('SELECT note FROM room_report_reviews WHERE report_id=?', (identity,)).fetchone()[0]
        self.assertNotIn('Private room', stored); self.assertEqual(self.service.store.open(stored), 'Private room moderator draft')
        platform = self.service.store.db.execute('SELECT status,note FROM reports WHERE id=?', (identity,)).fetchone()
        self.assertEqual(tuple(platform), ('reviewing', 'Platform administrator note'))
        own = await (await self.request('GET', '/api/reports', cookie=alice)).json(); self.assertEqual(own['reports'][0]['roomReview']['status'], 'resolved')
        self.assertNotIn('Private room', json.dumps(own)); self.assertNotIn('Platform administrator', json.dumps(own))
        self.assertNotIn('Private room', str(list(self.service.store.db.execute('SELECT detail FROM audit'))))
        self.assertFalse(any('/make_room_admin' in path for _, path, _, _ in self.upstream_calls))

    async def test_moderation_authority_is_fresh_for_each_read_and_write(self):
        alice, _, _ = await self.login(); moderator, _, _ = await self.login('moderator'); identity = await self.shared(alice)
        self.assertEqual((await self.queue(moderator)).status, 200)
        self.policy['roles'][1]['permissions'] = ['manage_messages']
        self.assertEqual((await self.queue(moderator)).status, 403); self.assertEqual((await self.review(moderator, identity)).status, 403)
        self.policy['roles'][1]['permissions'] = ['manage_reports']; self.rooms['!room:test']['powers']['users']['@moderator:test'] = 0
        self.assertEqual((await self.queue(moderator)).status, 403)
        self.rooms['!room:test']['powers']['users']['@moderator:test'] = 50; self.rooms['!server:test']['members']['@moderator:test'] = 'leave'
        self.assertEqual((await self.queue(moderator)).status, 403)
        self.rooms['!server:test']['members']['@moderator:test'] = 'join'; self.rooms['!room:test']['members']['@moderator:test'] = 'leave'
        self.assertEqual((await self.review(moderator, identity)).status, 403)

    async def test_all_canonical_parent_category_constraints_are_authoritative(self):
        alice, _, _ = await self.login(); moderator, _, _ = await self.login('moderator'); await self.shared(alice)
        second = self.managed('!second:test'); second['roles'][1]['permissions'] = ['manage_reports']; second['members']['@moderator:test'] = ['moderator']
        self.rooms['!second:test']['members']['@moderator:test'] = 'join'
        second['categoryOverrides'] = {'restricted': {'roles': {'moderator': {'manage_reports': -1}}}}
        self.extra['!second:test'].append({'type': 'io.tavern.server.layout', 'state_key': '', 'content': {'version': 1, 'categories': [{'id': 'restricted'}], 'channels': [{'id': '!room:test', 'category': 'restricted'}]}})
        self.assertEqual((await self.queue(moderator)).status, 403)
        second['overrides'] = {'!room:test': {'users': {'@moderator:test': {'manage_reports': 1}}}}
        self.assertEqual((await self.queue(moderator)).status, 200)
        second['version'] = 999; self.assertEqual((await self.queue(moderator)).status, 403)

    async def test_cross_room_event_sender_user_and_server_context_cannot_be_forged(self):
        alice, _, _ = await self.login()
        self.event_room = '!other:test'; self.assertEqual((await self.submit(alice, audience='room')).status, 400)
        self.event_room = '!room:test'; self.assertEqual((await self.submit(alice, audience='room', targetId='@unrelated:test')).status, 400)
        self.assertEqual((await self.submit(alice, audience='room', kind='user', targetId='@unrelated:test')).status, 400)
        self.assertEqual((await self.submit(alice, audience='room', kind='server')).status, 400)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM reports').fetchone()[0], 0)

    async def test_unmanaged_room_cannot_opt_in_and_reporter_session_revocation_prevents_insert(self):
        alice, _, _ = await self.login(); self.extra['!room:test'] = []
        self.assertEqual((await self.submit(alice, audience='room')).status, 400)
        self.managed()
        original = self.service.matrix
        async def revoke(method, path, body=None, token=None, expected=True):
            value = await original(method, path, body, token, expected)
            if '/event/' in path: self.service.store.db.execute("DELETE FROM sessions WHERE user_id='@alice:test'")
            return value
        self.service.matrix = revoke
        self.assertEqual((await self.submit(alice, audience='room')).status, 401)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM reports').fetchone()[0], 0)

    async def test_opaque_message_ids_are_encoded_and_not_treated_as_url_paths(self):
        alice, _, _ = await self.login()
        value = await self.submit(alice, audience='room', eventId='$opaque/id?part#fragment')
        self.assertEqual(value.status, 201, await value.text())
        row = self.service.store.db.execute('SELECT event_id FROM reports').fetchone()
        self.assertEqual(row[0], '$opaque/id?part#fragment')

    async def test_temporary_ban_prevents_review_even_if_kick_was_not_confirmed(self):
        alice, _, _ = await self.login(); moderator, _, _ = await self.login('moderator'); identity = await self.shared(alice)
        self.extra['!server:test'].append({'type': 'io.tavern.tempban', 'state_key': '@moderator:test', 'content': {'version': 1, 'until': int(time.time() * 1000) + 100000}})
        self.assertEqual((await self.review(moderator, identity)).status, 403)

    async def test_exact_room_scope_filtered_pagination_and_revision_conflicts(self):
        alice, _, _ = await self.login(); moderator, _, _ = await self.login('moderator'); identity = await self.shared(alice)
        responses = await asyncio.gather(self.review(moderator, identity, status='resolved'), self.review(moderator, identity, status='dismissed'))
        self.assertEqual(sorted(response.status for response in responses), [200, 409])
        self.assertEqual((await self.review(moderator, identity, roomId='!server:test', revision=1)).status, 404)
        db = self.service.store.db
        for index in range(55):
            inserted = db.execute("INSERT INTO reports(reporter,kind,room_id,event_id,reason,evidence,created,updated,audience,room_verified) VALUES('@alice:test','message','!room:test','$event','Shared reason','Explicit evidence',1,1,'room',1)").lastrowid
            db.execute('INSERT INTO room_report_reviews(report_id,updated) VALUES(?,1)', (inserted,))
        first = await (await self.queue(moderator)).json(); self.assertEqual(len(first['reports']), 50)
        last = await (await self.queue(moderator, query='&before=' + str(first['next']))).json(); self.assertEqual(len(last['reports']), 5); self.assertIsNone(last['next'])
        self.assertEqual(len({row['id'] for row in first['reports'] + last['reports']}), 55)
        for query in ['&before=garbage', '&before=-1', '&before=9223372036854775808', '&status=invalid']:
            self.assertEqual((await self.queue(moderator, query=query)).status, 400)
        self.assertEqual((await self.review(moderator, identity, revision=True)).status, 400)
        self.assertEqual((await self.review(moderator, identity, status=[])).status, 400)


if __name__ == '__main__': unittest.main()
