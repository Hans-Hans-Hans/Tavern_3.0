"""Durable invitations, moderation reports and user-owned data exports.

Matrix remains the authority for room access. Invitation redemption sends a
standard Matrix invite as the still-authorized issuer, never bypassing room bans
or adding a privileged service identity to an encrypted conversation.
"""
from __future__ import annotations

import asyncio
import json
import re
import secrets
import sqlite3
import time
from urllib.parse import quote

from aiohttp import web

try:
    from .server import APIError, body_json, text_value
    from .security import email_address, password_error
    from .invitation_roles import checked_roles, apply_roles, role_ids
    from .room_reports import verified_context, schema as report_schema
except ImportError:
    from server import APIError, body_json, text_value
    from security import email_address, password_error
    from invitation_roles import checked_roles, apply_roles, role_ids
    from room_reports import verified_context, schema as report_schema


def schema(store):
    store.db.executescript("""
        CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,room_id TEXT NOT NULL,
            room_name TEXT NOT NULL,creator TEXT NOT NULL,created REAL NOT NULL,expires REAL NOT NULL,max_uses INTEGER NOT NULL,
            uses INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0,email TEXT,domain TEXT);
        CREATE INDEX IF NOT EXISTS invitation_creator ON invitations(creator,created);
        CREATE INDEX IF NOT EXISTS invitation_room ON invitations(room_id,created);
        CREATE TABLE IF NOT EXISTS invitation_redemptions(invitation_id TEXT NOT NULL,user_id TEXT NOT NULL,state TEXT NOT NULL,
            created REAL NOT NULL,PRIMARY KEY(invitation_id,user_id),FOREIGN KEY(invitation_id) REFERENCES invitations(id));
        CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT,reporter TEXT NOT NULL,kind TEXT NOT NULL,
            room_id TEXT,event_id TEXT,target_id TEXT,reason TEXT NOT NULL,evidence TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',
            created REAL NOT NULL,updated REAL NOT NULL,reviewer TEXT,note TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS report_status ON reports(status,id);
        CREATE INDEX IF NOT EXISTS report_reporter ON reports(reporter,id);
    """)
    if 'default_roles' not in {row[1] for row in store.db.execute('PRAGMA table_info(invitations)')}:
        store.db.execute("ALTER TABLE invitations ADD COLUMN default_roles TEXT NOT NULL DEFAULT '[]'")
    if 'splash_mxc' not in {row[1] for row in store.db.execute('PRAGMA table_info(invitations)')}:
        store.db.execute("ALTER TABLE invitations ADD COLUMN splash_mxc TEXT NOT NULL DEFAULT ''")
    report_schema(store)


def invite_view(row):
    return {"id": row["id"], "roomId": row["room_id"], "roomName": row["room_name"], "creator": row["creator"], "createdAt": int(row["created"] * 1000),
            "expiresAt": int(row["expires"] * 1000), "maxUses": row["max_uses"], "uses": row["uses"], "revoked": bool(row["revoked"]), "email": row["email"], "domain": row["domain"], "defaultRoleIds": json.loads(row["default_roles"])}


def report_view(row, own=False):
    value = {"id": row["id"], "kind": row["kind"], "roomId": row["room_id"], "eventId": row["event_id"], "targetId": row["target_id"],
             "reason": row["reason"], "evidence": row["evidence"], "status": row["status"], "audience": row["audience"], "createdAt": int(row["created"] * 1000), "updatedAt": int(row["updated"] * 1000)}
    if not own:
        value.update(reporter=row["reporter"], reviewer=row["reviewer"], note=row["note"])
    return value


def active_invitation(service, token: object):
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,80}", token):
        raise APIError(404, "This invitation is unavailable.", "INVITATION_UNAVAILABLE")
    row = service.store.db.execute("SELECT * FROM invitations WHERE token_hash=?", (service.store.digest("invite:" + token),)).fetchone()
    if not row or row["revoked"] or row["expires"] <= time.time():
        raise APIError(404, "This invitation expired or was revoked.", "INVITATION_UNAVAILABLE")
    return dict(row)


def invitation_email(invitation, email, verified):
    if not invitation["email"] and not invitation["domain"]:
        return
    if not verified or not email:
        raise APIError(403, "Verify your email address before accepting this invitation.", "EMAIL_VERIFICATION_REQUIRED")
    if invitation["email"] and email != invitation["email"]:
        raise APIError(403, "This invitation is restricted to a different email address.", "INVITATION_RESTRICTED")
    if invitation["domain"] and email.rsplit("@", 1)[-1] != invitation["domain"]:
        raise APIError(403, "Your verified email domain does not match this invitation.", "INVITATION_RESTRICTED")


def invitation_splash(value):
    return value if isinstance(value, str) and len(value) <= 1024 and re.fullmatch(r'mxc://[^/\s?#\\]+/[A-Za-z0-9_-]+', value) else ''


async def snapshot_invitation_splash(service, room_id, token):
    # Read as the joined issuer only when creating an invitation. Previews use
    # this explicit shareable field from SQLite, never private Space state.
    prefix = '/_matrix/client/v3/rooms/' + quote(room_id, safe='') + '/state/'
    status, create = await service.matrix('GET', prefix + 'm.room.create/', token=token, expected=False)
    if status == 404 or status == 200 and create.get('type') != 'm.space':
        return ''
    if status != 200:
        raise APIError(502, 'Server invitation artwork could not be checked. Try again.')
    status, branding = await service.matrix('GET', prefix + 'io.tavern.server.branding/', token=token, expected=False)
    if status == 404:
        return ''
    if status != 200:
        raise APIError(502, 'Server invitation artwork could not be checked. Try again.')
    return invitation_splash(branding.get('inviteSplash'))


async def issuer_authority(service, room_id: str, issuer: str, token=None):
    if service.store.account(issuer).get('access_blocked'):
        raise APIError(403, 'The invitation issuer is suspended. Ask another moderator for an invitation.', 'INVITATION_UNAVAILABLE')
    if token:
        prefix = "/_matrix/client/v3/rooms/" + quote(room_id, safe="") + "/state/"
        membership = await service.matrix("GET", prefix + "m.room.member/" + quote(issuer, safe=""), token=token)
        status, powers = await service.matrix("GET", prefix + "m.room.power_levels/", token=token, expected=False)
        if status == 404:
            powers = {}
        elif status != 200:
            raise APIError(403, "Room permissions could not be checked.", "FORBIDDEN")
        if membership.get("membership") != "join":
            raise APIError(403, "Join this room before creating invitations.", "FORBIDDEN")
        level = powers.get("users", {}).get(issuer, powers.get("users_default", 0))
        if not isinstance(level, int) or level < powers.get("invite", 0):
            raise APIError(403, "You do not have permission to invite people to this room.", "FORBIDDEN")
        return
    # The issuer may have signed out. Read current room state using the account
    # service without enrolling its device in this room or obtaining room keys.
    value = await service.matrix("GET", "/_synapse/admin/v1/rooms/" + quote(room_id, safe="") + "/state", token=await service.service_token())
    state = value.get("state", [])
    membership = next((event.get("content", {}) for event in state if event.get("type") == "m.room.member" and event.get("state_key") == issuer), {})
    powers = next((event.get("content", {}) for event in state if event.get("type") == "m.room.power_levels" and event.get("state_key") == ""), {})
    level = powers.get("users", {}).get(issuer, powers.get("users_default", 0))
    if membership.get("membership") != "join" or not isinstance(level, int) or level < powers.get("invite", 0):
        raise APIError(403, "The invitation issuer no longer has permission to invite people.", "INVITATION_UNAVAILABLE")


async def invitations(request):
    service = request.app["service"]
    session = service.require_session(request)
    if request.method == "GET":
        room_id = request.query.get("roomId")
        if room_id:
            await issuer_authority(service, room_id, session["user_id"], service.store.open(session["token"]))
            rows = service.store.db.execute("SELECT * FROM invitations WHERE room_id=? ORDER BY created DESC LIMIT 100", (room_id,)).fetchall()
        else:
            rows = service.store.db.execute("SELECT * FROM invitations WHERE creator=? ORDER BY created DESC LIMIT 100", (session["user_id"],)).fetchall()
        return web.json_response({"invitations": [invite_view(row) for row in rows]})
    data = await body_json(request)
    service.store.rate("invite-create:" + session["user_id"], 20, 3600)
    room_id = text_value(data.get("roomId"), 255)
    if not room_id.startswith("!") or ":" not in room_id:
        raise APIError(400, "Select a valid Matrix room.")
    hours, uses = data.get("expiresInHours", 24), data.get("maxUses", 1)
    if type(hours) is not int or not 1 <= hours <= 720 or type(uses) is not int or not 1 <= uses <= 1000:
        raise APIError(400, "Choose an expiry between 1 and 720 hours, and 1 to 1000 uses.")
    email = email_address(data["email"]) if data.get("email") else None
    domain = text_value(data.get("domain", ""), 253).strip().casefold() or None
    if domain and (not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", domain) or "." not in domain or ".." in domain):
        raise APIError(400, "Enter a valid email domain.")
    default_roles = role_ids(data.get("defaultRoleIds", []))
    send_email = data.get("sendEmail") is True
    if send_email and (not email or not service.smtp()["enabled"]):
        raise APIError(400, "Configure email delivery and enter a recipient email before sending an invitation.")
    if send_email: service.store.rate("invite-email:" + session["user_id"], 10, 3600)
    token = service.store.open(session["token"])
    await issuer_authority(service, room_id, session["user_id"], token)
    await checked_roles(service, room_id, session["user_id"], default_roles)
    status, name = await service.matrix("GET", "/_matrix/client/v3/rooms/" + quote(room_id, safe="") + "/state/m.room.name/", token=token, expected=False)
    splash = await snapshot_invitation_splash(service, room_id, token)
    await issuer_authority(service, room_id, session['user_id'], token)
    now, secret, identity = time.time(), secrets.token_urlsafe(32), secrets.token_urlsafe(18)
    room_name = name.get("name", room_id) if status == 200 else room_id
    # Matrix room names are user-controlled, while SMTP subjects must be one
    # line. Normalize before saving so header construction cannot lose the
    # once-only invitation URL after the database insert succeeds.
    if not isinstance(room_name, str):
        room_name = room_id
    room_name = re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", room_name).strip()[:255] or room_id
    service.require_session(request)
    service.store.db.execute("INSERT INTO invitations(id,token_hash,room_id,room_name,creator,created,expires,max_uses,email,domain,default_roles,splash_mxc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                             (identity, service.store.digest("invite:" + secret), room_id, room_name[:255], session["user_id"], now, now + hours * 3600, uses, email, domain, json.dumps(default_roles), splash))
    service.audit(session["user_id"], "invitation_created", room_id, identity)
    value = invite_view(service.store.db.execute("SELECT * FROM invitations WHERE id=?", (identity,)).fetchone())
    value.update(token=secret, url=service.config.public_url + "/?invite=" + secret)
    if send_email:
        try:
            await service.send_email(email, "You’re invited to " + room_name[:100], "You have been invited to " + room_name[:255] + ".\n\nOpen this invitation to sign in or create an eligible account:\n" + value['url'] + "\n\nThis link expires in " + str(hours) + " hours. Ignore it if you were not expecting an invitation.")
            value['emailSent'] = True
            service.audit(session['user_id'], 'invitation_emailed', room_id, identity)
        except APIError:
            value['emailSent'] = False
            value['warning'] = 'Invitation created, but email delivery failed. Copy the link below or revoke it before creating a replacement.'
    return web.json_response(value, status=201)


async def revoke_invitation(request):
    service = request.app["service"]
    session = service.require_session(request)
    row = service.store.db.execute("SELECT * FROM invitations WHERE id=?", (request.match_info["identity"],)).fetchone()
    if not row:
        raise APIError(404, "This invitation is unavailable.")
    if row["creator"] != session["user_id"]:
        await issuer_authority(service, row["room_id"], session["user_id"], service.store.open(session["token"]))
    service.store.db.execute("UPDATE invitations SET revoked=1 WHERE id=?", (row["id"],))
    service.audit(session["user_id"], "invitation_revoked", row["room_id"], row["id"])
    return web.json_response({"ok": True})


async def preview_invitation(request):
    service = request.app["service"]
    service.store.rate("invite-preview:" + service.ip(request), 30, 60)
    value = active_invitation(service, request.match_info["token"])
    session = service.authenticate(request)
    resume = bool(session and service.store.db.execute("SELECT 1 FROM invitation_redemptions WHERE invitation_id=? AND user_id=?", (value['id'], session['user_id'])).fetchone())
    if value["uses"] >= value["max_uses"] and not resume:
        raise APIError(404, "This invitation has no uses remaining.", "INVITATION_UNAVAILABLE")
    splash = invitation_splash(value['splash_mxc'])
    if value['email'] or value['domain']:
        splash = ''
        if session:
            try:
                service.require_session(request)
                account = service.store.account(session['user_id'])
                invitation_email(value, account.get('email'), account.get('verified'))
                splash = invitation_splash(value['splash_mxc'])
            except APIError:
                pass
    return web.json_response({"roomId": value["room_id"], "roomName": value["room_name"], "expiresAt": int(value["expires"] * 1000), "requiresEmail": bool(value["email"] or value["domain"]), 'splashMxc': splash})


async def redeem(request, secret):
    service = request.app['service']
    session = service.require_session(request)
    def authorize():
        # Registration has just issued request['session']; ordinary redemption
        # uses its existing session. Both must remain live through remote waits.
        service.require_session(request)
        if service.deactivations.unavailable(session['user_id']):
            raise APIError(403, 'This account is unavailable.', 'ACCOUNT_RESTRICTED')
    authorize()
    value = active_invitation(service, secret)
    account = service.store.account(session["user_id"])
    invitation_email(value, account.get("email"), account.get("verified"))
    await issuer_authority(service, value["room_id"], value["creator"])
    authorize()
    default_roles = json.loads(value['default_roles'])
    await checked_roles(service, value['room_id'], value['creator'], default_roles)
    authorize()
    db = service.store.db
    # Single SQLite transaction reserves capacity before any remote side effect.
    db.execute("BEGIN IMMEDIATE")
    try:
        existing = db.execute("SELECT state FROM invitation_redemptions WHERE invitation_id=? AND user_id=?", (value["id"], session["user_id"])).fetchone()
        if not existing:
            result = db.execute("UPDATE invitations SET uses=uses+1 WHERE id=? AND uses<max_uses AND revoked=0 AND expires>?", (value["id"], time.time()))
            if result.rowcount != 1:
                raise APIError(409, "This invitation has no uses remaining.", "INVITATION_UNAVAILABLE")
            db.execute("INSERT INTO invitation_redemptions VALUES(?,?,'reserved',?)", (value["id"], session["user_id"], time.time()))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    if existing and existing["state"] == "joined":
        return value["room_id"]
    # Do not release uncertain reservations after network failures. The same
    # recipient can resume, but an invitation can never exceed its configured use.
    if not existing or existing["state"] == "reserved":
        temporary = await service.matrix("POST", "/_synapse/admin/v1/users/" + quote(value["creator"], safe="") + "/login", {"valid_until_ms": int(time.time() * 1000) + 60000}, await service.service_token())
        try:
            authorize()
            await service.matrix("POST", "/_matrix/client/v3/rooms/" + quote(value["room_id"], safe="") + "/invite", {"user_id": session["user_id"]}, temporary["access_token"])
            authorize()
            db.execute("UPDATE invitation_redemptions SET state='invited' WHERE invitation_id=? AND user_id=?", (value["id"], session["user_id"]))
        finally:
            try:
                await service.matrix("POST", "/_matrix/client/v3/logout", {}, temporary["access_token"], expected=False)
            except Exception:
                # The impersonation token has a hard 60-second upstream expiry.
                service.audit("system", "temporary_invite_token_logout_failed", value["room_id"])
    authorize()
    await service.matrix("POST", "/_matrix/client/v3/join/" + quote(value["room_id"], safe=""), {}, service.store.open(session["token"]))
    authorize()
    if default_roles:
        try:
            await apply_roles(service, value, session, default_roles, authorize=authorize)
        except APIError as error:
            authorize()
            raise APIError(409, 'You joined the server, but its default roles could not be assigned. Retry this invitation or ask the server owner. ' + error.message, 'INVITATION_ROLES_PENDING') from None
    authorize()
    db.execute("UPDATE invitation_redemptions SET state='joined' WHERE invitation_id=? AND user_id=?", (value["id"], session["user_id"]))
    service.audit(session["user_id"], "invitation_redeemed", value["room_id"], value["id"])
    return value["room_id"]


async def redeem_invitation(request):
    service = request.app["service"]
    data = await body_json(request)
    session = service.require_session(request)
    service.store.rate("invite-redeem:" + session["user_id"], 20, 300)
    room_id = await redeem(request, data.get("token"))
    return web.json_response({"roomId": room_id})


async def reports(request):
    service = request.app["service"]
    session = service.require_session(request)
    if request.method == "GET":
        rows = service.store.db.execute("SELECT * FROM reports WHERE reporter=? ORDER BY id DESC LIMIT 100", (session["user_id"],)).fetchall()
        values = []
        for row in rows:
            value = report_view(row, own=True)
            if row['audience'] == 'room':
                review = service.store.db.execute('SELECT status,updated FROM room_report_reviews WHERE report_id=?', (row['id'],)).fetchone()
                if review: value['roomReview'] = {'status': review['status'], 'updatedAt': int(review['updated'] * 1000)}
            values.append(value)
        return web.json_response({"reports": values})
    service.store.rate("report:" + session["user_id"], 5, 3600)
    data = await body_json(request)
    kind = data.get("kind")
    if not isinstance(kind, str) or kind not in {"message", "file", "server", "user"}:
        raise APIError(400, "Choose a valid report type.")
    audience = data.get('audience', 'platform')
    if audience not in ('platform', 'room'):
        raise APIError(400, 'Choose who may read this report.')
    reason = text_value(data.get("reason"), 2000).strip()
    evidence = text_value(data.get("evidence", ""), 4000)
    if not reason:
        raise APIError(400, "Explain what needs review.")
    room = text_value(data.get("roomId", ""), 255)
    event = text_value(data.get("eventId", ""), 255)
    target = text_value(data.get("targetId", ""), 255)
    token = service.store.open(session["token"])
    if audience == 'room':
        room, event, target = await verified_context(service, session, kind, room, event, target)
    elif kind in {"message", "file", "server"}:
        if not room.startswith("!"):
            raise APIError(400, "Select the room containing the reported content.")
        membership = await service.matrix("GET", "/_matrix/client/v3/rooms/" + quote(room, safe="") + "/state/m.room.member/" + quote(session["user_id"], safe=""), token=token)
        if membership.get("membership") != "join":
            raise APIError(403, "You must belong to the reported room.")
        if kind in {"message", "file"}:
            if not event.startswith("$"):
                raise APIError(400, "Select the message containing the reported content.")
            await service.matrix("GET", "/_matrix/client/v3/rooms/" + quote(room, safe="") + "/event/" + quote(event, safe=""), token=token)
    elif not target.startswith("@") or ":" not in target:
        raise APIError(400, "Select a valid Matrix account.")
    service.require_session(request)
    now = time.time()
    service.store.db.execute('BEGIN IMMEDIATE')
    try:
        cursor = service.store.db.execute("INSERT INTO reports(reporter,kind,room_id,event_id,target_id,reason,evidence,created,updated,audience,room_verified) VALUES(?,?,?,?,?,?,?,?,?,?,?)", (session["user_id"], kind, room, event, target, reason, evidence, now, now, audience, int(audience == 'room')))
        if audience == 'room': service.store.db.execute('INSERT INTO room_report_reviews(report_id,updated) VALUES(?,?)', (cursor.lastrowid, now))
        service.store.db.execute('COMMIT')
    except Exception:
        service.store.db.execute('ROLLBACK')
        raise
    service.audit(session["user_id"], "report_submitted", str(cursor.lastrowid), kind + ' audience:' + audience)
    return web.json_response({"id": cursor.lastrowid, "status": "open", "audience": audience}, status=201)


async def admin_reports(request):
    service = request.app["service"]
    session = await service.require_admin(request)
    statuses = {"open", "reviewing", "resolved", "dismissed"}
    if request.method == "GET":
        status = request.query.get("status", "open")
        if status not in statuses | {"all"}:
            raise APIError(400, "Choose a valid report status.")
        before = int(request.query.get("before", str(2 ** 63 - 1)))
        rows = service.store.db.execute("SELECT * FROM reports WHERE id<? AND (?='all' OR status=?) ORDER BY id DESC LIMIT 50", (before, status, status)).fetchall()
        return web.json_response({"reports": [report_view(row) for row in rows], "next": rows[-1]["id"] if len(rows) == 50 else None})
    data = await body_json(request)
    if data.get("status") not in statuses:
        raise APIError(400, "Choose a valid report status.")
    identity, note = int(request.match_info["identity"]), text_value(data.get("note", ""), 2000)
    cursor = service.store.db.execute("UPDATE reports SET status=?,note=?,reviewer=?,updated=? WHERE id=?", (data["status"], note, session["user_id"], time.time(), identity))
    if not cursor.rowcount:
        raise APIError(404, "This report is unavailable.")
    service.audit(session["user_id"], "report_reviewed", str(identity), data["status"])
    return web.json_response({"ok": True})


async def account_export(request):
    service = request.app["service"]
    session = service.require_session(request)
    service.store.rate("export:" + session["user_id"], 3, 3600)
    token, user_id = service.store.open(session["token"]), session["user_id"]
    keys = ["io.harbor.preferences", "io.harbor.bookmarks", "io.harbor.workspace", "io.tavern.profile", "io.tavern.community.preferences", "io.tavern.privacy", "io.tavern.appearance", "io.tavern.navigation", "io.tavern.server_folders", "io.tavern.notification_preferences", "io.tavern.thread_preferences", "io.tavern.text_media", "io.tavern.onboarding", "io.tavern.server_welcome", "io.tavern.presence"]
    settings = {}
    for key in keys:
        status, value = await service.matrix("GET", "/_matrix/client/v3/user/" + quote(user_id, safe="") + "/account_data/" + key, token=token, expected=False)
        if status == 200:
            settings[key] = value
        elif status != 404:
            raise APIError(502, "Your settings could not be exported. Try again.")
    profile, rooms = await asyncio.gather(service.matrix("GET", "/_matrix/client/v3/profile/" + quote(user_id, safe=""), token=token), service.matrix("GET", "/_matrix/client/v3/joined_rooms", token=token))
    account = service.store.account(user_id)
    metadata = {"userId": user_id, "email": account.get("email"), "emailVerified": bool(account.get("verified")), "displayName": account.get("display_name"), "timezone": account.get("timezone"), "createdAt": account.get("created")}
    sessions = [dict(row) for row in service.store.db.execute("SELECT device_id,created,last_seen,name,ip FROM sessions WHERE user_id=?", (user_id,))]
    value = {"exportedAt": int(time.time() * 1000), "scope": "Your Tavern account, profile, saved settings, current room memberships and device metadata. Export encrypted message history and recovery keys separately from your browser.", "account": metadata, "profile": profile, "settings": settings, "roomMemberships": rooms.get("joined_rooms", []), "sessions": sessions}
    if service.store.get("service_account"):
        status, media = await service.matrix("GET", "/_synapse/admin/v1/users/" + quote(user_id, safe="") + "/media?limit=100", token=await service.service_token(), expected=False)
        if status == 200:
            value["uploads"] = media.get("media", [])
            value["uploadsScope"] = {"limit": 100, "total": media.get("total"), "nextToken": media.get("next_token")}
    try:
        from .moderation import view as warning_view
    except ImportError:
        from moderation import view as warning_view
    warnings = service.store.db.execute('SELECT * FROM moderation_warnings WHERE target=? ORDER BY id DESC LIMIT 1000', (user_id,)).fetchall()
    value['warnings'] = [warning_view(service, row, True) for row in warnings]
    value['warningsScope'] = 'Your most recent 1000 private user-visible moderation records. Older records remain available through the moderation inbox.'
    service.audit(user_id, "account_exported", user_id)
    return web.json_response(value, headers={"Content-Disposition": 'attachment; filename="tavern-account.json"'})


async def registration_start(request):
    service = request.app["service"]
    service.store.rate("registration:" + service.ip(request), 5, 900)
    policy = service.store.get("policy", {"registrationMode": "admin"})
    if policy.get("registrationMode") not in {"invite", "open"}:
        raise APIError(403, "Accounts are created by your Tavern administrator.", "REGISTRATION_DISABLED")
    data = await body_json(request)
    username = text_value(data.get("username"), 64)
    if not re.fullmatch(r"[a-z0-9][a-z0-9._=-]{0,63}", username) or username == "admin":
        raise APIError(400, "Choose a lowercase username other than admin.")
    email = email_address(data.get("email"))
    error = service.password_error(data.get("password"), data.get("confirmation"))
    if error:
        raise APIError(400, error)
    if service.store.db.execute("SELECT 1 FROM accounts WHERE email=?", (email,)).fetchone():
        raise APIError(400, "This account could not be registered. Try signing in or recovering your password.")
    secret = text_value(data.get("inviteToken", ""), 80)
    if secret or policy.get("registrationMode") == "invite":
        invitation = active_invitation(service, secret)
        invitation_email(invitation, email, True)
        if invitation["uses"] >= invitation["max_uses"]:
            raise APIError(400, "This invitation has no uses remaining.")
    code = str(secrets.randbelow(1000000)).zfill(6)
    identity = service.store.challenge("registration", {"username": username, "password": data["password"], "email": email, "displayName": text_value(data.get("displayName", username), 200), "inviteToken": secret}, code=code, duration=900)
    try:
        await service.send_email(email, "Create your Tavern account", f"Your account verification code is {code}. It expires in 15 minutes.")
    except APIError:
        service.store.consume(identity)
        raise
    return web.json_response({"challengeId": identity})


async def registration_complete(request):
    service = request.app["service"]
    service.store.rate("registration-complete:" + service.ip(request), 10, 900)
    data = await body_json(request)
    async with service.registration_lock:
        challenge = service.store.read_challenge(data.get("challengeId", ""), "registration")
        service.store.verify_code(challenge, data.get("code"))
        value = challenge["payload"]
        error = service.password_error(value['password'])
        if error:
            raise APIError(400, 'Password policy changed. Start registration again. ' + error)
        mode = service.store.get("policy", {"registrationMode": "admin"}).get("registrationMode")
        if mode not in {"open", "invite"} or (mode == "invite" and not value["inviteToken"]):
            raise APIError(403, "Registration policy changed. Ask your administrator for an account.")
        if service.store.db.execute("SELECT 1 FROM accounts WHERE email=?", (value["email"],)).fetchone():
            raise APIError(400, "This email already belongs to an account. Sign in or recover your password.")
        if value["inviteToken"]:
            invitation = active_invitation(service, value["inviteToken"])
            invitation_email(invitation, value["email"], True)
            if invitation["uses"] >= invitation["max_uses"]:
                raise APIError(400, "This invitation has no uses remaining.")
            await issuer_authority(service, invitation["room_id"], invitation["creator"])
        service.store.consume(challenge["id"])
        login = await service.register(value["username"], value["password"], admin=False, display_name=value["displayName"])
        service.store.db.execute("INSERT INTO accounts(user_id,email,verified,display_name,created) VALUES(?,?,1,?,?)", (login["user_id"], value["email"], value["displayName"], time.time()))
        service.audit(login["user_id"], "account_registered", login["user_id"])
    response = await service.issue_session(request, login)
    if value["inviteToken"]:
        result = json.loads(response.body)
        if result.get('mfaEnrollmentRequired'):
            result['invitationError'] = 'Complete account security setup, then accept this invitation.'
        else:
            try:
                result["invitationRoomId"] = await redeem(request, value["inviteToken"])
            except APIError as error:
                result["invitationError"] = error.message
        response.body = json.dumps(result).encode()
    return response


def register_routes(app):
    service = app["service"]
    schema(service.store)
    service.registration_lock = asyncio.Lock()
    app.add_routes([web.get("/api/invitations", invitations), web.post("/api/invitations", invitations), web.delete("/api/invitations/{identity}", revoke_invitation),
                    web.get("/api/invitations/preview/{token}", preview_invitation), web.post("/api/invitations/redeem", redeem_invitation),
                    web.get("/api/reports", reports), web.post("/api/reports", reports), web.get("/api/admin/reports", admin_reports), web.put("/api/admin/reports/{identity}", admin_reports),
                    web.get("/api/account/export", account_export), web.post("/api/auth/register/start", registration_start), web.post("/api/auth/register/complete", registration_complete)])
