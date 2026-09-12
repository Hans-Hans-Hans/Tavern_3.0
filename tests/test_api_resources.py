import asyncio
import base64
import unittest
from urllib.parse import quote

from api.server import COOKIE
from tests import test_api as fixture


class ResourceAPITests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.AccountAPITests.asyncSetUp
    asyncTearDown = fixture.AccountAPITests.asyncTearDown
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login

    async def upload(self, cookie, body, path="/_matrix/media/v3/upload"):
        row = self.service.store.db.execute("SELECT device_id FROM sessions WHERE cookie_hash=?", (self.service.store.digest(cookie),)).fetchone()
        return await self.client.post("/api/matrix" + path, data=body, headers={"Origin": fixture.ORIGIN, "Cookie": COOKIE + "=" + cookie, "Authorization": "Bearer cookie-session:" + row[0], "Content-Type": "application/octet-stream"})

    async def set_limits(self, owner, maximum=1024, user=2048, total=4096):
        response = await self.request("PUT", "/api/admin/storage", {"maxUploadBytes": maximum, "userQuotaBytes": user, "globalQuotaBytes": total}, owner)
        self.assertEqual(response.status, 200, await response.text())

    async def test_room_admin_requires_authority_and_block_confirmation(self):
        user, _, _ = await self.login()
        denied = await self.request("GET", "/api/admin/rooms", cookie=user)
        self.assertEqual(denied.status, 403)
        owner, _, _ = await self.login("owner")
        response = await self.request("GET", "/api/admin/rooms?search=Test", cookie=owner)
        self.assertEqual((await response.json())["total_rooms"], 1)
        detail = await self.request("GET", "/api/admin/rooms/!room:test", cookie=owner)
        self.assertEqual((await detail.json())["members"]["total"], 2)
        bad = await self.request("PUT", "/api/admin/rooms/!room:test/block", {"block": True, "confirmation": "DELETE"}, owner)
        self.assertEqual(bad.status, 400)
        good = await self.request("PUT", "/api/admin/rooms/!room:test/block", {"block": True, "confirmation": "!room:test"}, owner)
        self.assertEqual(good.status, 200)
        self.assertTrue(self.rooms["!room:test"]["blocked"])
        self.assertEqual(len(self.rooms["!room:test"]["members"]), 2)
        self.assertFalse(any(method == "DELETE" for method, *_ in self.upstream_calls))

    async def test_domainless_native_room_admin_preserves_members_while_blocking_and_unblocking(self):
        identity = '!' + base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip('=')
        self.rooms[identity] = self.rooms.pop('!room:test')
        members = dict(self.rooms[identity]['members'])
        owner, _, _ = await self.login('owner')
        path = '/api/admin/rooms/' + quote(identity, safe='')
        detail = await self.request('GET', path, cookie=owner)
        self.assertEqual(detail.status, 200, await detail.text())
        value = await detail.json()
        self.assertEqual(value['room']['room_id'], identity)
        self.assertEqual(value['members']['total'], len(members))
        for blocked in [True, False]:
            result = await self.request('PUT', path + '/block', {'block': blocked, 'confirmation': identity}, owner)
            self.assertEqual(result.status, 200, await result.text())
            self.assertEqual(self.rooms[identity]['blocked'], blocked)
            detail = await self.request('GET', path, cookie=owner)
            self.assertEqual((await detail.json())['blocked'], blocked)
        self.assertEqual(self.rooms[identity]['members'], members)
        self.assertFalse(any(method == 'DELETE' for method, *_ in self.upstream_calls))

    async def test_domainless_admin_targets_still_require_native_admin_and_exact_confirmation(self):
        identity = '!' + 'A' * 43
        self.rooms[identity] = self.rooms.pop('!room:test')
        owner, _, _ = await self.login('owner')
        ordinary, _, _ = await self.login()
        path = '/api/admin/rooms/' + quote(identity, safe='')
        for method, suffix, payload in [('GET', '', None), ('PUT', '/block', {'block': True, 'confirmation': identity})]:
            denied = await self.request(method, path + suffix, payload, ordinary)
            self.assertEqual(denied.status, 403)
        denied = await self.request('PUT', path + '/block', {'block': True, 'confirmation': '!wrong:test'}, owner)
        self.assertEqual(denied.status, 400)
        self.assertFalse(any(path.startswith('/_synapse/admin/v1/rooms/') for _, path, *_ in self.upstream_calls))
        self.assertFalse(self.rooms[identity].get('blocked', False))

    async def test_malformed_admin_room_ids_never_reach_native_room_endpoints(self):
        owner, _, _ = await self.login('owner')
        for identity in ['!short', '!' + 'A' * 42 + 'B', '!' + 'A' * 43 + '=', '!a\x00:test', '!room:', '!' + 'A' * 250 + ':test']:
            path = '/api/admin/rooms/' + quote(identity, safe='')
            for method, suffix, payload in [('GET', '', None), ('PUT', '/block', {'block': True, 'confirmation': identity})]:
                denied = await self.request(method, path + suffix, payload, owner)
                self.assertEqual(denied.status, 400, (identity, await denied.text()))
        self.assertFalse(any(path.startswith('/_synapse/admin/v1/rooms/') for _, path, *_ in self.upstream_calls))

    async def test_existing_usage_is_paginated_and_encrypted_upload_counts_actual_bytes(self):
        self.media_usage = {"@alice:test": 1100, "@owner:test": 200}
        self.media_page_size = 1
        owner, _, _ = await self.login("owner")
        await self.set_limits(owner)
        user, _, _ = await self.login()
        uploaded = await self.upload(user, b"ciphertext" * 90)
        self.assertEqual(uploaded.status, 200, await uploaded.text())
        self.assertTrue((await uploaded.json())["content_uri"].startswith("mxc://"))
        stats = await self.request("GET", "/api/account/storage", cookie=user)
        data = await stats.json()
        self.assertEqual(data["ownUsedBytes"], 2000)
        self.assertEqual(data["globalUsedBytes"], 2200)
        denied = await self.upload(user, b"x" * 100)
        self.assertEqual(denied.status, 413)
        uploads = [row for row in self.upstream_calls if row[1].endswith("/upload")]
        self.assertEqual(len(uploads), 1)
        self.assertEqual(uploads[0][2], b"ciphertext" * 90)
        self.assertTrue(uploads[0][3].startswith("Bearer real-secret-token-"))

    async def test_unknown_length_stream_and_large_file_never_reach_upstream(self):
        owner, _, _ = await self.login("owner")
        await self.set_limits(owner)
        user, _, _ = await self.login()
        too_big = await self.upload(user, b"x" * 1025)
        self.assertEqual(too_big.status, 413)

        async def chunks():
            yield b"x" * 700
            yield b"x" * 700

        chunked = await self.upload(user, chunks())
        self.assertEqual(chunked.status, 413)
        self.assertFalse(any(row[1].endswith("/upload") for row in self.upstream_calls))
        stats = await self.request("GET", "/api/account/storage", cookie=user)
        self.assertEqual((await stats.json())["ownUsedBytes"], 0)

    async def test_concurrent_uploads_cannot_overbook_global_quota(self):
        owner, _, _ = await self.login("owner")
        await self.set_limits(owner, user=1024, total=1024)
        user, _, _ = await self.login()
        responses = await asyncio.gather(self.upload(user, b"a" * 800), self.upload(owner, b"b" * 800))
        self.assertEqual(sorted(response.status for response in responses), [200, 413])
        self.assertEqual(sum(self.media_usage.values()), 800)

    async def test_definite_rejection_releases_but_uncertain_upload_reserves_until_reconciled(self):
        owner, _, _ = await self.login("owner")
        await self.set_limits(owner)
        user, _, _ = await self.login()
        self.media_status = 403
        denied = await self.upload(user, b"x" * 800)
        self.assertEqual(denied.status, 403)
        self.assertEqual(self.service.uploads.view(user_id="@alice:test")["ownUsedBytes"], 0)
        self.media_status = 500
        uncertain = await self.upload(user, b"x" * 800)
        self.assertEqual(uncertain.status, 502)
        self.assertEqual(self.service.uploads.view(user_id="@alice:test")["ownUsedBytes"], 800)
        self.assertEqual(self.service.uploads.view()["uncertainReservations"], 1)
        self.media_status = 200
        results = await asyncio.wait_for(asyncio.gather(self.request("POST", "/api/admin/storage/reconcile", {}, owner), self.request("POST", "/api/admin/storage/reconcile", {}, owner)), timeout=3)
        self.assertEqual([response.status for response in results], [200, 200])
        self.assertEqual(self.service.uploads.view()["globalUsedBytes"], 0)

    async def test_async_upload_bypass_and_nonadmin_policy_mutation_are_rejected(self):
        owner, _, _ = await self.login("owner")
        user, _, _ = await self.login()
        for path in ("/_matrix/media/v1/create", "/_matrix/media/v3/upload/test/chosen", "/_matrix/client/v1/media/create"):
            response = await self.upload(user, b"x", path)
            self.assertEqual(response.status, 403, path)
        denied = await self.request("PUT", "/api/admin/storage", {}, user)
        self.assertEqual(denied.status, 403)
        invalid = await self.request("PUT", "/api/admin/storage", {"maxUploadBytes": 513 * 1024 * 1024}, owner)
        self.assertEqual(invalid.status, 400)

    async def test_admin_raises_limit_above_ten_mib_and_actual_stream_is_accounted(self):
        owner, _, _ = await self.login('owner')
        user, _, _ = await self.login()
        body = b'x' * (16 * 1024 * 1024)
        denied = await self.upload(user, body)
        self.assertEqual(denied.status, 413)
        await self.set_limits(owner, maximum=16 * 1024 * 1024, user=32 * 1024 * 1024, total=64 * 1024 * 1024)
        result = await self.upload(user, body)
        self.assertEqual(result.status, 200, await result.text())
        self.assertEqual(self.service.uploads.view('@alice:test')['ownUsedBytes'], len(body))
        self.assertEqual(list(self.service.uploads.buffer_directory.iterdir()), [])
        saved = await self.request('GET', '/api/admin/storage', cookie=owner)
        self.assertEqual((await saved.json())['maxUploadBytes'], len(body))
        self.assertEqual(self.service.store.get('storage_limits')['maxUploadBytes'], len(body))
        await self.set_limits(owner)
        blocked = await self.upload(user, b'x' * 1025)
        self.assertEqual(blocked.status, 413)
        self.assertEqual(self.service.uploads.view('@alice:test')['ownUsedBytes'], len(body))

    async def test_file_ceiling_and_quota_relationships_still_apply_after_increase(self):
        owner, _, _ = await self.login('owner')
        await self.set_limits(owner, maximum=512 * 1024 * 1024, user=1024 ** 3, total=10 * 1024 ** 3)
        good = self.service.store.get('storage_limits')
        for patch in [{'maxUploadBytes': True}, {'maxUploadBytes': 1023}, {'maxUploadBytes': 513 * 1024 * 1024},
                      {'maxUploadBytes': 100 * 1024 * 1024, 'userQuotaBytes': 20 * 1024 * 1024}]:
            response = await self.request('PUT', '/api/admin/storage', {**good, **patch}, owner)
            self.assertEqual(response.status, 400, await response.text())
            self.assertEqual(self.service.store.get('storage_limits'), good)


if __name__ == "__main__":
    unittest.main()
