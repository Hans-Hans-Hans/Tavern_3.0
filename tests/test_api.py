import asyncio
import json
import re
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from api.server import APIError, COOKIE, Config, create_app
from api.security import totp, totp_setup

ORIGIN = "https://tavern.example.com"


class AccountAPITests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.upstream_calls = []
        self.upstream_response = None
        self.users = {"@alice:test": {"password": "Correct password!", "admin": False}, "@owner:test": {"password": "Correct password!", "admin": True}}
        self.tokens = {}
        self.device_count = 0
        self.uia_extra = False
        self.media_usage = {}
        self.media_status = 200
        self.media_page_size = 100
        self.rooms = {"!room:test": {"name": "Test room", "members": {"@alice:test": "join", "@owner:test": "join"}, "powers": {"users": {"@alice:test": 50, "@owner:test": 100}, "users_default": 0, "invite": 50}}}

        async def upstream(request):
            path, method = request.path, request.method
            payload = (await request.json() if request.content_type == "application/json" else await request.read()) if request.can_read_body else None
            self.upstream_calls.append((method, path, payload, request.headers.get("Authorization")))
            if self.upstream_response:
                response = await self.upstream_response(request, payload)
                if response is not None:
                    return response
            if path == "/_matrix/client/v3/login":
                user = payload["identifier"]["user"]
                user = user if user.startswith("@") else "@" + user + ":test"
                if user not in self.users or payload["password"] != self.users[user]["password"]:
                    return web.json_response({"errcode": "M_FORBIDDEN"}, status=403)
                self.device_count += 1
                token = "real-secret-token-" + str(self.device_count)
                self.tokens[token] = (user, "D" + str(self.device_count))
                return web.json_response({"user_id": user, "device_id": "D" + str(self.device_count), "access_token": token})
            if path == "/_synapse/admin/v1/register":
                if method == "GET":
                    return web.json_response({"nonce": "nonce"})
                user = "@" + payload["username"] + ":test"
                if user in self.users:
                    return web.json_response({"errcode": "M_USER_IN_USE"}, status=400)
                self.users[user] = {"password": payload["password"], "admin": payload["admin"]}
                self.device_count += 1
                token = "real-secret-token-" + str(self.device_count)
                self.tokens[token] = (user, "D" + str(self.device_count))
                return web.json_response({"user_id": user, "device_id": "D" + str(self.device_count), "access_token": token})
            token = request.headers.get("Authorization", "").removeprefix("Bearer ")
            identity = self.tokens.get(token)
            if not identity:
                return web.json_response({"errcode": "M_UNKNOWN_TOKEN"}, status=401)
            user, device = identity
            if path == "/_synapse/admin/v1/statistics/users/media":
                offset = int(request.query.get("from", "0"))
                rows = [{"user_id": key, "media_length": value} for key, value in sorted(self.media_usage.items())]
                result = {"users": rows[offset:offset + self.media_page_size], "total": len(rows)}
                if offset + self.media_page_size < len(rows):
                    result["next_token"] = offset + self.media_page_size
                return web.json_response(result)
            if path.startswith("/_matrix/media/") and path.endswith("/upload"):
                if self.media_status != 200:
                    return web.json_response({"errcode": "M_FORBIDDEN"}, status=self.media_status)
                self.media_usage[user] = self.media_usage.get(user, 0) + len(payload)
                return web.json_response({"content_uri": "mxc://test/file-" + str(len(self.upstream_calls))})
            if path.endswith("/admin"):
                return web.json_response({"admin": self.users[user]["admin"]})
            if path == "/_synapse/admin/v2/users":
                return web.json_response({"users": [{"name": key} for key in self.users], "total": len(self.users)})
            if path.startswith('/_synapse/admin/v2/users/'):
                target, _, action = path.removeprefix('/_synapse/admin/v2/users/').partition('/')
                if not self.users[user]['admin']:
                    return web.json_response({'errcode': 'M_FORBIDDEN'}, status=403)
                if target not in self.users:
                    return web.json_response({}, status=404)
                if action == 'devices':
                    return web.json_response({'devices': [{'device_id': value[1]} for value in self.tokens.values() if value[0] == target]})
                if action == 'delete_devices':
                    self.tokens = {key: value for key, value in self.tokens.items() if value[0] != target or value[1] not in payload['devices']}
                    return web.json_response({})
                if not action and method == 'PUT':
                    self.users[target].update(payload)
                if not action and method in ('GET', 'PUT'):
                    return web.json_response({'name': target, 'deactivated': False, **self.users[target]})
            if path.startswith('/_synapse/admin/v1/suspend/'):
                target = path.removeprefix('/_synapse/admin/v1/suspend/')
                if not self.users[user]['admin'] or target not in self.users:
                    return web.json_response({'errcode': 'M_FORBIDDEN'}, status=403)
                self.users[target]['suspended'] = payload['suspend']
                return web.json_response({})
            if path.startswith('/_synapse/admin/v1/deactivate/'):
                target = path.removeprefix('/_synapse/admin/v1/deactivate/')
                if not self.users[user]['admin'] or target not in self.users:
                    return web.json_response({'errcode': 'M_FORBIDDEN'}, status=403)
                self.users[target]['deactivated'] = True
                return web.json_response({'id_server_unbind_result': 'no-support'})
            if path.startswith("/_synapse/admin/v1/users/") and path.endswith("/login"):
                target = path.removeprefix("/_synapse/admin/v1/users/").removesuffix("/login")
                self.device_count += 1
                temporary = "impersonation-" + str(self.device_count)
                self.tokens[temporary] = (target, None)
                return web.json_response({"access_token": temporary})
            if path.startswith("/_synapse/admin/v1/rooms/") and path.endswith("/state"):
                room_id = path.removeprefix("/_synapse/admin/v1/rooms/").removesuffix("/state")
                room = self.rooms.get(room_id)
                if not room:
                    return web.json_response({}, status=404)
                return web.json_response({"state": [{"type": "m.room.member", "state_key": member, "content": {"membership": membership}} for member, membership in room["members"].items()] + [{"type": "m.room.power_levels", "state_key": "", "content": room["powers"]}, {"type": "m.room.encryption", "state_key": "", "content": {"algorithm": "m.megolm.v1.aes-sha2"}}]})
            if path == "/_matrix/client/v3/keys/query":
                return web.json_response({"device_keys": {target: {target_device: {"keys": {"ed25519:" + target_device: "A" * 43}} for target_device in devices} for target, devices in payload["device_keys"].items()}})
            if path == "/_synapse/admin/v1/rooms":
                search = request.query.get("search_term", "").casefold()
                rows = [{"room_id": key, "name": value["name"], "joined_members": len(value["members"])} for key, value in self.rooms.items() if search in value["name"].casefold()]
                return web.json_response({"rooms": rows, "total_rooms": len(rows)})
            if path.startswith("/_synapse/admin/v1/rooms/"):
                room_id, _, action = path.removeprefix("/_synapse/admin/v1/rooms/").partition("/")
                room = self.rooms.get(room_id)
                if not room:
                    return web.json_response({}, status=404)
                if action == "members":
                    return web.json_response({"members": list(room["members"]), "total": len(room["members"])})
                if action == "block":
                    if method == "PUT":
                        room["blocked"] = payload["block"]
                    return web.json_response({"block": room.get("blocked", False)})
                return web.json_response({"room_id": room_id, "name": room["name"], "encryption": "m.megolm.v1.aes-sha2"})
            if path.startswith("/_matrix/client/v3/rooms/"):
                pieces = path.removeprefix("/_matrix/client/v3/rooms/").split("/")
                room_id, action = pieces[0], "/".join(pieces[1:])
                room = self.rooms.get(room_id)
                if not room:
                    return web.json_response({}, status=404)
                if action.startswith("state/m.room.member/"):
                    target = action.removeprefix("state/m.room.member/")
                    return web.json_response({"membership": room["members"].get(target, "leave")})
                if action == "state/m.room.power_levels/":
                    return web.json_response(room["powers"])
                if action == "state/m.room.name/":
                    return web.json_response({"name": room["name"]})
                if action == "invite":
                    if room["members"].get(user) != "join" or room["powers"]["users"].get(user, 0) < room["powers"]["invite"] or room["members"].get(payload["user_id"]) == "ban":
                        return web.json_response({"errcode": "M_FORBIDDEN"}, status=403)
                    room["members"][payload["user_id"]] = "invite"
                    return web.json_response({})
                if action.startswith("event/"):
                    if room["members"].get(user) != "join":
                        return web.json_response({"errcode": "M_FORBIDDEN"}, status=403)
                    return web.json_response({"event_id": action.removeprefix("event/"), "type": "m.room.encrypted", "content": {"ciphertext": "encrypted"}})
            if path.startswith("/_matrix/client/v3/join/"):
                room_id = path.removeprefix("/_matrix/client/v3/join/")
                if self.rooms[room_id]["members"].get(user) not in {"invite", "join"}:
                    return web.json_response({"errcode": "M_FORBIDDEN"}, status=403)
                self.rooms[room_id]["members"][user] = "join"
                return web.json_response({"room_id": room_id})
            if path == "/_matrix/client/v3/joined_rooms":
                return web.json_response({"joined_rooms": [room_id for room_id, room in self.rooms.items() if room["members"].get(user) == "join"]})
            if "/account_data/" in path:
                return web.json_response({"theme": "light"})
            if path.startswith("/_matrix/client/v3/profile/"):
                return web.json_response({"displayname": user})
            if path == "/_matrix/client/v3/logout":
                self.tokens.pop(token, None)
                return web.json_response({})
            if path == "/_matrix/client/v3/devices":
                return web.json_response({"devices": [{"device_id": value[1]} for value in self.tokens.values() if value[0] == user]})
            if path in {"/_matrix/client/v3/account/password", "/_matrix/client/v3/account/deactivate", "/_matrix/client/v3/delete_devices"}:
                if payload.get("auth", {}).get("session") != "UIA-session":
                    stages = ["m.login.password", "m.login.totp"] if self.uia_extra else ["m.login.password"]
                    return web.json_response({"session": "UIA-session", "flows": [{"stages": stages}]}, status=401)
                if payload["auth"]["password"] != self.users[user]["password"]:
                    return web.json_response({"errcode": "M_FORBIDDEN"}, status=403)
                if path.endswith("password"):
                    self.users[user]["password"] = payload["new_password"]
                    if payload.get("logout_devices"):
                        self.tokens = {key: val for key, val in self.tokens.items() if val[0] != user or key == token}
                elif path.endswith("deactivate"):
                    self.users[user]['deactivated'] = True
                    self.tokens = {key: val for key, val in self.tokens.items() if val[0] != user}
                elif path.endswith("delete_devices"):
                    self.tokens = {key: val for key, val in self.tokens.items() if val[0] != user or val[1] not in payload["devices"]}
                return web.json_response({})
            if path.startswith("/_synapse/admin/v1/reset_password/"):
                target = path.rsplit("/", 1)[-1]
                self.users[target]["password"] = payload["new_password"]
                self.tokens = {key: val for key, val in self.tokens.items() if val[0] != target}
                return web.json_response({})
            return web.json_response({"ok": True, "path": path})

        upstream_app = web.Application(client_max_size=20 * 1024 * 1024)
        upstream_app.router.add_route("*", "/{path:.*}", upstream)
        self.upstream = TestServer(upstream_app)
        await self.upstream.start_server()
        folder = Path(self.directory.name)
        (folder / "homeserver.yaml").write_text("registration_shared_secret: test-secret\n")
        self.config = Config(ORIGIN, folder / "data", str(self.upstream.make_url("")), folder / "homeserver.yaml", folder / "bootstrap-marker")
        self.app = create_app(self.config)
        self.service = self.app["service"]
        self.service.send_email = AsyncMock()
        self.service.store.set("smtp", {"enabled": True, "host": "smtp.example.com", "port": 587, "secure": False, "fromAddress": "tavern@example.com"})
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        await self.upstream.close()
        self.directory.cleanup()

    async def request(self, method, path, body=None, cookie=None, origin=ORIGIN):
        headers = {"Origin": origin} if origin else {}
        if cookie:
            headers["Cookie"] = COOKIE + "=" + cookie
            row = self.service.store.db.execute("SELECT device_id FROM sessions WHERE cookie_hash=? OR previous_hash=?", (self.service.store.digest(cookie), self.service.store.digest(cookie))).fetchone()
            if row:
                headers["Authorization"] = "Bearer cookie-session:" + row[0]
        return await self.client.request(method, path, json=body, headers=headers)

    async def login(self, user="alice", remember=False):
        response = await self.request("POST", "/api/auth/login", {"username": user, "password": "Correct password!", "remember": remember})
        self.assertEqual(response.status, 200, await response.text())
        return response.cookies[COOKIE].value, await response.json(), response

    async def test_cookie_session_hides_tokens_and_csrf_rejects_cross_site(self):
        cookie, data, response = await self.login(remember=True)
        self.assertNotIn("access_token", json.dumps(data))
        self.assertNotIn("real-secret", json.dumps(data))
        header = response.headers["Set-Cookie"]
        for attribute in ("Secure", "HttpOnly", "SameSite=Strict", "Max-Age="):
            self.assertIn(attribute, header)
        denied = await self.request("POST", "/api/auth/logout", {}, cookie, origin="https://evil.example")
        self.assertEqual(denied.status, 403)
        accepted = await self.request("GET", "/api/auth/session", cookie=cookie)
        self.assertEqual(accepted.status, 200)
        denied = await self.request("POST", "/api/auth/logout", {}, cookie, origin=None)
        self.assertEqual(denied.status, 403)

    async def test_session_cookie_is_not_persistent_without_opt_in(self):
        _, _, response = await self.login()
        self.assertNotIn("Max-Age", response.headers["Set-Cookie"])

    async def test_friend_code_rotation_requires_same_origin_and_keeps_code_out_of_audit(self):
        cookie, _, _ = await self.login()
        response = await self.request('GET', '/api/social', cookie=cookie)
        code = (await response.json())['friendCode']
        for origin in (None, 'https://evil.example'):
            denied = await self.request('POST', '/api/social/friend-code', {'previousCode': code}, cookie, origin=origin)
            self.assertEqual(denied.status, 403)
        response = await self.request('POST', '/api/social/friend-code', {'previousCode': code}, cookie)
        self.assertEqual(response.status, 200)
        replacement = (await response.json())['friendCode']
        self.assertNotEqual(replacement, code)
        audit = json.dumps([dict(row) for row in self.service.store.db.execute('SELECT * FROM audit')])
        self.assertNotIn(code, audit)
        self.assertNotIn(replacement, audit)

    async def test_rotation_and_logout_invalidate_current_and_previous_cookie(self):
        old, _, _ = await self.login()
        self.service.store.db.execute("UPDATE sessions SET rotated=?", (time.time() - 901,))
        response = await self.request("GET", "/api/auth/session", cookie=old)
        new = response.cookies[COOKIE].value
        self.assertNotEqual(new, old)
        alias = await self.request("GET", "/api/auth/session", cookie=old)
        self.assertEqual(alias.status, 200)
        self.assertEqual(alias.cookies[COOKIE].value, new)
        logout = await self.request("POST", "/api/auth/logout", {}, new)
        self.assertEqual(logout.status, 200)
        self.assertIn("Max-Age=0", logout.headers["Set-Cookie"])
        self.assertEqual((await self.request("GET", "/api/auth/session", cookie=old)).status, 401)
        self.assertEqual((await self.request("GET", "/api/auth/session", cookie=new)).status, 401)

    async def test_matrix_proxy_injects_token_and_blocks_credential_bypasses(self):
        cookie, _, _ = await self.login()
        response = await self.request("GET", "/api/matrix/_matrix/client/v3/sync?timeout=10", cookie=cookie)
        self.assertEqual(response.status, 200)
        self.assertTrue(self.upstream_calls[-1][3].startswith("Bearer real-secret-token-"))
        for endpoint in ("login", "register", "refresh", "account/password", "account/deactivate", "account/3pid/add", "logout/all"):
            response = await self.request("POST", "/api/matrix/_matrix/client/v3/" + endpoint, {}, cookie)
            self.assertEqual(response.status, 403, endpoint)
        legacy = await self.request("POST", "/api/matrix/_matrix/client/api/v1/login", {}, cookie)
        self.assertEqual(legacy.status, 403)
        forbidden = await self.request("GET", "/api/matrix/_synapse/admin/v2/users", cookie=cookie)
        self.assertEqual(forbidden.status, 403)
        anonymous = await self.request("GET", "/api/matrix/_matrix/client/v3/sync")
        self.assertEqual(anonymous.status, 401)

    async def test_proxy_device_binding_rejects_old_tab_after_cookie_session_changes(self):
        old_cookie, old_session, _ = await self.login()
        new_cookie, _, _ = await self.login()
        response = await self.client.get("/api/matrix/_matrix/client/v3/sync", headers={"Cookie": COOKIE + "=" + new_cookie, "Authorization": "Bearer cookie-session:" + old_session["deviceId"]})
        self.assertEqual(response.status, 401)
        self.assertEqual((await response.json())["errcode"], "M_UNKNOWN_TOKEN")

    async def test_native_pusher_mutations_cannot_bypass_device_bound_push_registration(self):
        cookie, _, _ = await self.login()
        before = len(self.upstream_calls)
        for version in ('v3', 'r0', 'unstable', 'api/v1'):
            response = await self.request('POST', '/api/matrix/_matrix/client/' + version + '/pushers/set',
                {'app_id': 'io.tavern.web', 'pushkey': 'untrusted', 'data': {'url': 'https://untrusted.example/notify'}}, cookie)
            self.assertEqual(response.status, 403)
            self.assertEqual((await response.json())['errcode'], 'ACCOUNT_ROUTE_REQUIRED')
        self.assertEqual(len(self.upstream_calls), before)

    async def test_server_side_token_revocation_clears_browser_session(self):
        cookie, _, _ = await self.login()
        self.tokens.clear()
        response = await self.request("GET", "/api/auth/session", cookie=cookie)
        self.assertEqual(response.status, 401)
        self.assertIn("Max-Age=0", response.headers["Set-Cookie"])

    async def test_password_change_uses_uia_and_preserves_current_device(self):
        cookie, session, _ = await self.login()
        other, _, _ = await self.login()
        response = await self.request("POST", "/api/account/password", {"currentPassword": "Correct password!", "newPassword": "A new strong password!", "confirmation": "A new strong password!", "logoutOtherDevices": True}, cookie)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.users["@alice:test"]["password"], "A new strong password!")
        calls = [row for row in self.upstream_calls if row[1].endswith("/account/password")]
        self.assertEqual(calls[-1][2]["auth"]["session"], "UIA-session")
        self.assertEqual(calls[-1][2]["auth"]["identifier"]["user"], "@alice:test")
        self.assertEqual((await self.request("GET", "/api/auth/session", cookie=cookie)).status, 200)
        self.assertEqual((await self.request("GET", "/api/auth/session", cookie=other)).status, 401)
        self.assertFalse(any("keys" in row[1] for row in self.upstream_calls))

    async def test_password_change_cannot_bypass_extra_homeserver_uia(self):
        cookie, _, _ = await self.login()
        self.uia_extra = True
        response = await self.request("POST", "/api/account/password", {"currentPassword": "Correct password!", "newPassword": "New strong password!", "confirmation": "New strong password!"}, cookie)
        self.assertEqual(response.status, 400)
        self.assertEqual((await response.json())["errcode"], "UNSUPPORTED_UIA")
        self.assertEqual(self.users["@alice:test"]["password"], "Correct password!")

    async def test_totp_and_recovery_codes_are_required_and_single_use(self):
        cookie, _, _ = await self.login()
        old, _, _ = await self.login()
        started = await self.request("POST", "/api/account/mfa/totp/start", {"password": "Correct password!"}, cookie)
        setup = await started.json()
        self.assertEqual(started.status, 200, setup)
        grant = self.service.store.read_challenge(setup['challengeId'], 'totp', '@alice:test')['payload']
        self.assertNotIn('password', grant)
        self.assertNotIn('Correct password!', json.dumps(grant))
        self.assertEqual(grant['purpose'], 'totp-enrollment')
        during_setup, _, _ = await self.login()
        code = totp(setup["secret"], int(time.time() // 30))
        done = await self.request("POST", "/api/account/mfa/totp/complete", {"challengeId": setup["challengeId"], "code": code}, cookie)
        self.assertEqual(done.status, 200, await done.text())
        recovery = (await done.json())["recoveryCodes"]
        self.assertEqual(len(recovery), 10)
        self.assertEqual((await self.request("GET", "/api/auth/session", cookie=old)).status, 401)
        self.assertEqual((await self.request('GET', '/api/auth/session', cookie=during_setup)).status, 401)
        device_ids = [device for user, device in self.tokens.values() if user == '@alice:test']
        self.assertEqual(device_ids, [grant['deviceId']])
        response = await self.request("POST", "/api/auth/login", {"username": "alice", "password": "Correct password!"})
        challenge = await response.json()
        self.assertTrue(challenge["mfaRequired"])
        self.assertNotIn(COOKIE, response.cookies)
        replay = await self.request("POST", "/api/auth/mfa", {"challengeId": challenge["challengeId"], "method": "totp", "code": code})
        self.assertEqual(replay.status, 400)
        accepted = await self.request("POST", "/api/auth/mfa", {"challengeId": challenge["challengeId"], "method": "recovery", "code": recovery[0]})
        self.assertEqual(accepted.status, 200)
        reused = await self.request("POST", "/api/auth/mfa", {"challengeId": challenge["challengeId"], "method": "recovery", "code": recovery[0]})
        self.assertEqual(reused.status, 400)

    async def test_totp_start_requires_native_uia_and_never_grants_extra_stage_bypass(self):
        cookie, _, _ = await self.login()
        # Even an empty current device list must authorize the future grant:
        # another device can be created while the user scans the setup QR.
        self.uia_extra = True
        response = await self.request('POST', '/api/account/mfa/totp/start', {'password': 'Correct password!'}, cookie)
        self.assertEqual(response.status, 400)
        self.assertEqual((await response.json())['errcode'], 'UNSUPPORTED_UIA')
        self.assertEqual(self.service.store.db.execute("SELECT count(*) FROM challenges WHERE kind='totp'").fetchone()[0], 0)
        self.assertFalse(any(path.endswith('/delete_devices') and path.startswith('/_synapse/') for _, path, _, _ in self.upstream_calls))

    async def test_totp_grant_cannot_cross_account_session_device_epoch_or_expiry(self):
        cookie, _, _ = await self.login()
        started = await self.request('POST', '/api/account/mfa/totp/start', {'password': 'Correct password!'}, cookie)
        setup = await started.json()
        grant = self.service.store.read_challenge(setup['challengeId'], 'totp', '@alice:test')['payload']
        session = dict(self.service.store.db.execute('SELECT * FROM sessions WHERE id=?', (grant['sessionId'],)).fetchone())
        for key, value in (('purpose', 'password-reset'), ('version', 0), ('userId', '@owner:test'), ('sessionId', 'other'),
                           ('deviceId', 'other'), ('credentialEpoch', -1), ('reauthenticatedAt', time.time() - 601)):
            with self.subTest(key=key):
                count = len(self.upstream_calls)
                with self.assertRaises(APIError):
                    await self.service.revoke_totp_devices(session, {**grant, key: value})
                self.assertEqual(len(self.upstream_calls), count)

    async def test_file_managed_smtp_is_never_persisted_or_returned(self):
        cookie, _, _ = await self.login('owner')
        self.service.smtp_file_password = 'mounted-secret-value'
        self.service.store.set('smtp', {'password': 'previous-saved-secret'})
        response = await self.request('PUT', '/api/admin/settings', {'smtp': {'host': 'smtp.example.test'}}, cookie)
        self.assertEqual(response.status, 200, await response.text())
        settings = (await response.json())['smtp']
        self.assertTrue(settings['passwordConfigured'])
        self.assertNotIn('password', settings)
        self.assertEqual(self.service.store.get('smtp')['password'], 'previous-saved-secret')
        rejected = await self.request('PUT', '/api/admin/settings', {'smtp': {'password': 'new-secret'}}, cookie)
        self.assertEqual(rejected.status, 400)
        self.assertNotIn('mounted-secret-value', await rejected.text())

    async def test_service_credentials_are_not_available_through_managed_matrix_proxy(self):
        owner, _, _ = await self.login('owner')
        ordinary, _, _ = await self.login()
        private = self.service.store.get('service_account')
        for cookie in (owner, ordinary):
            for path in ('/_synapse/admin/v2/users', '/_synapse/admin/v2/users/@alice:test/delete_devices'):
                before = len(self.upstream_calls)
                response = await self.request('POST', '/api/matrix' + path, {'devices': ['D1']}, cookie)
                self.assertIn(response.status, (403, 404))
                self.assertEqual(len(self.upstream_calls), before)
            response = await self.request('GET', '/api/auth/session', cookie=cookie)
            encoded = await response.text()
            self.assertNotIn(private['token'], encoded)
            self.assertNotIn(private['password'], encoded)

    async def test_recovery_code_regeneration_requires_factor_and_invalidates_old_codes(self):
        cookie, _, _ = await self.login()
        denied = await self.request("POST", "/api/account/mfa/recovery-codes", {"password": "Correct password!"}, cookie)
        self.assertEqual(denied.status, 400)
        secret, _ = totp_setup("@alice:test")
        self.service.store.db.execute("UPDATE accounts SET totp=? WHERE user_id='@alice:test'", (self.service.store.seal(secret),))
        old = self.service.new_recovery_codes("@alice:test")
        response = await self.request("POST", "/api/account/mfa/recovery-codes", {"password": "Correct password!", "method": "recovery", "code": old[0]}, cookie)
        self.assertEqual(response.status, 200)
        fresh = (await response.json())["recoveryCodes"]
        self.assertEqual(len(fresh), 10)
        self.assertTrue(set(old).isdisjoint(fresh))
        with self.assertRaises(APIError):
            self.service.verify_factor("@alice:test", old[1], "recovery")
        self.service.verify_factor("@alice:test", fresh[0], "recovery")

    async def test_login_started_during_mfa_enrollment_must_pass_new_factor(self):
        cookie, _, _ = await self.login()
        started = await self.request("POST", "/api/account/mfa/totp/start", {"password": "Correct password!"}, cookie)
        setup = await started.json()
        revoked, finish = asyncio.Event(), asyncio.Event()
        original = self.service.revoke_totp_devices

        async def pause_after_revocation(session, grant):
            result = await original(session, grant)
            revoked.set()
            await finish.wait()
            return result

        self.service.revoke_totp_devices = pause_after_revocation
        enrollment = asyncio.create_task(self.request("POST", "/api/account/mfa/totp/complete", {"challengeId": setup["challengeId"], "code": totp(setup["secret"], int(time.time() // 30))}, cookie))
        await asyncio.wait_for(revoked.wait(), 2)
        login = asyncio.create_task(self.request("POST", "/api/auth/login", {"username": "alice", "password": "Correct password!"}))
        await asyncio.sleep(0.03)
        self.assertFalse(login.done(), "Sign-in must wait for the account security change")
        finish.set()
        self.assertEqual((await enrollment).status, 200)
        response = await login
        self.assertEqual(response.status, 200)
        self.assertTrue((await response.json())["mfaRequired"])
        self.assertNotIn(COOKIE, response.cookies)

    async def test_admin_supplied_email_is_saved_but_cannot_recover_until_verified(self):
        owner, _, _ = await self.login("owner")
        response = await self.request("POST", "/api/admin/users", {"username": "newuser", "password": "A new strong password!", "email": "new@example.com"}, owner)
        self.assertEqual(response.status, 201)
        account = self.service.store.account("@newuser:test")
        self.assertEqual(account["email"], "new@example.com")
        self.assertEqual(account["verified"], 0)
        self.service.send_email.reset_mock()
        response = await self.request("POST", "/api/auth/recovery/start", {"email": "new@example.com"})
        self.assertEqual(response.status, 200)
        await asyncio.sleep(0)
        self.service.send_email.assert_not_called()

    async def test_account_deletion_needs_password_and_exact_confirmation(self):
        await self.login('owner')  # Provision the configured account service.
        cookie, _, _ = await self.login()
        bad = await self.request("POST", "/api/account/deactivate", {"password": "Correct password!", "confirmation": "DELETE", "erase": True}, cookie)
        self.assertEqual(bad.status, 400)
        self.assertFalse(any(row[1].endswith("deactivate") for row in self.upstream_calls))
        good = await self.request("POST", "/api/account/deactivate", {"password": "Correct password!", "confirmation": "@alice:test", "erase": True}, cookie)
        self.assertEqual(good.status, 200, await good.text())
        self.assertEqual((await self.request("GET", "/api/auth/session", cookie=cookie)).status, 401)

    async def test_admin_authorization_and_smtp_secret_redaction(self):
        user, _, _ = await self.login()
        self.assertEqual((await self.request("GET", "/api/admin/settings", cookie=user)).status, 403)
        owner, _, _ = await self.login("owner")
        response = await self.request("PUT", "/api/admin/settings", {"smtp": {"password": "gmail-app-secret", "enabled": True}}, owner)
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertTrue(result["smtp"]["passwordConfigured"])
        self.assertNotIn("gmail-app-secret", json.dumps(result))
        self.assertNotIn("password", result["smtp"])

    async def test_bootstrap_requires_fresh_marker_and_permanently_invalidates_default(self):
        data = {"username": "admin", "password": "admin", "setup": {"username": "newowner", "password": "Strong admin password!", "confirmPassword": "Strong admin password!", "displayName": "Owner", "email": "owner@example.com", "instanceName": "Our Tavern"}}
        response = await self.request("POST", "/api/auth/bootstrap/start", data)
        self.assertEqual(response.status, 403)
        self.config.bootstrap_marker.write_text("fresh")
        self.users.clear()
        response = await self.request("POST", "/api/auth/bootstrap/start", data)
        self.assertEqual(response.status, 200, await response.text())
        identity = (await response.json())["challengeId"]
        code = re.search(r"\b\d{6}\b", self.service.send_email.call_args.args[2])[0]
        response = await self.request("POST", "/api/auth/bootstrap/complete", {"challengeId": identity, "code": code})
        self.assertEqual(response.status, 200, await response.text())
        self.assertFalse(self.service.bootstrap_required())
        response = await self.request("POST", "/api/auth/bootstrap/start", data)
        self.assertEqual(response.status, 403)

    async def test_stale_bootstrap_marker_cannot_take_over_existing_homeserver(self):
        self.config.bootstrap_marker.write_text("fresh")
        data = {"username": "admin", "password": "admin", "setup": {"username": "attacker", "password": "Strong admin password!", "confirmPassword": "Strong admin password!", "displayName": "Owner", "email": "owner@example.com", "instanceName": "Our Tavern"}}
        response = await self.request("POST", "/api/auth/bootstrap/start", data)
        self.assertEqual(response.status, 403)
        self.assertEqual((await response.json())["errcode"], "BOOTSTRAP_DISABLED")
        self.assertNotIn("@attacker:test", self.users)
        response = await self.request("POST", "/api/auth/login", {"username": "admin", "password": "admin"})
        self.assertEqual(response.status, 403)

    async def test_email_verification_and_recovery_preserve_totp_requirement(self):
        cookie, _, _ = await self.login()
        response = await self.request("POST", "/api/account/email/start", {"password": "Correct password!", "email": "alice@example.com"}, cookie)
        identity = (await response.json())["challengeId"]
        code = re.search(r"\b\d{6}\b", self.service.send_email.call_args.args[2])[0]
        response = await self.request("POST", "/api/account/email/complete", {"challengeId": identity, "code": code}, cookie)
        self.assertEqual(response.status, 200)
        await self.login("owner")  # Creates the separately authenticated account service.
        secret, _ = totp_setup("@alice:test")
        self.service.store.db.execute("UPDATE accounts SET totp=? WHERE user_id=?", (self.service.store.seal(secret), "@alice:test"))
        response = await self.request("POST", "/api/auth/recovery/start", {"email": "alice@example.com"})
        identity = (await response.json())["challengeId"]
        await asyncio.sleep(0)
        code = re.search(r"\b\d{6}\b", self.service.send_email.call_args.args[2])[0]
        payload = {"challengeId": identity, "code": code, "newPassword": "Recovered password!", "confirmation": "Recovered password!"}
        denied = await self.request("POST", "/api/auth/recovery/complete", payload)
        self.assertEqual(denied.status, 400)
        self.assertEqual((await denied.json())["errcode"], "MFA_REQUIRED")
        payload.update(mfaCode=totp(secret, int(time.time() // 30)), method="totp")
        accepted = await self.request("POST", "/api/auth/recovery/complete", payload)
        self.assertEqual(accepted.status, 200, await accepted.text())
        self.assertEqual(self.users["@alice:test"]["password"], "Recovered password!")
        self.assertTrue(self.service.store.account("@alice:test")["totp"])


if __name__ == "__main__":
    unittest.main()
