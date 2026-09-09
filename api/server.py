"""Tavern account gateway. Synapse owns users, passwords, rooms and encryption.

Matrix access tokens never leave this service. Encrypted SQLite records contain
account factors and opaque browser sessions; browser crypto keys stay in IndexedDB.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import html
import ipaddress
from importlib import import_module
import json
import logging
import os
from pathlib import Path
import re
import secrets
import smtplib
import sqlite3
import ssl
import sys
import time
from dataclasses import dataclass
from email.message import EmailMessage
from urllib.parse import quote, unquote, urlsplit

import aiohttp
from aiohttp import web
from cryptography.fernet import Fernet
import yaml

try:
    from .security import client_address, email_address, network_list, password_error, totp_setup, verify_totp, uia_password_challenge
except ImportError:
    from security import client_address, email_address, network_list, password_error, totp_setup, verify_totp, uia_password_challenge

LOG = logging.getLogger("tavern.api")
COOKIE = "__Host-tavern-session"
API_VERSION = "0.4.0"


class APIError(Exception):
    def __init__(self, status: int, message: str, code: str = "TAVERN_ERROR", **details):
        self.status, self.message, self.code, self.details = status, message, code, details


@dataclass
class Config:
    public_url: str
    data_dir: Path
    synapse_url: str = "http://synapse:8008"
    synapse_config: Path = Path("/synapse/homeserver.yaml")
    bootstrap_marker: Path = Path("/synapse/tavern-bootstrap-allowed")
    trusted_proxies: str = ""
    bootstrap_networks: str = "127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128"

    @classmethod
    def environment(cls):
        config = cls(
            public_url=os.environ.get("TAVERN_PUBLIC_URL", "").rstrip("/"),
            data_dir=Path(os.environ.get("API_DATA_DIR", "/data")),
            synapse_url=os.environ.get("SYNAPSE_URL", "http://synapse:8008").rstrip("/"),
            synapse_config=Path(os.environ.get("SYNAPSE_CONFIG_PATH", "/synapse/homeserver.yaml")),
            bootstrap_marker=Path(os.environ.get("TAVERN_BOOTSTRAP_MARKER", "/synapse/tavern-bootstrap-allowed")),
            trusted_proxies=os.environ.get("TRUSTED_PROXY_CIDRS", ""),
            bootstrap_networks=os.environ.get("BOOTSTRAP_ALLOWED_CIDRS", cls.bootstrap_networks),
        )
        parsed = urlsplit(config.public_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.path not in {"", "/"} or parsed.username or parsed.query or parsed.fragment:
            raise ValueError("TAVERN_PUBLIC_URL must be an HTTPS origin, for example https://chat.example.com.")
        network_list(config.trusted_proxies)
        network_list(config.bootstrap_networks)
        return config


class Store:
    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True)
        key_path = directory / "secrets.key"
        if (directory / "tavern.sqlite3").exists() and not key_path.exists():
            raise ValueError("The account database exists but secrets.key is missing. Restore both from the same backup.")
        try:
            with key_path.open("xb") as key_file:
                key_file.write(Fernet.generate_key())
            key_path.chmod(0o600)
        except FileExistsError:
            pass
        self.key = key_path.read_bytes()
        self.cipher = Fernet(self.key)
        self.db = sqlite3.connect(directory / "tavern.sqlite3", isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA busy_timeout=5000;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS accounts(user_id TEXT PRIMARY KEY,email TEXT UNIQUE,verified INTEGER NOT NULL DEFAULT 0,
                display_name TEXT NOT NULL DEFAULT '',timezone TEXT NOT NULL DEFAULT 'UTC',created REAL NOT NULL,
                totp TEXT,email_mfa INTEGER NOT NULL DEFAULT 0,totp_counter INTEGER NOT NULL DEFAULT -1);
            CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,cookie_hash TEXT UNIQUE NOT NULL,cookie TEXT NOT NULL,
                previous_hash TEXT,previous_until REAL NOT NULL DEFAULT 0,rotated REAL NOT NULL,user_id TEXT NOT NULL,
                device_id TEXT NOT NULL,token TEXT NOT NULL,created REAL NOT NULL,last_seen REAL NOT NULL,
                expires REAL NOT NULL,persistent INTEGER NOT NULL,name TEXT NOT NULL,ip TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS session_users ON sessions(user_id,expires);
            CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
            CREATE INDEX IF NOT EXISTS session_previous ON sessions(previous_hash);
            CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY,kind TEXT NOT NULL,user_id TEXT,payload TEXT NOT NULL,
                code_hash TEXT,attempts INTEGER NOT NULL DEFAULT 0,expires REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS challenge_expiry ON challenges(expires);
            CREATE INDEX IF NOT EXISTS challenge_user_kind ON challenges(user_id,kind);
            CREATE TABLE IF NOT EXISTS recovery_codes(user_id TEXT NOT NULL,code_hash TEXT NOT NULL,PRIMARY KEY(user_id,code_hash));
            CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS rate_limit_expiry ON rate_limits(expires);
            CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,created REAL NOT NULL,actor TEXT NOT NULL,
                action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS audit_created ON audit(created);
            CREATE INDEX IF NOT EXISTS audit_action_id ON audit(action,id);
            CREATE INDEX IF NOT EXISTS audit_actor_id ON audit(actor,id);
        """)

    def seal(self, value) -> str:
        return self.cipher.encrypt(json.dumps(value, separators=(",", ":")).encode()).decode()

    def open(self, value: str):
        return json.loads(self.cipher.decrypt(value.encode()))

    def digest(self, value: str) -> str:
        return hmac.new(self.key, value.encode(), hashlib.sha256).hexdigest()

    def get(self, key: str, default=None):
        row = self.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return self.open(row[0]) if row else default

    def set(self, key: str, value):
        self.db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, self.seal(value)))

    def account(self, user_id: str) -> dict:
        row = self.db.execute("SELECT * FROM accounts WHERE user_id=?", (user_id,)).fetchone()
        return dict(row) if row else {}

    def rate(self, key: str, limit: int = 10, seconds: int = 60):
        now = time.time()
        self.db.execute("DELETE FROM rate_limits WHERE expires<?", (now,))
        key = self.digest(key)
        self.db.execute("INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1", (key, now + seconds))
        if self.db.execute("SELECT count FROM rate_limits WHERE key=?", (key,)).fetchone()[0] > limit:
            raise APIError(429, "Too many attempts. Wait a little before trying again.", "RATE_LIMITED")

    def challenge(self, kind: str, payload: dict, user_id: str | None = None, code: str | None = None, duration: int = 600):
        identity = secrets.token_urlsafe(32)
        self.db.execute("INSERT INTO challenges(id,kind,user_id,payload,code_hash,expires) VALUES(?,?,?,?,?,?)",
                        (identity, kind, user_id, self.seal(payload), self.digest(identity + ":" + code) if code else None, time.time() + duration))
        return identity

    def read_challenge(self, identity: str, kind: str, user_id: str | None = None) -> dict:
        row = self.db.execute("SELECT * FROM challenges WHERE id=? AND kind=?", (identity, kind)).fetchone()
        if not row or row["expires"] <= time.time() or row["attempts"] >= 5 or (user_id is not None and row["user_id"] != user_id):
            raise APIError(400, "This verification expired or has too many attempts. Start again.", "CHALLENGE_EXPIRED")
        return {**dict(row), "payload": self.open(row["payload"])}

    def verify_code(self, challenge: dict, code: object):
        self.db.execute("UPDATE challenges SET attempts=attempts+1 WHERE id=?", (challenge["id"],))
        if not isinstance(code, str) or not challenge["code_hash"] or not hmac.compare_digest(challenge["code_hash"], self.digest(challenge["id"] + ":" + code.strip())):
            raise APIError(400, "The verification code is incorrect.", "INVALID_CODE")

    def consume(self, identity: str):
        self.db.execute("DELETE FROM challenges WHERE id=?", (identity,))


class Service:
    def __init__(self, config: Config):
        self.config, self.store = config, Store(config.data_dir)
        self.http: aiohttp.ClientSession | None = None
        self.trusted = network_list(config.trusted_proxies)
        self.allowed_bootstrap = network_list(config.bootstrap_networks)
        self.bootstrap_lock = asyncio.Lock()
        self.user_locks: dict[str, asyncio.Lock] = {}
        self.cleanup_task = None
        self.background_tasks: set[asyncio.Task] = set()

    def background(self, operation):
        task = asyncio.create_task(operation)
        self.background_tasks.add(task)
        task.add_done_callback(self.background_tasks.discard)

    async def start(self, app):
        self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=100), auto_decompress=False, cookie_jar=aiohttp.DummyCookieJar(), trust_env=False)
        self.cleanup_task = asyncio.create_task(self.cleanup_expired())

    async def close(self, app):
        if self.cleanup_task:
            self.cleanup_task.cancel()
            try:
                await self.cleanup_task
            except asyncio.CancelledError:
                pass
        for task in self.background_tasks:
            task.cancel()
        if self.background_tasks:
            await asyncio.gather(*self.background_tasks, return_exceptions=True)
        await self.http.close()
        self.store.db.close()

    async def cleanup_expired(self):
        while True:
            await asyncio.sleep(60)
            rows = self.store.db.execute("SELECT * FROM challenges WHERE expires<? LIMIT 100", (time.time(),)).fetchall()
            for row in rows:
                payload = self.store.open(row["payload"])
                token = payload.get("login", {}).get("access_token")
                if token:
                    try:
                        await self.matrix("POST", "/_matrix/client/v3/logout", {}, token, expected=False)
                    except (aiohttp.ClientError, asyncio.TimeoutError):
                        continue
                self.store.consume(row["id"])
            rows = self.store.db.execute("SELECT * FROM sessions WHERE expires<? LIMIT 100", (time.time(),)).fetchall()
            for row in rows:
                try:
                    await self.matrix("POST", "/_matrix/client/v3/logout", {}, self.store.open(row["token"]), expected=False)
                except (aiohttp.ClientError, asyncio.TimeoutError):
                    continue
                self.store.db.execute("DELETE FROM sessions WHERE id=?", (row["id"],))

    def ip(self, request) -> str:
        return client_address(request.remote, request.headers.get("X-Forwarded-For"), self.trusted)

    def audit(self, actor: str, action: str, target: str = "", detail: str = ""):
        self.store.db.execute("INSERT INTO audit(created,actor,action,target,detail) VALUES(?,?,?,?,?)", (time.time(), actor, action, target, detail[:1000]))

    async def matrix(self, method: str, path: str, body=None, token: str | None = None, expected=True):
        assert path.startswith("/_matrix/") or path.startswith("/_synapse/admin/")
        headers = {"Authorization": "Bearer " + token} if token else {}
        async with self.http.request(method, self.config.synapse_url + path, json=body, headers=headers, allow_redirects=False, auto_decompress=True) as response:
            try:
                result = await response.json(content_type=None)
            except (ValueError, UnicodeDecodeError):
                result = {}
            if not isinstance(result, dict):
                result = {}
            if expected and not 200 <= response.status < 300:
                code = result.get("errcode", "M_UNKNOWN")
                messages = {"M_FORBIDDEN": "The credentials or permissions were not accepted.", "M_USER_DEACTIVATED": "This account has been deactivated.",
                            "M_LIMIT_EXCEEDED": "Too many attempts. Wait before trying again.", "M_USER_IN_USE": "That username is already in use.",
                            "M_PASSWORD_TOO_SHORT": "The new password is too short for this server.", "M_PASSWORD_WEAK": "Choose a stronger password.",
                            "M_UNKNOWN_TOKEN": "Your session expired. Sign in again.", "M_INVALID_USERNAME": "Choose a valid username."}
                raise APIError(response.status if response.status < 500 else 502, messages.get(code, "The homeserver could not complete this request."), code)
            return result if expected else (response.status, result)

    def smtp(self, reveal: bool = True) -> dict:
        def flag(name, default="false"):
            return os.environ.get(name, default).casefold() == "true"
        value = {"enabled": flag("SMTP_ENABLED"), "host": os.environ.get("SMTP_HOST", "smtp.gmail.com"),
                 "port": int(os.environ.get("SMTP_PORT", "587")), "secure": flag("SMTP_SECURE"),
                 "username": os.environ.get("SMTP_USERNAME", ""), "password": os.environ.get("SMTP_PASSWORD", ""),
                 "fromName": os.environ.get("SMTP_FROM_NAME", "Tavern"), "fromAddress": os.environ.get("SMTP_FROM_ADDRESS", "")}
        value.update(self.store.get("smtp", {}))
        if not reveal:
            value["passwordConfigured"] = bool(value.pop("password", ""))
        return value

    async def send_email(self, recipient: str, subject: str, text: str, test_only=False):
        settings = self.smtp()
        if not settings["enabled"] or not settings["host"] or not settings["fromAddress"]:
            raise APIError(503, "Email is not configured. Ask your administrator to configure SMTP.", "SMTP_NOT_CONFIGURED")
        message = EmailMessage()
        message["From"] = f'{settings["fromName"]} <{email_address(settings["fromAddress"])}>'
        message["To"] = email_address(recipient)
        message["Subject"] = "Tavern · " + subject
        message.set_content(text + "\n\n" + self.config.public_url)
        message.add_alternative('<!doctype html><html><body style="font-family:system-ui;background:#f4f2ec;padding:24px"><main style="max-width:520px;background:white;padding:28px;border-radius:16px;margin:auto"><h1 style="color:#7e5620">Tavern</h1><h2>' + html.escape(subject) + '</h2><p style="white-space:pre-line">' + html.escape(text) + '</p><p><a href="' + html.escape(self.config.public_url, quote=True) + '">Open Tavern</a></p></main></body></html>', subtype="html")
        def deliver():
            context = ssl.create_default_context()
            connection = smtplib.SMTP_SSL(settings["host"], settings["port"], timeout=15, context=context) if settings["secure"] else smtplib.SMTP(settings["host"], settings["port"], timeout=15)
            with connection:
                connection.ehlo()
                if not settings["secure"]:
                    connection.starttls(context=context)
                    connection.ehlo()
                if settings["username"]:
                    connection.login(settings["username"], settings["password"])
                if not test_only:
                    connection.send_message(message)
        try:
            await asyncio.to_thread(deliver)
        except (smtplib.SMTPException, OSError):
            raise APIError(502, "Email delivery failed. Check the SMTP connection and sender settings.", "SMTP_FAILED") from None

    async def security_notice(self, user_id: str, subject: str, text: str):
        account = self.store.account(user_id)
        if account.get("verified") and account.get("email") and self.smtp()["enabled"]:
            try:
                await self.send_email(account["email"], subject, text)
            except APIError:
                self.audit(user_id, "security_email_failed", user_id)

    def bootstrap_required(self):
        return self.config.bootstrap_marker.is_file() and not self.store.get("bootstrap_complete", False)

    def bootstrap_access(self, request):
        if not self.bootstrap_required():
            raise APIError(403, "Administrator setup is not available on this installation.", "BOOTSTRAP_DISABLED")
        address = ipaddress.ip_address(self.ip(request))
        if not any(address in network for network in self.allowed_bootstrap):
            raise APIError(403, "Administrator setup is restricted to the configured local networks.", "BOOTSTRAP_NETWORK")

    async def bootstrap_server_check(self):
        # The fresh-install marker survives in the Synapse volume. If the API
        # volume is lost, it must not become an invitation to take over an
        # existing homeserver with the original setup credentials.
        await self.ensure_service_account()
        if self.store.get("bootstrap_pending"):
            return
        value = await self.matrix("GET", "/_synapse/admin/v2/users?limit=1", token=await self.service_token())
        total = value.get("total")
        if not isinstance(total, int):
            raise APIError(503, "The existing account inventory could not be checked. Administrator setup remains locked.")
        if total > 1:  # The one new account is the dedicated internal service.
            self.store.set("bootstrap_complete", True)
            raise APIError(403, "This homeserver already contains accounts. Sign in with an existing administrator.", "BOOTSTRAP_DISABLED")

    def authenticate(self, request):
        cookie = request.cookies.get(COOKIE, "")
        if not cookie:
            return None
        now, digest = time.time(), self.store.digest(cookie)
        row = self.store.db.execute("SELECT * FROM sessions WHERE cookie_hash=? OR (previous_hash=? AND previous_until>?)", (digest, digest, now)).fetchone()
        if not row or row["expires"] <= now:
            return None
        session = dict(row)
        if now - row["rotated"] > 900:
            fresh = secrets.token_urlsafe(32)
            self.store.db.execute("UPDATE sessions SET previous_hash=cookie_hash,previous_until=?,cookie_hash=?,cookie=?,rotated=? WHERE id=?",
                                  (now + 30, self.store.digest(fresh), self.store.seal(fresh), now, row["id"]))
            request["cookie"] = (fresh, session)
        elif digest != row["cookie_hash"]:
            request["cookie"] = (self.store.open(row["cookie"]), session)
        if now - row["last_seen"] > 30:
            self.store.db.execute("UPDATE sessions SET last_seen=? WHERE id=?", (now, row["id"]))
        request["session"] = session
        return session

    def require_session(self, request):
        session = request.get("session") or self.authenticate(request)
        if not session or not self.store.db.execute("SELECT 1 FROM sessions WHERE id=? AND expires>?", (session["id"], time.time())).fetchone():
            raise APIError(401, "Sign in to continue.", "M_UNKNOWN_TOKEN")
        device = request.headers.get("X-Tavern-Device")
        if device is not None and not hmac.compare_digest(device, session["device_id"]):
            raise APIError(401, "This browser is now using a different device session. Reload Tavern before continuing.", "M_UNKNOWN_TOKEN")
        account = self.store.account(session['user_id'])
        if account.get('access_blocked') and request.path != '/api/auth/logout':
            raise APIError(403, 'This account is restricted. Contact your administrator.', 'ACCOUNT_RESTRICTED')
        allowed = {'/api/auth/session', '/api/auth/logout', '/api/account/security', '/api/account/security/email-code', '/api/account/password'}
        if account.get('password_change_required') and request.path not in allowed:
            raise APIError(403, 'Change your password before continuing.', 'PASSWORD_CHANGE_REQUIRED')
        return session

    async def require_admin(self, request):
        session = self.require_session(request)
        status, result = await self.matrix("GET", "/_synapse/admin/v1/users/" + quote(session["user_id"], safe="") + "/admin", token=self.store.open(session["token"]), expected=False)
        if status != 200 or result.get("admin") is not True:
            raise APIError(403, "Instance administrator access is required.", "FORBIDDEN")
        return session

    async def session_info(self, session):
        account = self.store.account(session["user_id"])
        status, result = await self.matrix("GET", "/_synapse/admin/v1/users/" + quote(session["user_id"], safe="") + "/admin", token=self.store.open(session["token"]), expected=False)
        return {"userId": session["user_id"], "deviceId": session["device_id"], "baseUrl": self.config.public_url + "/api/matrix",
                "admin": status == 200 and result.get("admin") is True, "displayName": account.get("display_name", ""),
                "email": account.get("email", ""), "emailVerified": bool(account.get("verified")), "passwordChangeRequired": bool(account.get('password_change_required'))}

    async def issue_session(self, request, login, remember=False):
        status, _ = await self.matrix("GET", "/_matrix/client/v3/account/whoami", token=login["access_token"], expected=False)
        if status != 200:
            raise APIError(401, "This sign-in expired. Sign in again.", "M_UNKNOWN_TOKEN")
        now, identity, cookie = time.time(), secrets.token_urlsafe(24), secrets.token_urlsafe(32)
        self.store.db.execute("INSERT OR IGNORE INTO accounts(user_id,created) VALUES(?,?)", (login["user_id"], now))
        session = {"id": identity, "cookie_hash": self.store.digest(cookie), "cookie": self.store.seal(cookie), "previous_hash": None,
                   "previous_until": 0, "rotated": now, "user_id": login["user_id"], "device_id": login["device_id"], "token": self.store.seal(login["access_token"]),
                   "created": now, "last_seen": now, "expires": now + (30 * 86400 if remember else 12 * 3600), "persistent": int(remember),
                   "name": request.headers.get("User-Agent", "Browser")[:240], "ip": self.ip(request)}
        self.store.db.execute("INSERT INTO sessions(" + ",".join(session) + ") VALUES(" + ",".join("?" for _ in session) + ")", tuple(session.values()))
        request["cookie"], request["session"] = (cookie, session), session
        self.audit(login["user_id"], "login", session["device_id"])
        result = await self.session_info(session)
        if result["admin"]:
            await self.ensure_service_account()
        self.background(self.security_notice(login["user_id"], "New device signed in", "A new Tavern browser session signed in. Review Devices & Sessions if this was not you."))
        return web.json_response(result)

    async def login_upstream(self, username: str, password: str, name="Tavern browser"):
        return await self.matrix("POST", "/_matrix/client/v3/login", {"type": "m.login.password", "identifier": {"type": "m.id.user", "user": username}, "password": password, "initial_device_display_name": name})

    async def register(self, username, password, admin=False, display_name=""):
        try:
            settings = yaml.safe_load(self.config.synapse_config.read_text())
            secret = settings["registration_shared_secret"]
        except (OSError, KeyError, TypeError):
            raise APIError(503, "The account service cannot read the homeserver registration configuration.", "REGISTRATION_UNAVAILABLE") from None
        nonce = (await self.matrix("GET", "/_synapse/admin/v1/register"))["nonce"]
        mac = hmac.new(secret.encode(), digestmod=hashlib.sha1)
        mac.update((nonce + "\x00" + username + "\x00" + password + "\x00" + ("admin" if admin else "notadmin")).encode())
        return await self.matrix("POST", "/_synapse/admin/v1/register", {"nonce": nonce, "username": username, "password": password, "admin": admin, "displayname": display_name, "mac": mac.hexdigest()})

    async def ensure_service_account(self):
        if self.store.get("service_account"):
            return
        async with self.bootstrap_lock:
            if self.store.get("service_account"):
                return
            username, password = "tavern_service_" + secrets.token_hex(8), secrets.token_urlsafe(48)
            result = await self.register(username, password, admin=True, display_name="Tavern account service")
            self.store.set("service_account", {"userId": result["user_id"], "password": password, "token": result["access_token"]})
            self.audit("system", "service_account_created", result["user_id"])

    async def service_token(self):
        value = self.store.get("service_account")
        if not value:
            raise APIError(503, "An administrator must sign in before account recovery is available.", "RECOVERY_UNAVAILABLE")
        return value["token"]

    async def password_auth(self, session, password: object):
        if not isinstance(password, str) or not password or len(password) > 1024:
            raise APIError(400, "Enter your current password.", "PASSWORD_REQUIRED")
        self.store.rate("reauth:" + session["user_id"], 8, 300)
        # A temporary device verifies credentials without trusting a client-side check.
        value = await self.login_upstream(session["user_id"], password, "Tavern security confirmation")
        await self.matrix("POST", "/_matrix/client/v3/logout", {}, value["access_token"])

    def methods(self, account):
        return (["totp"] if account.get("totp") else []) + (["email"] if account.get("email_mfa") else []) + (["recovery"] if account.get("totp") or account.get("email_mfa") else [])

    def verify_factor(self, user_id: str, code: object, method: str, challenge: dict | None = None):
        account = self.store.account(user_id)
        if not self.methods(account):
            return
        self.store.rate("factor:" + user_id, 10, 300)
        if method == "totp" and account.get("totp"):
            counter = verify_totp(self.store.open(account["totp"]), code, account["totp_counter"])
            if counter is not None:
                self.store.db.execute("UPDATE accounts SET totp_counter=? WHERE user_id=?", (counter, user_id))
                return
        elif method == "recovery" and isinstance(code, str):
            digest = self.store.digest("recovery:" + code.strip().upper().replace("-", ""))
            cursor = self.store.db.execute("DELETE FROM recovery_codes WHERE user_id=? AND code_hash=?", (user_id, digest))
            if cursor.rowcount:
                self.audit(user_id, "recovery_code_used", user_id)
                return
        elif method == "email" and account.get("email_mfa") and challenge:
            self.store.verify_code(challenge, code)
            return
        raise APIError(400, "Enter a valid authentication or recovery code.", "MFA_REQUIRED", methods=self.methods(account))

    async def require_sensitive(self, request, data):
        session = self.require_session(request)
        await self.password_auth(session, data.get("password", data.get("currentPassword")))
        account = self.store.account(session["user_id"])
        if self.methods(account):
            challenge = None
            if data.get("method") == "email":
                challenge = self.store.read_challenge(data.get("challengeId", ""), "sensitive", session["user_id"])
                if challenge["payload"].get("sessionId") != session["id"]:
                    raise APIError(400, "Start verification again.", "INVALID_CODE")
            self.verify_factor(session["user_id"], data.get("code"), data.get("method", "totp"), challenge)
            if challenge:
                self.store.consume(challenge["id"])
        return session

    def new_recovery_codes(self, user_id):
        codes = [secrets.token_hex(6).upper() for _ in range(10)]
        self.store.db.execute("DELETE FROM recovery_codes WHERE user_id=?", (user_id,))
        self.store.db.executemany("INSERT INTO recovery_codes VALUES(?,?)", [(user_id, self.store.digest("recovery:" + code)) for code in codes])
        return [code[:4] + "-" + code[4:8] + "-" + code[8:] for code in codes]

    async def uia(self, session, path, body, password):
        auth = {"type": "m.login.password", "identifier": {"type": "m.id.user", "user": session["user_id"]}, "password": password}
        token = self.store.open(session["token"])
        status, result = await self.matrix("POST", path, {**body, "auth": auth}, token, expected=False)
        if status == 401 and uia_password_challenge(result):
            auth["session"] = result["session"]
            return await self.matrix("POST", path, {**body, "auth": auth}, token)
        if status == 401 and result.get("flows"):
            raise APIError(400, "Your homeserver requires additional authentication. Complete this action with its identity provider.", "UNSUPPORTED_UIA")
        if status not in range(200, 300):
            raise APIError(status if status < 500 else 502, "The homeserver could not complete the account change.", result.get("errcode", "ACCOUNT_CHANGE_FAILED"))
        return result

    async def config_route(self, request):
        return web.json_response({"bootstrapRequired": self.bootstrap_required(), "smtpConfigured": self.smtp()["enabled"], "instance": self.store.get("instance", {"name": "Tavern", "description": ""}), "registrationMode": self.store.get("policy", {"registrationMode": "admin"}).get("registrationMode", "admin")})

    async def login_route(self, request):
        data = await body_json(request)
        self.store.rate("login:" + self.ip(request), 12, 60)
        username = text_value(data.get("username"), 254).strip()
        request["auditTarget"] = username
        self.store.rate("login-user:" + username.casefold(), 10, 300)
        if username == "admin" and data.get("password") == "admin":
            raise APIError(403, "Use Administrator Setup to initialize this installation. Default credentials cannot sign in.", "BOOTSTRAP_ONLY")
        local = self.store.db.execute("SELECT user_id FROM accounts WHERE email=? AND verified=1", (username.casefold(),)).fetchone()
        if local:
            username = local[0]
        password = text_value(data.get("password"), 1024)
        started = time.time()
        login = await self.login_upstream(username, password)
        # Evaluate factors only while holding the same lock used by enrollment,
        # revocation and password changes. A login started during enrollment must
        # observe the new factor even if its Matrix device was created earlier.
        async with self.user_locks.setdefault(login["user_id"], asyncio.Lock()):
            if self.store.account(login['user_id']).get('credential_epoch', 0) > started:
                await self.matrix('POST', '/_matrix/client/v3/logout', {}, login['access_token'], expected=False)
                raise APIError(401, 'Account security changed while signing in. Start sign-in again.', 'M_UNKNOWN_TOKEN')
            return await self.complete_login(request, login, data.get("remember") is True)

    async def complete_login(self, request, login, remember):
        account = self.store.account(login["user_id"])
        if account.get('access_blocked'):
            await self.matrix('POST', '/_matrix/client/v3/logout', {}, login['access_token'], expected=False)
            raise APIError(403, 'This account is restricted. Contact your administrator.', 'ACCOUNT_RESTRICTED')
        methods = self.methods(account)
        if methods:
            code = str(secrets.randbelow(1000000)).zfill(6) if "email" in methods else None
            challenge_id = self.store.challenge("login", {"login": login, "remember": remember}, login["user_id"], code)
            try:
                if code:
                    await self.send_email(account["email"], "Sign-in verification", f"Your sign-in code is {code}. It expires in 10 minutes. Do not share this code.")
            except APIError:
                self.store.consume(challenge_id)
                await self.matrix("POST", "/_matrix/client/v3/logout", {}, login["access_token"], expected=False)
                raise
            return web.json_response({"mfaRequired": True, "challengeId": challenge_id, "methods": methods})
        return await self.issue_session(request, login, remember)

    async def login_mfa(self, request):
        data = await body_json(request)
        self.store.rate("mfa-ip:" + self.ip(request), 20, 300)
        challenge = self.store.read_challenge(data.get("challengeId", ""), "login")
        async with self.user_locks.setdefault(challenge["user_id"], asyncio.Lock()):
            challenge = self.store.read_challenge(data.get("challengeId", ""), "login")
            self.store.db.execute("UPDATE challenges SET attempts=attempts+1 WHERE id=?", (challenge["id"],))
            self.verify_factor(challenge["user_id"], data.get("code"), data.get("method", "totp"), challenge)
            self.store.consume(challenge["id"])
            return await self.issue_session(request, challenge["payload"]["login"], challenge["payload"]["remember"])

    async def session_route(self, request):
        session = self.require_session(request)
        status, _ = await self.matrix("GET", "/_matrix/client/v3/account/whoami", token=self.store.open(session["token"]), expected=False)
        if status == 401:
            self.store.db.execute("DELETE FROM sessions WHERE id=?", (session["id"],))
            request["clearCookie"] = True
            raise APIError(401, "Your homeserver session expired. Sign in again.", "M_UNKNOWN_TOKEN")
        if status != 200:
            raise APIError(502, "Your homeserver session could not be checked. Try again.")
        return web.json_response(await self.session_info(session))

    async def logout(self, request):
        session = self.require_session(request)
        await self.matrix("POST", "/_matrix/client/v3/logout", {}, self.store.open(session["token"]), expected=False)
        self.store.db.execute("DELETE FROM sessions WHERE id=?", (session["id"],))
        request["clearCookie"] = True
        self.audit(session["user_id"], "logout", session["device_id"])
        return web.json_response({"ok": True})

    async def bootstrap_start(self, request):
        self.bootstrap_access(request)
        self.store.rate("bootstrap:" + self.ip(request), 5, 900)
        await self.bootstrap_server_check()
        data = await body_json(request)
        if data.get("username") != "admin" or data.get("password") != "admin":
            raise APIError(403, "The setup credentials were not accepted.", "FORBIDDEN")
        setup = data.get("setup", {})
        if not isinstance(setup, dict):
            raise APIError(400, "Enter the administrator setup details.")
        username = text_value(setup.get("username"), 64)
        if not re.fullmatch(r"[a-z0-9][a-z0-9._=-]{0,63}", username):
            raise APIError(400, "Use a lowercase username with letters, numbers, dots, underscores or dashes.")
        error = password_error(setup.get("password"), setup.get("confirmPassword"))
        if error:
            raise APIError(400, error)
        setup = {key: text_value(setup.get(key, ""), 2048 if "Url" in key else 1024) for key in ("username", "password", "displayName", "email", "timezone", "instanceName", "instanceDescription", "avatarUrl", "instanceIcon")}
        setup["email"] = email_address(setup["email"])
        if not setup["displayName"].strip() or not setup["instanceName"].strip():
            raise APIError(400, "Enter your display name and instance name.")
        pending = self.store.get("bootstrap_pending")
        if isinstance(pending, dict):
            # Interrupted creation resumes only the already-verified identity.
            if setup["username"] != pending["setup"]["username"] or setup["email"] != pending["setup"]["email"]:
                raise APIError(409, "Resume setup with the original administrator username and email.", "BOOTSTRAP_IN_PROGRESS")
            setup = pending["setup"]
        code = str(secrets.randbelow(1000000)).zfill(6)
        challenge = self.store.challenge("bootstrap", setup, code=code, duration=900)
        try:
            await self.send_email(setup["email"], "Verify your administrator account", f"Your Tavern administrator setup code is {code}. It expires in 15 minutes.")
        except APIError:
            self.store.consume(challenge)
            raise
        return web.json_response({"challengeId": challenge})

    async def bootstrap_complete(self, request):
        self.bootstrap_access(request)
        data = await body_json(request)
        async with self.bootstrap_lock:
            self.bootstrap_access(request)
            # bootstrap/start has already provisioned the service identity;
            # do not reacquire bootstrap_lock through ensure_service_account.
            if not self.store.get("bootstrap_pending"):
                inventory = await self.matrix("GET", "/_synapse/admin/v2/users?limit=1", token=await self.service_token())
                if inventory.get("total") != 1:
                    self.store.set("bootstrap_complete", True)
                    raise APIError(403, "This homeserver already contains accounts. Sign in with an existing administrator.", "BOOTSTRAP_DISABLED")
            challenge = self.store.read_challenge(data.get("challengeId", ""), "bootstrap")
            self.store.verify_code(challenge, data.get("code"))
            setup = challenge["payload"]
            pending = self.store.get("bootstrap_pending")
            if isinstance(pending, dict) and pending["setup"] != setup:
                raise APIError(409, "Another verified setup is finishing. Resume that setup.", "BOOTSTRAP_IN_PROGRESS")
            self.store.set("bootstrap_pending", {"setup": setup})
            try:
                login = await self.register(setup["username"], setup["password"], admin=True, display_name=setup["displayName"])
            except APIError as error:
                if error.code != "M_USER_IN_USE":
                    raise
                login = await self.login_upstream(setup["username"], setup["password"])
                check = await self.matrix("GET", "/_synapse/admin/v1/users/" + quote(login["user_id"], safe="") + "/admin", token=login["access_token"])
                if check.get("admin") is not True:
                    await self.matrix("POST", "/_matrix/client/v3/logout", {}, login["access_token"], expected=False)
                    raise APIError(409, "This username already belongs to another account.")
            self.store.db.execute("INSERT INTO accounts(user_id,email,verified,display_name,timezone,created) VALUES(?,?,1,?,?,?) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,verified=1,display_name=excluded.display_name,timezone=excluded.timezone", (login["user_id"], setup["email"], setup["displayName"], setup["timezone"] or "UTC", time.time()))
            self.store.set("instance", {"name": setup["instanceName"], "description": setup["instanceDescription"], "icon": setup["instanceIcon"]})
            self.store.set("bootstrap_complete", True)
            self.store.set("bootstrap_pending", None)
            self.store.consume(challenge["id"])
            self.audit(login["user_id"], "bootstrap_completed", login["user_id"])
        return await self.issue_session(request, login)

    async def account_security(self, request):
        session = self.require_session(request)
        account = self.store.account(session["user_id"])
        count = self.store.db.execute("SELECT count(*) FROM recovery_codes WHERE user_id=?", (session["user_id"],)).fetchone()[0]
        return web.json_response({"email": account.get("email", ""), "emailVerified": bool(account.get("verified")), "totpEnabled": bool(account.get("totp")), "emailMfaEnabled": bool(account.get("email_mfa")), "recoveryCodesRemaining": count})

    async def sensitive_email(self, request):
        session = self.require_session(request)
        account = self.store.account(session["user_id"])
        if not account.get("email_mfa") or not account.get("verified"):
            raise APIError(400, "Email verification is not enabled for this account.")
        self.store.rate("sensitive-email:" + session["user_id"], 3, 300)
        code = str(secrets.randbelow(1000000)).zfill(6)
        identity = self.store.challenge("sensitive", {"sessionId": session["id"]}, session["user_id"], code)
        await self.send_email(account["email"], "Confirm a security change", f"Your security confirmation code is {code}. It expires in 10 minutes.")
        return web.json_response({"challengeId": identity})

    async def email_start(self, request):
        data = await body_json(request)
        session = await self.require_sensitive(request, data)
        email = email_address(data.get("email"))
        existing = self.store.db.execute("SELECT user_id FROM accounts WHERE email=? AND user_id<>?", (email, session["user_id"])).fetchone()
        if existing:
            raise APIError(400, "That email address cannot be used.")
        self.store.rate("email-change:" + session["user_id"], 3, 300)
        code = str(secrets.randbelow(1000000)).zfill(6)
        challenge = self.store.challenge("email", {"email": email, "sessionId": session["id"]}, session["user_id"], code)
        await self.send_email(email, "Verify your email", f"Your email verification code is {code}. It expires in 10 minutes.")
        return web.json_response({"challengeId": challenge})

    async def email_complete(self, request):
        session, data = self.require_session(request), await body_json(request)
        challenge = self.store.read_challenge(data.get("challengeId", ""), "email", session["user_id"])
        if challenge["payload"]["sessionId"] != session["id"]:
            raise APIError(400, "Confirm the email from the session that requested it.")
        self.store.verify_code(challenge, data.get("code"))
        self.store.consume(challenge["id"])
        await self.security_notice(session["user_id"], "Email changed", "Your Tavern email address was changed. Contact your administrator if you did not make this change.")
        try:
            self.store.db.execute("UPDATE accounts SET email=?,verified=1 WHERE user_id=?", (challenge["payload"]["email"], session["user_id"]))
        except sqlite3.IntegrityError:
            raise APIError(400, "That email address cannot be used.") from None
        self.audit(session["user_id"], "email_changed", session["user_id"])
        return web.json_response({"ok": True})

    async def totp_start(self, request):
        data = await body_json(request)
        session = await self.require_sensitive(request, data)
        if self.store.account(session["user_id"]).get("totp"):
            raise APIError(409, "An authenticator is already configured. Disable it before replacing it.")
        secret, uri = totp_setup(session["user_id"])
        identity = self.store.challenge("totp", {"secret": secret, "sessionId": session["id"], "password": data["password"]}, session["user_id"])
        return web.json_response({"challengeId": identity, "secret": secret, "uri": uri})

    async def totp_complete(self, request):
        session, data = self.require_session(request), await body_json(request)
        challenge = self.store.read_challenge(data.get("challengeId", ""), "totp", session["user_id"])
        self.store.db.execute("UPDATE challenges SET attempts=attempts+1 WHERE id=?", (challenge["id"],))
        if challenge["payload"]["sessionId"] != session["id"]:
            raise APIError(400, "Finish setup from the session that started it.")
        if self.store.account(session["user_id"]).get("totp"):
            raise APIError(409, "An authenticator is already configured. Disable it before replacing it.")
        counter = verify_totp(challenge["payload"]["secret"], data.get("code"))
        if counter is None:
            raise APIError(400, "Enter the six-digit code from your authenticator.", "INVALID_CODE")
        self.store.consume(challenge["id"])
        await self.revoke_upstream_others(session, challenge["payload"]["password"])
        self.store.db.execute("UPDATE accounts SET totp=?,totp_counter=? WHERE user_id=?", (self.store.seal(challenge["payload"]["secret"]), counter, session["user_id"]))
        codes = self.new_recovery_codes(session["user_id"])
        self.audit(session["user_id"], "totp_enabled", session["user_id"])
        await self.security_notice(session["user_id"], "Authenticator enabled", "An authenticator was enabled for your Tavern account. Store your recovery codes somewhere safe.")
        return web.json_response({"recoveryCodes": codes})

    async def email_mfa(self, request):
        data = await body_json(request)
        session = await self.require_sensitive(request, data)
        account = self.store.account(session["user_id"])
        if not account.get("verified") or not self.smtp()["enabled"]:
            raise APIError(400, "Verify your email address and configure SMTP before enabling email verification.")
        enabled = data.get("enabled") is True
        was_enabled = bool(self.methods(account))
        if enabled:
            await self.revoke_upstream_others(session, data["password"])
        self.store.db.execute("UPDATE accounts SET email_mfa=? WHERE user_id=?", (int(enabled), session["user_id"]))
        self.audit(session["user_id"], "email_mfa_enabled" if enabled else "email_mfa_disabled", session["user_id"])
        codes = self.new_recovery_codes(session["user_id"]) if enabled and not was_enabled else None
        return web.json_response({"ok": True, **({"recoveryCodes": codes} if codes else {})})

    async def disable_mfa(self, request):
        data = await body_json(request)
        session = await self.require_sensitive(request, data)
        self.store.db.execute("UPDATE accounts SET totp=NULL,email_mfa=0,totp_counter=-1 WHERE user_id=?", (session["user_id"],))
        self.store.db.execute("DELETE FROM recovery_codes WHERE user_id=?", (session["user_id"],))
        self.audit(session["user_id"], "mfa_disabled", session["user_id"])
        await self.security_notice(session["user_id"], "Verification disabled", "Additional sign-in verification was disabled for your Tavern account.")
        return web.json_response({"ok": True})

    async def regenerate_recovery_codes(self, request):
        data = await body_json(request)
        session = await self.require_sensitive(request, data)
        if not self.methods(self.store.account(session["user_id"])):
            raise APIError(400, "Enable an authenticator or email verification before generating recovery codes.")
        codes = self.new_recovery_codes(session["user_id"])
        self.audit(session["user_id"], "recovery_codes_regenerated", session["user_id"])
        self.background(self.security_notice(session["user_id"], "Recovery codes replaced", "New Tavern recovery codes were generated. All previous recovery codes are invalid."))
        return web.json_response({"recoveryCodes": codes})

    async def account_password(self, request):
        data = await body_json(request)
        error = password_error(data.get("newPassword"), data.get("confirmation"))
        if error:
            raise APIError(400, error)
        if data.get("newPassword") == data.get("currentPassword"):
            raise APIError(400, "Choose a different new password.")
        session = await self.require_sensitive(request, data)
        logout_others = bool(self.store.account(session['user_id']).get('password_change_required')) or data.get("logoutOtherDevices", True) is not False
        await self.uia(session, "/_matrix/client/v3/account/password", {"new_password": data["newPassword"], "logout_devices": logout_others}, data["currentPassword"])
        self.store.db.execute('UPDATE accounts SET password_change_required=0,credential_epoch=? WHERE user_id=?', (time.time(), session['user_id']))
        if logout_others:
            self.store.db.execute("DELETE FROM sessions WHERE user_id=? AND id<>?", (session["user_id"], session["id"]))
            self.store.db.execute("DELETE FROM challenges WHERE user_id=? AND kind='login'", (session["user_id"],))
        self.audit(session["user_id"], "password_changed", session["user_id"])
        await self.security_notice(session["user_id"], "Password changed", "Your Tavern password was changed. Encryption recovery keys are unchanged.")
        return web.json_response({"ok": True})

    async def deactivate(self, request):
        data = await body_json(request)
        session = self.require_session(request)
        if data.get("confirmation") != session["user_id"]:
            raise APIError(400, "Type your full Matrix user ID to confirm account deletion.")
        session = await self.require_sensitive(request, data)
        status, admin = await self.matrix('GET', '/_synapse/admin/v1/users/' + quote(session['user_id'], safe='') + '/admin', token=self.store.open(session['token']), expected=False)
        if status not in (200, 403):
            raise APIError(503, 'Administrator status could not be checked. Account deactivation remains locked.')
        if admin.get('admin') is True:
            raise APIError(400, 'An administrator account must be deactivated by another active administrator.')
        await self.uia(session, "/_matrix/client/v3/account/deactivate", {"erase": data.get("erase") is True}, data["password"])
        await self.security_notice(session["user_id"], "Account deactivated", "Your Tavern account has been deactivated. Copies already held by other people are not removed.")
        self.store.db.execute("DELETE FROM sessions WHERE user_id=?", (session["user_id"],))
        self.store.db.execute("DELETE FROM recovery_codes WHERE user_id=?", (session["user_id"],))
        self.store.db.execute("DELETE FROM challenges WHERE user_id=?", (session["user_id"],))
        self.store.db.execute("DELETE FROM accounts WHERE user_id=?", (session["user_id"],))
        self.audit(session["user_id"], "account_deactivated", session["user_id"])
        request["clearCookie"] = True
        return web.json_response({"ok": True})

    async def sessions(self, request):
        current = self.require_session(request)
        rows = self.store.db.execute("SELECT * FROM sessions WHERE user_id=? AND expires>? ORDER BY last_seen DESC LIMIT 100", (current["user_id"], time.time())).fetchall()
        return web.json_response({"currentSessionId": current["id"], "sessions": [{"id": row["id"], "deviceId": row["device_id"], "name": row["name"], "lastSeen": int(row["last_seen"] * 1000), "createdAt": int(row["created"] * 1000), "current": row["id"] == current["id"], "ip": row["ip"]} for row in rows]})

    async def revoke_session(self, request):
        current = self.require_session(request)
        target = self.store.db.execute("SELECT * FROM sessions WHERE id=? AND user_id=?", (request.match_info["identity"], current["user_id"])).fetchone()
        if not target:
            raise APIError(404, "This session is no longer available.")
        await self.matrix("POST", "/_matrix/client/v3/logout", {}, self.store.open(target["token"]), expected=False)
        self.store.db.execute("DELETE FROM sessions WHERE id=?", (target["id"],))
        self.audit(current["user_id"], "session_revoked", target["device_id"])
        if target["id"] == current["id"]:
            request["clearCookie"] = True
        return web.json_response({"ok": True})

    async def revoke_others(self, request):
        data = await body_json(request)
        session = await self.require_sensitive(request, data)
        count = await self.revoke_upstream_others(session, data["password"])
        self.audit(session["user_id"], "other_sessions_revoked", session["user_id"])
        return web.json_response({"ok": True, "revoked": count})

    async def revoke_upstream_others(self, session, password):
        token = self.store.open(session["token"])
        devices = (await self.matrix("GET", "/_matrix/client/v3/devices", token=token)).get("devices", [])
        ids = [device["device_id"] for device in devices if device.get("device_id") != session["device_id"]]
        if ids:
            await self.uia(session, "/_matrix/client/v3/delete_devices", {"devices": ids}, password)
        self.store.db.execute("DELETE FROM sessions WHERE user_id=? AND id<>?", (session["user_id"], session["id"]))
        self.store.db.execute("DELETE FROM challenges WHERE user_id=? AND kind='login'", (session["user_id"],))
        return len(ids)

    async def recovery_start(self, request):
        data = await body_json(request)
        self.store.rate("recovery:" + self.ip(request), 5, 900)
        email = email_address(data.get("email"))
        self.store.rate("recovery-email:" + email, 3, 900)
        account = self.store.db.execute("SELECT * FROM accounts WHERE email=? AND verified=1", (email,)).fetchone()
        identity = secrets.token_urlsafe(32)
        if account and self.store.get("service_account"):
            code = str(secrets.randbelow(1000000)).zfill(6)
            identity = self.store.challenge("recovery", {}, account["user_id"], code)
            async def deliver():
                try:
                    await self.send_email(email, "Password recovery", f"Your password recovery code is {code}. It expires in 10 minutes. If you did not request it, ignore this email.")
                except APIError:
                    self.store.consume(identity)
                    self.audit("system", "recovery_email_failed", account["user_id"])
            self.background(deliver())
        return web.json_response({"challengeId": identity, "message": "If this address belongs to a verified account, a recovery code has been sent."})

    async def recovery_complete(self, request):
        data = await body_json(request)
        self.store.rate("recovery-complete:" + self.ip(request), 10, 900)
        error = password_error(data.get("newPassword"), data.get("confirmation"))
        if error:
            raise APIError(400, error)
        challenge = self.store.read_challenge(data.get("challengeId", ""), "recovery")
        async with self.user_locks.setdefault(challenge["user_id"], asyncio.Lock()):
            return await self.finish_recovery(data)

    async def finish_recovery(self, data):
        challenge = self.store.read_challenge(data.get("challengeId", ""), "recovery")
        self.store.verify_code(challenge, data.get("code"))
        account = self.store.account(challenge["user_id"])
        # Email alone must never remove or bypass an existing authenticator.
        if account.get("totp"):
            self.verify_factor(challenge["user_id"], data.get("mfaCode"), data.get("method", "totp"))
        self.store.consume(challenge["id"])
        token = await self.service_token()
        await self.matrix("POST", "/_synapse/admin/v1/reset_password/" + quote(challenge["user_id"], safe=""), {"new_password": data["newPassword"], "logout_devices": True}, token)
        self.store.db.execute('UPDATE accounts SET password_change_required=0,credential_epoch=? WHERE user_id=?', (time.time(), challenge['user_id']))
        self.store.db.execute("DELETE FROM sessions WHERE user_id=?", (challenge["user_id"],))
        self.audit(challenge["user_id"], "password_recovered", challenge["user_id"])
        await self.security_notice(challenge["user_id"], "Password recovered", "Your Tavern password was reset and all devices were signed out. Your encryption recovery key is still needed to restore encrypted history.")
        return web.json_response({"ok": True})

    async def admin_overview(self, request):
        session = await self.require_admin(request)
        token = self.store.open(session["token"])
        users, rooms, version = await asyncio.gather(self.matrix("GET", "/_synapse/admin/v2/users?limit=1", token=token), self.matrix("GET", "/_synapse/admin/v1/rooms?limit=1", token=token), self.matrix("GET", "/_synapse/admin/v1/server_version", token=token))
        count = self.store.db.execute("SELECT count(*) FROM sessions WHERE expires>?", (time.time(),)).fetchone()[0]
        return web.json_response({"users": users.get("total", 0), "rooms": rooms.get("total_rooms", 0), "sessions": count, "version": API_VERSION, "synapseVersion": version.get("server_version", ""), "emailConfigured": self.smtp()["enabled"]})

    async def admin_users(self, request):
        session = await self.require_admin(request)
        token = self.store.open(session["token"])
        if request.method == "GET":
            return await import_module((__package__ + '.' if __package__ else '') + 'admin_users').listing(request)
        data = await body_json(request)
        username = text_value(data.get("username"), 64)
        if not re.fullmatch(r"[a-z0-9][a-z0-9._=-]{0,63}", username):
            raise APIError(400, "Enter a valid lowercase username.")
        error = password_error(data.get("password"))
        if error:
            raise APIError(400, error)
        email = email_address(data["email"]) if data.get("email") else None
        if email and self.store.db.execute("SELECT 1 FROM accounts WHERE email=?", (email,)).fetchone():
            raise APIError(400, "This email already belongs to an account.")
        login = await self.register(username, data["password"], admin=data.get("admin") is True, display_name=text_value(data.get("displayName", ""), 200))
        await self.matrix("POST", "/_matrix/client/v3/logout", {}, login["access_token"], expected=False)
        self.store.db.execute("INSERT OR IGNORE INTO accounts(user_id,display_name,email,verified,created) VALUES(?,?,?,0,?)", (login["user_id"], data.get("displayName", ""), email, time.time()))
        self.audit(session["user_id"], "user_created", login["user_id"])
        return web.json_response({"userId": login["user_id"]}, status=201)

    async def admin_user_update(self, request):
        return await import_module((__package__ + '.' if __package__ else '') + 'admin_users').update(request)

    async def admin_settings(self, request):
        session = await self.require_admin(request)
        if request.method == "PUT":
            data = await body_json(request)
            if "smtp" in data:
                proposed = data["smtp"]
                if not isinstance(proposed, dict):
                    raise APIError(400, "Invalid SMTP settings.")
                settings = self.smtp()
                for key in ("enabled", "host", "port", "secure", "username", "fromName", "fromAddress"):
                    if key in proposed:
                        settings[key] = proposed[key]
                if proposed.get("password"):
                    settings["password"] = text_value(proposed["password"], 1024)
                if type(settings["enabled"]) is not bool or type(settings["secure"]) is not bool or type(settings["port"]) is not int or not 1 <= settings["port"] <= 65535:
                    raise APIError(400, "Enter valid SMTP port and TLS settings.")
                if settings["enabled"]:
                    email_address(settings["fromAddress"])
                for key in ("host", "username", "fromName", "fromAddress"):
                    if not isinstance(settings[key], str) or len(settings[key]) > 254 or "\r" in settings[key] or "\n" in settings[key]:
                        raise APIError(400, "Enter valid SMTP settings.")
                self.store.set("smtp", settings)
            if "instance" in data:
                value = data["instance"]
                if not isinstance(value, dict):
                    raise APIError(400, "Invalid instance settings.")
                self.store.set("instance", {key: text_value(value.get(key, ""), 2000) for key in ("name", "description", "icon", "contact", "termsUrl", "privacyUrl")})
            if "policy" in data:
                value = data["policy"]
                if not isinstance(value, dict) or value.get("registrationMode") not in {"admin", "invite", "open"}:
                    raise APIError(400, "Choose administrator, invitation or open account registration.")
                self.store.set("policy", {**self.store.get("policy", {}), "registrationMode": value["registrationMode"]})
            self.audit(session["user_id"], "settings_updated", "instance")
        return web.json_response({"smtp": self.smtp(reveal=False), "instance": self.store.get("instance", {"name": "Tavern", "description": ""}), "policy": self.store.get("policy", {"registrationMode": "admin"})})

    async def admin_email_test(self, request):
        session = await self.require_admin(request)
        data = await body_json(request)
        address = data.get("to") or self.store.account(session["user_id"]).get("email") or self.smtp()["fromAddress"]
        await self.send_email(address, "Email connection test", "Your Tavern email configuration is working.", test_only=data.get("connectionOnly") is True)
        self.audit(session["user_id"], "smtp_test", "instance")
        return web.json_response({"ok": True})

    async def admin_audit(self, request):
        await self.require_admin(request)
        before = int(request.query.get("before", str(2 ** 63 - 1)))
        if not 0 < before < 2 ** 63:
            raise APIError(400, "Invalid audit page.")
        conditions, values = ["id<?"], [before]
        for name in ("actor", "action", "target"):
            value = text_value(request.query.get(name, ""), 255).strip()
            if value:
                conditions.append(name + "=?")
                values.append(value)
        if request.query.get("security") == "true":
            conditions.append("(action IN ('login','login_failed','verification_failed','request_rejected','rate_limited','logout','session_revoked','other_sessions_revoked','password_changed','password_recovered','email_changed','totp_enabled','email_mfa_enabled','email_mfa_disabled','mfa_disabled','recovery_codes_regenerated','recovery_code_used','account_deactivated') OR action LIKE 'security_%')")
        for parameter, comparison in (("since", ">="), ("until", "<=")):
            if parameter in request.query:
                timestamp = int(request.query[parameter])
                if not 0 <= timestamp <= 253402300799:
                    raise APIError(400, "Invalid audit date.")
                conditions.append("created" + comparison + "?")
                values.append(timestamp)
        rows = self.store.db.execute("SELECT * FROM audit WHERE " + " AND ".join(conditions) + " ORDER BY id DESC LIMIT 101", values).fetchall()
        return web.json_response({"events": [dict(row) for row in rows[:100]], "next": rows[99]["id"] if len(rows) > 100 else None})

    async def proxy(self, request):
        session = self.require_session(request)
        expected = "Bearer cookie-session:" + session["device_id"]
        if not hmac.compare_digest(request.headers.get("Authorization", ""), expected):
            raise APIError(401, "This browser is now using a different device session. Reload Tavern before continuing.", "M_UNKNOWN_TOKEN")
        maintenance = self.store.get("policy", {}).get("maintenance", {})
        if maintenance.get("enabled"):
            try:
                await self.require_admin(request)
            except APIError as error:
                if error.status != 403:
                    raise
                raise APIError(503, maintenance.get("message") or "Tavern is undergoing maintenance. Please try again shortly.", "MAINTENANCE_MODE") from None
        raw = request.raw_path[len("/api/matrix"):]
        path = unquote(raw.split("?", 1)[0])
        if not path.startswith(("/_matrix/client/", "/_matrix/media/")) or "/../" in path or "\\" in path or "access_token" in request.query:
            raise APIError(403, "This Matrix route is not available.", "FORBIDDEN")
        # Every credential path goes through Tavern so MFA cannot be bypassed.
        if re.search(r"/_matrix/client/(?:api/v1|[^/]+)/(login|register|refresh|account/password|account/deactivate|account/3pid)(/|$)", path) and request.method != "GET":
            raise APIError(403, "Use Tavern account settings for this operation.", "ACCOUNT_ROUTE_REQUIRED")
        if re.search(r"/_matrix/client/(?:api/v1|[^/]+)/logout(?:/all)?$", path):
            raise APIError(403, "Use Tavern session settings to sign out.", "ACCOUNT_ROUTE_REQUIRED")
        upload_path = re.fullmatch(r"/_matrix/(?:media/(?:r0|v3)|client/(?:v1|v3|unstable)/media)/upload", path)
        if upload_path and request.method == "POST":
            return await self.uploads.upload(request, session, raw)
        if request.method in {"POST", "PUT"} and (path.startswith("/_matrix/media/") or re.search(r"/_matrix/client/[^/]+/media/", path)):
            raise APIError(403, "Use Tavern's supported media upload route.", "UNSUPPORTED_MEDIA_OPERATION")
        headers = {"Authorization": "Bearer " + self.store.open(session["token"])}
        for name in ("Content-Type", "Accept", "Range", "If-None-Match"):
            if name in request.headers:
                headers[name] = request.headers[name]
        # Stream media uploads and downloads. Never cache private response bodies.
        async with self.http.request(request.method, self.config.synapse_url + raw, data=request.content.iter_chunked(65536) if request.can_read_body else None, headers=headers, allow_redirects=False) as upstream:
            governed = re.fullmatch(r"/_matrix/client/(?:api/v1|[^/]+)/rooms/([^/]+)/state/(io\.tavern\.(?:roles|channel|timeout|thread|server\.layout))(?:/.*)?", path)
            if governed and request.method == "PUT" and 200 <= upstream.status < 300:
                self.audit(session["user_id"], "room_policy_changed", governed[1], governed[2])
            response = web.StreamResponse(status=upstream.status)
            for name in ("Content-Type", "Content-Length", "Content-Encoding", "Content-Range", "Accept-Ranges", "ETag", "Retry-After"):
                if name in upstream.headers:
                    response.headers[name] = upstream.headers[name]
            await response.prepare(request)
            async for chunk in upstream.content.iter_chunked(65536):
                await response.write(chunk)
            await response.write_eof()
            return response


def text_value(value: object, maximum: int) -> str:
    if not isinstance(value, str) or len(value) > maximum or "\x00" in value:
        raise APIError(400, "Enter valid text within the field length limit.", "INVALID_INPUT")
    return value


async def body_json(request):
    if request.content_type != "application/json":
        raise APIError(415, "Send this request as JSON.", "INVALID_CONTENT_TYPE")
    if request.content_length and request.content_length > 32768:
        raise APIError(413, "This request is too large.")
    try:
        raw = bytearray()
        async for chunk in request.content.iter_chunked(8192):
            raw.extend(chunk)
            if len(raw) > 32768:
                raise APIError(413, "This request is too large.")
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise APIError(400, "This request contains invalid JSON.", "INVALID_JSON") from None
    if not isinstance(data, dict):
        raise APIError(400, "Send a JSON object.", "INVALID_JSON")
    return data


@web.middleware
async def boundary(request, handler):
    service = request.app["service"]
    try:
        if request.path != "/health":
            if request.method not in {"GET", "HEAD", "OPTIONS"} and request.headers.get("Origin") != service.config.public_url:
                raise APIError(403, "The request origin was not accepted. Reload Tavern and try again.", "CSRF_REJECTED")
            if request.headers.get("Sec-Fetch-Site") == "cross-site":
                raise APIError(403, "Cross-site requests are not accepted.", "CSRF_REJECTED")
            service.authenticate(request)
        if request.method not in {"GET", "HEAD", "OPTIONS"} and request.path.startswith("/api/account/") and request.get("session"):
            # Prevent concurrent factor replacement and other sensitive operations
            # from racing one another on independent requests from the same user.
            identity = request["session"]["user_id"]
            lock = service.user_locks.setdefault(identity, asyncio.Lock())
            async with lock:
                service.require_session(request)
                return await handler(request)
        return await handler(request)
    except APIError as error:
        action = "rate_limited" if error.status == 429 else "request_rejected" if error.code == "CSRF_REJECTED" else "login_failed" if request.path == "/api/auth/login" and error.status in {400, 401, 403} else "verification_failed" if request.path == "/api/auth/mfa" and error.status in {400, 401, 403} else ""
        if action:
            # A rejected request must never turn into a log-flooding primitive.
            try:
                service.store.rate("audit-rejection:" + service.ip(request) + ":" + action, 1, 60)
                session = request.get("session")
                service.audit(session["user_id"] if session else "unauthenticated", action, request.get("auditTarget", ""), error.code)
            except (APIError, ValueError):
                pass
        return web.json_response({"error": error.message, "errcode": error.code, **error.details}, status=error.status)
    except ValueError:
        return web.json_response({"error": "Check the values and trusted proxy configuration, then try again.", "errcode": "INVALID_INPUT"}, status=400)
    except (aiohttp.ClientError, asyncio.TimeoutError):
        return web.json_response({"error": "The homeserver is temporarily unavailable. Try again.", "errcode": "UPSTREAM_UNAVAILABLE"}, status=502)
    except web.HTTPException:
        raise
    except Exception:
        LOG.error("An account operation failed", exc_info=False)
        return web.json_response({"error": "This operation could not be completed. Try again or contact your administrator.", "errcode": "INTERNAL_ERROR"}, status=500)


async def response_headers(request, response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.get("clearCookie"):
        response.del_cookie(COOKIE, path="/", secure=True, httponly=True, samesite="Strict")
    elif request.get("cookie"):
        cookie, session = request["cookie"]
        response.set_cookie(COOKIE, cookie, path="/", secure=True, httponly=True, samesite="Strict", max_age=max(0, int(session["expires"] - time.time())) if session["persistent"] else None)
    # aiohttp serializes cookies before on_response_prepare. Add the newly set
    # cookie explicitly here so streamed Matrix responses can rotate it too.
    if request.get("clearCookie") or request.get("cookie"):
        response.headers.add("Set-Cookie", response.cookies[COOKIE].output(header="").strip())


def create_app(config: Config | None = None):
    config = config or Config.environment()
    app = web.Application(middlewares=[boundary], client_max_size=12 * 1024 * 1024)
    service = Service(config)
    app["service"] = service
    async def health(request):
        service.store.db.execute("SELECT 1").fetchone()
        return web.json_response({"status": "ok", "version": os.environ.get("TAVERN_VERSION", API_VERSION)})
    routes = [web.get("/health", health),
              web.get("/api/auth/config", service.config_route), web.post("/api/auth/login", service.login_route), web.post("/api/auth/mfa", service.login_mfa),
              web.get("/api/auth/session", service.session_route), web.post("/api/auth/logout", service.logout),
              web.post("/api/auth/bootstrap/start", service.bootstrap_start), web.post("/api/auth/bootstrap/complete", service.bootstrap_complete),
              web.post("/api/auth/recovery/start", service.recovery_start), web.post("/api/auth/recovery/complete", service.recovery_complete),
              web.get("/api/account/security", service.account_security), web.post("/api/account/security/email-code", service.sensitive_email),
              web.post("/api/account/email/start", service.email_start), web.post("/api/account/email/complete", service.email_complete),
              web.post("/api/account/mfa/totp/start", service.totp_start), web.post("/api/account/mfa/totp/complete", service.totp_complete),
              web.post("/api/account/mfa/email", service.email_mfa), web.post("/api/account/mfa/disable", service.disable_mfa),
              web.post("/api/account/mfa/recovery-codes", service.regenerate_recovery_codes),
              web.post("/api/account/password", service.account_password), web.post("/api/account/deactivate", service.deactivate),
              web.get("/api/account/sessions", service.sessions), web.delete("/api/account/sessions/{identity}", service.revoke_session),
              web.post("/api/account/sessions/revoke-others", service.revoke_others),
              web.get("/api/admin/overview", service.admin_overview), web.get("/api/admin/users", service.admin_users), web.post("/api/admin/users", service.admin_users),
              web.put("/api/admin/users/{user_id}", service.admin_user_update), web.get("/api/admin/settings", service.admin_settings), web.put("/api/admin/settings", service.admin_settings),
              web.post("/api/admin/email/test", service.admin_email_test), web.get("/api/admin/audit", service.admin_audit), web.route("*", "/api/matrix/{tail:.*}", service.proxy)]
    app.add_routes(routes)
    app.on_startup.append(service.start)
    app.on_cleanup.append(service.close)
    app.on_response_prepare.append(response_headers)
    # Ship the complete route set or fail startup. Missing modules must not make
    # the health check report success while silently disabling permissions/features.
    prefix = __package__ + "." if __package__ else ""
    for module in ("operations", "social", "community_api", "system_policy", "admin_resources", "integrations_admin", "invitation_privacy", "call_moderation", "link_preview", "admin_users"):
        import_module(prefix + module).register_routes(app)
    return app


if __name__ == "__main__":
    # Modules import shared helpers from `server` in the container's flat /app
    # layout. Keep that name bound to this script, not a second class definition.
    sys.modules["server"] = sys.modules[__name__]
    logging.basicConfig(level=logging.INFO)
    web.run_app(create_app(), host="0.0.0.0", port=8090, access_log=None)
