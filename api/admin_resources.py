"""Room administration and byte quotas without inspecting encrypted media."""
import asyncio
import errno
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
import time
from urllib.parse import quote, urlsplit

from aiohttp import web, ClientTimeout

try:
    from .server import APIError, body_json, text_value
    from .room_authority import room_id as native_room_id
except ImportError:
    from server import APIError, body_json, text_value
    from room_authority import room_id as native_room_id

DEFAULT_LIMITS = {"maxUploadBytes": 10 * 1024 * 1024, "userQuotaBytes": 1024 ** 3, "globalQuotaBytes": 10 * 1024 ** 3}
MAX_UPLOAD_BYTES = 512 * 1024 * 1024
MEDIA_PAGE_SIZE = 50
MEDIA_INVENTORY_LIMIT = 100


def room_identity(request):
    value = request.match_info["room_id"]
    if len(value) > 255:
        raise APIError(400, "Choose a valid room ID.")
    return native_room_id(value)


async def current_admin(service, request, original):
    current = await service.require_admin(request)
    service.require_session(request)
    if current['id'] != original['id']:
        raise APIError(401, 'Your administrator session changed. Reopen room administration.')
    return current


async def rooms(request):
    service = request.app["service"]
    session = await service.require_admin(request)
    start = max(0, int(request.query.get("from", "0")))
    search = text_value(request.query.get("search", ""), 200)
    value = await service.matrix("GET", "/_synapse/admin/v1/rooms?limit=50&from=" + str(start) + "&search_term=" + quote(search, safe=""), token=service.store.open(session["token"]))
    await current_admin(service, request, session)
    return web.json_response(value)


async def room_detail(request):
    service = request.app["service"]
    session = await service.require_admin(request)
    identity = room_identity(request)
    path, token = "/_synapse/admin/v1/rooms/" + quote(identity, safe=""), service.store.open(session["token"])
    detail, membership, blocked = await asyncio.gather(service.matrix("GET", path, token=token), service.matrix("GET", path + "/members", token=token), service.matrix("GET", path + "/block", token=token))
    await current_admin(service, request, session)
    offset = max(0, int(request.query.get("memberFrom", "0")))
    # Synapse's member endpoint itself is unpaginated; keep browser results bounded.
    members = membership.get("members", [])
    return web.json_response({"room": detail, "members": {"members": members[offset:offset + 100], "total": membership.get("total", len(members)), "next": offset + 100 if len(members) > offset + 100 else None}, "blocked": blocked.get("block", False)})


async def room_block(request):
    service = request.app["service"]
    session = await service.require_admin(request)
    identity, data = room_identity(request), await body_json(request)
    if type(data.get("block")) is not bool or data.get("confirmation") != identity:
        raise APIError(400, "Type the full room ID and choose whether to block new joins.")
    await current_admin(service, request, session)
    result = await service.matrix("PUT", "/_synapse/admin/v1/rooms/" + quote(identity, safe="") + "/block", {"block": data["block"]}, service.store.open(session["token"]))
    service.audit(session["user_id"], "room_blocked" if data["block"] else "room_unblocked", identity)
    return web.json_response(result)


def limits(service):
    return {**DEFAULT_LIMITS, **service.store.get("storage_limits", {})}


def validate_limits(value):
    if not isinstance(value, dict):
        raise APIError(400, "Enter valid storage limits.")
    result = {}
    for name, default in DEFAULT_LIMITS.items():
        number = value.get(name, default)
        maximum = MAX_UPLOAD_BYTES if name == "maxUploadBytes" else 1024 ** 5
        if type(number) is not int or not 1024 <= number <= maximum:
            raise APIError(400, "Use byte limits of at least 1024 bytes. Maximum file size can be increased up to 512 MiB.")
        result[name] = number
    if result["maxUploadBytes"] > result["userQuotaBytes"] or result["userQuotaBytes"] > result["globalQuotaBytes"]:
        raise APIError(400, "File size must fit the user quota, which must fit the global quota.")
    return result


def admin_user(value):
    if not isinstance(value, str) or not value.startswith("@") or len(value) > 255 or any(ord(char) < 33 for char in value):
        raise APIError(400, "Choose a valid account.")
    return value


def media_identity(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._=-]{1,255}", value):
        raise APIError(400, "Choose a valid local media item.")
    return value


def directory_size(path: Path):
    """Return a bounded metadata-only directory measurement without following links."""
    total, files = 0, 0
    try:
        stat = path.lstat()
    except OSError:
        return total, files
    if not path.is_dir() or path.is_symlink():
        return max(0, stat.st_size), 1
    for directory, _, names in os.walk(path, followlinks=False, onerror=lambda _error: None):
        for name in names:
            try:
                child = Path(directory, name)
                if not child.is_symlink():
                    total += max(0, child.stat().st_size)
                    files += 1
            except OSError:
                pass
    return total, files


def mounted_storage(service):
    """Report only explicitly mounted Tavern paths; never accept a browser path."""
    roots = (("Tavern account data", service.config.data_dir), ("Synapse data", service.config.synapse_config.parent))
    reported, seen = [], set()
    for label, root in roots:
        try:
            resolved = root.resolve(strict=True)
        except OSError:
            continue
        if resolved in seen or not resolved.is_dir():
            continue
        seen.add(resolved)
        entries = []
        try:
            children = list(resolved.iterdir())
        except OSError:
            children = []
        for child in children:
            size, files = directory_size(child)
            entries.append({"name": child.name, "bytes": size, "files": files})
        entries.sort(key=lambda value: (-value["bytes"], value["name"]))
        total, files = directory_size(resolved)
        reported.append({"label": label, "bytes": total, "files": files, "entries": entries[:20]})
    return reported


def media_view(value):
    if not isinstance(value, dict):
        return None
    identity, size = value.get("media_id"), value.get("media_length")
    if not isinstance(identity, str) or not re.fullmatch(r"[A-Za-z0-9._=-]{1,255}", identity) or type(size) is not int or size < 0:
        return None
    result = {"id": identity, "bytes": size}
    for source, target in (("upload_name", "name"), ("media_type", "type"), ("created_ts", "createdAt")):
        item = value.get(source)
        if isinstance(item, str) and len(item) <= 512:
            result[target] = item
        elif source == "created_ts" and type(item) is int and item >= 0:
            result[target] = item
    return result


class UploadQuota:
    def __init__(self, service):
        self.service = service
        # Docker's /tmp is a small RAM filesystem. Uploads need bounded disk
        # buffering; TemporaryFile unlinks its contents and closes on all exits.
        self.buffer_directory = service.config.data_dir / 'upload-buffer'
        self.buffer_directory.mkdir(mode=0o700, exist_ok=True)
        self.slots = asyncio.Semaphore(2)
        self.initialization = asyncio.Lock()
        self.reconciliation = asyncio.Lock()
        service.store.db.executescript("""
            CREATE TABLE IF NOT EXISTS upload_usage(user_id TEXT PRIMARY KEY,bytes INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS upload_reservations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,bytes INTEGER NOT NULL,
                state TEXT NOT NULL,created REAL NOT NULL,media_uri TEXT);
            CREATE INDEX IF NOT EXISTS upload_reservation_user ON upload_reservations(user_id,created);
            CREATE INDEX IF NOT EXISTS upload_reservation_state ON upload_reservations(state);
        """)

    async def ensure_initialized(self):
        if self.service.store.get("upload_usage_initialized"):
            return
        async with self.initialization:
            if not self.service.store.get("upload_usage_initialized"):
                await self.import_usage()

    async def import_usage(self):
        service = self.service
        usage = await self.media_usage()
        db = service.store.db
        db.execute("BEGIN IMMEDIATE")
        try:
            db.execute("DELETE FROM upload_usage")
            db.executemany("INSERT INTO upload_usage VALUES(?,?)", list(usage.items()) + [("*", sum(usage.values()))])
            db.execute("DELETE FROM upload_reservations")
            service.store.set("upload_usage_initialized", True)
            service.store.set("upload_usage_reconciled", int(time.time() * 1000))
            db.execute("COMMIT")
        except Exception:
            db.execute("ROLLBACK")
            raise

    async def media_usage(self):
        service = self.service
        usage, offset, seen = {}, "0", set()
        token = await service.service_token()
        while True:
            if offset in seen or len(seen) >= 1000:
                raise APIError(503, "Media usage pagination could not be completed. Uploads remain locked until usage can be checked.")
            seen.add(offset)
            value = await service.matrix("GET", "/_synapse/admin/v1/statistics/users/media?limit=100&from=" + quote(offset, safe=""), token=token)
            if not isinstance(value.get("users"), list):
                raise APIError(503, "Media usage could not be checked. Ask an administrator to retry storage reconciliation.")
            for row in value["users"]:
                if not isinstance(row.get("user_id"), str) or type(row.get("media_length")) is not int or row["media_length"] < 0:
                    raise APIError(503, "The homeserver returned invalid media usage.")
                usage[row["user_id"]] = row["media_length"]
            next_token = value.get("next_token")
            if next_token is None:
                break
            offset = str(next_token)
        return usage

    def reserve(self, user_id, size):
        service, db = self.service, self.service.store.db
        policy = limits(service)
        identity = secrets.token_urlsafe(18)
        db.execute("BEGIN IMMEDIATE")
        try:
            db.execute("INSERT OR IGNORE INTO upload_usage VALUES(?,0)", (user_id,))
            own = db.execute("SELECT bytes FROM upload_usage WHERE user_id=?", (user_id,)).fetchone()[0]
            global_used = db.execute("SELECT bytes FROM upload_usage WHERE user_id='*'").fetchone()[0]
            if size > policy["maxUploadBytes"]:
                raise APIError(413, "This file exceeds the upload size limit.", "M_TOO_LARGE")
            user_quota = service.store.account(user_id).get('upload_quota_bytes') or policy['userQuotaBytes']
            if own + size > user_quota or global_used + size > policy["globalQuotaBytes"]:
                raise APIError(413, "The account or instance storage quota is full. Contact your administrator.", "STORAGE_QUOTA_EXCEEDED")
            db.execute("UPDATE upload_usage SET bytes=bytes+? WHERE user_id IN (?, '*')", (size, user_id))
            db.execute("INSERT INTO upload_reservations VALUES(?,?,?,'reserved',?,NULL)", (identity, user_id, size, time.time()))
            db.execute("COMMIT")
            return identity
        except Exception:
            db.execute("ROLLBACK")
            raise

    def release(self, identity):
        db = self.service.store.db
        db.execute("BEGIN IMMEDIATE")
        try:
            row = db.execute("SELECT * FROM upload_reservations WHERE id=? AND state='reserved'", (identity,)).fetchone()
            if row:
                db.execute("UPDATE upload_usage SET bytes=MAX(0,bytes-?) WHERE user_id IN (?, '*')", (row["bytes"], row["user_id"]))
                db.execute("DELETE FROM upload_reservations WHERE id=?", (identity,))
            db.execute("COMMIT")
        except Exception:
            db.execute("ROLLBACK")
            raise

    async def upload(self, request, session, raw):
        service = self.service
        service.store.rate("uploads:" + session["user_id"], 60, 3600)
        maximum = min(limits(service)["maxUploadBytes"], MAX_UPLOAD_BYTES)
        if request.content_length is not None and request.content_length > maximum:
            raise APIError(413, "This file exceeds the upload size limit.", "M_TOO_LARGE")
        async with self.slots:
            await self.ensure_initialized()
            # Buffer to a private temporary file, not a whole-file Python bytes
            # object. No unbounded or oversized body is forwarded to Synapse.
            with tempfile.TemporaryFile(dir=self.buffer_directory) as stream:
                received = 0
                try:
                    async with asyncio.timeout(900):
                        async for chunk in request.content.iter_chunked(65536):
                            received += len(chunk)
                            if received > maximum:
                                raise APIError(413, "This file exceeds the upload size limit.", "M_TOO_LARGE")
                            await asyncio.to_thread(stream.write, chunk)
                except asyncio.TimeoutError:
                    raise APIError(408, "The upload timed out. Try again.") from None
                except OSError as error:
                    if error.errno in {errno.ENOSPC, errno.EDQUOT}:
                        raise APIError(507, "The server has no temporary upload space. Contact your administrator.", "STORAGE_FULL") from None
                    raise
                if not received:
                    raise APIError(400, "This file is empty.")
                service.require_session(request)
                identity = self.reserve(session["user_id"], received)
                stream.seek(0)
                headers = {"Authorization": "Bearer " + service.store.open(session["token"]), "Content-Type": request.headers.get("Content-Type", "application/octet-stream"), "Content-Length": str(received)}
                async def buffered_chunks():
                    while chunk := await asyncio.to_thread(stream.read, 65536):
                        yield chunk

                # A transport failure can occur after Synapse accepted the file.
                # Keep that reservation until reconciliation, never overbook it.
                async with service.http.post(service.config.synapse_url + raw, data=buffered_chunks(), headers=headers, allow_redirects=False, auto_decompress=True, timeout=ClientTimeout(total=900, sock_connect=10, sock_read=120)) as response:
                    payload = await response.content.read(32769)
                    if len(payload) > 32768:
                        raise APIError(502, "The upload response could not be read. Check storage status before retrying.")
                    try:
                        data = json.loads(payload)
                    except (ValueError, UnicodeDecodeError):
                        data = {}
                    if not isinstance(data, dict):
                        data = {}
                    if 200 <= response.status < 300 and isinstance(data.get("content_uri"), str):
                        service.require_session(request)
                        service.store.db.execute("UPDATE upload_reservations SET state='stored',media_uri=? WHERE id=?", (data["content_uri"], identity))
                        service.audit(session["user_id"], "media_uploaded", data["content_uri"], str(received) + " bytes")
                        return web.json_response(data, status=response.status)
                    if 400 <= response.status < 500:
                        self.release(identity)
                    raise APIError(response.status if 400 <= response.status < 500 else 502, "The file could not be uploaded. Try again or check your storage quota.", data.get("errcode", "UPLOAD_FAILED"))

    def view(self, user_id=None):
        service = self.service
        initialized = service.store.get("upload_usage_initialized", False)
        row = service.store.db.execute("SELECT bytes FROM upload_usage WHERE user_id='*'").fetchone()
        value = {**limits(service), "maxUploadAllowedBytes": MAX_UPLOAD_BYTES, "usageInitialized": initialized, "globalUsedBytes": row[0] if row else None, "reconciledAt": service.store.get("upload_usage_reconciled"), "scope": "Local original media bytes, including existing uploads at the last reconciliation. Thumbnails and backups are not included."}
        if user_id:
            value['userQuotaBytes'] = service.store.account(user_id).get('upload_quota_bytes') or value['userQuotaBytes']
            row = service.store.db.execute("SELECT bytes FROM upload_usage WHERE user_id=?", (user_id,)).fetchone()
            value["ownUsedBytes"] = row[0] if row else 0 if initialized else None
        else:
            value["uncertainReservations"] = service.store.db.execute("SELECT count(*) FROM upload_reservations WHERE state='reserved'").fetchone()[0]
        return value


async def storage(request):
    service = request.app["service"]
    session = await service.require_admin(request)
    updated = validate_limits(await body_json(request)) if request.method == 'PUT' else None
    await service.uploads.ensure_initialized()
    native_limit = None
    try:
        media = await service.matrix('GET', '/_matrix/media/v3/config', token=service.store.open(session['token']))
        if isinstance(media, dict) and type(media.get('m.upload.size')) is int and media['m.upload.size'] > 0:
            native_limit = media['m.upload.size']
    except APIError:
        pass
    await current_admin(service, request, session)
    if request.method == "PUT":
        service.store.set("storage_limits", updated)
        service.audit(session["user_id"], "storage_limits_changed", "instance")
    return web.json_response({**service.uploads.view(), 'homeserverMaxUploadBytes': native_limit})


async def own_storage(request):
    service = request.app["service"]
    session = service.require_session(request)
    await service.uploads.ensure_initialized()
    return web.json_response(service.uploads.view(session["user_id"]))


async def reconcile(request):
    service = request.app["service"]
    session = await service.require_admin(request)
    service.store.rate("storage-reconcile:" + session["user_id"], 3, 3600)
    # Serialize exclusive acquisitions: two reconcilers must never each hold
    # one slot while both wait forever for the other's slot.
    async with service.uploads.reconciliation:
        async with service.uploads.slots:
            async with service.uploads.slots:
                async with service.uploads.initialization:
                    await service.uploads.import_usage()
    service.audit(session["user_id"], "storage_reconciled", "instance")
    return web.json_response(service.uploads.view())


async def storage_inventory(request):
    service = request.app["service"]
    session = await service.require_admin(request)
    service.store.rate("storage-inventory:" + session["user_id"], 20, 3600)
    usage, disk = await asyncio.gather(service.uploads.media_usage(), asyncio.to_thread(mounted_storage, service))
    await current_admin(service, request, session)
    uploaders = [{"userId": user_id, "bytes": size} for user_id, size in usage.items() if size > 0]
    uploaders.sort(key=lambda value: (-value["bytes"], value["userId"]))
    return web.json_response({"measuredAt": int(time.time() * 1000), "mounted": disk, "uploaders": uploaders[:MEDIA_INVENTORY_LIMIT],
                              "totalUploadedBytes": sum(usage.values()), "scope": "Mounted Tavern and Synapse data are measured directly. Uploaders are measured from Synapse local original media. PostgreSQL, Docker images, container logs, remote media cache, and backups are outside this panel."}, headers={"Cache-Control": "no-store"})


async def user_media(request):
    service = request.app["service"]
    session = await service.require_admin(request)
    target = admin_user(request.match_info["user_id"])
    if set(request.query) - {"from"}:
        raise APIError(400, "Unknown media inventory filter.")
    try:
        offset = max(0, int(request.query.get("from", "0")))
    except ValueError:
        raise APIError(400, "Choose a valid media page.") from None
    if offset > 1000000:
        raise APIError(400, "Choose a valid media page.")
    status, result = await service.matrix("GET", "/_synapse/admin/v1/users/" + quote(target, safe="") + "/media?limit=" + str(MEDIA_PAGE_SIZE) + "&from=" + str(offset), token=await service.service_token(), expected=False)
    if status == 404:
        raise APIError(404, "This account has no local media inventory.", "MEDIA_NOT_FOUND")
    if status < 200 or status >= 300 or not isinstance(result.get("media"), list):
        raise APIError(502, "The homeserver could not provide this media inventory.", "MEDIA_INVENTORY_UNAVAILABLE")
    await current_admin(service, request, session)
    items = [item for item in (media_view(value) for value in result["media"]) if item is not None]
    inventory_id = service.store.challenge("storage-media", {"userId": target, "mediaIds": [item["id"] for item in items]}, user_id=session["user_id"], duration=600)
    return web.json_response({"userId": target, "inventoryId": inventory_id, "items": items, "total": result.get("total") if type(result.get("total")) is int else None,
                              "next": result.get("next_token") if isinstance(result.get("next_token"), (str, int)) else None}, headers={"Cache-Control": "no-store"})


async def delete_media(request):
    service = request.app["service"]
    session = await service.require_admin(request)
    service.store.rate("storage-delete:" + session["user_id"], 60, 3600)
    data = await body_json(request)
    target, identity = admin_user(data.get("userId")), media_identity(data.get("mediaId"))
    if data.get("confirmation") != "DELETE " + identity:
        raise APIError(400, "Type the requested deletion confirmation.")
    inventory = service.store.read_challenge(data.get("inventoryId", ""), "storage-media", session["user_id"])
    if inventory["payload"].get("userId") != target or identity not in inventory["payload"].get("mediaIds", []):
        raise APIError(400, "Reload this account's media inventory before deleting a file.")
    hostname = urlsplit(service.config.public_url).hostname
    if not hostname:
        raise APIError(503, "The local media host is unavailable.")
    await current_admin(service, request, session)
    await service.matrix("DELETE", "/_synapse/admin/v1/media/" + quote(hostname, safe="") + "/" + quote(identity, safe=""), token=await service.service_token())
    service.store.consume(inventory["id"])
    refreshed = True
    try:
        async with service.uploads.reconciliation:
            async with service.uploads.slots:
                async with service.uploads.slots:
                    async with service.uploads.initialization:
                        await service.uploads.import_usage()
    except APIError:
        refreshed = False
    service.audit(session["user_id"], "storage_media_deleted", identity, "uploader:" + target)
    return web.json_response({"deleted": True, "usageRefreshed": refreshed})


def register_routes(app):
    try:
        from .admin_hierarchy import register_routes as register_hierarchy
    except ImportError:
        from admin_hierarchy import register_routes as register_hierarchy
    register_hierarchy(app)
    service = app["service"]
    service.uploads = UploadQuota(service)
    app.add_routes([web.get("/api/admin/rooms", rooms), web.get("/api/admin/rooms/{room_id}", room_detail), web.put("/api/admin/rooms/{room_id}/block", room_block),
                    web.get("/api/admin/storage", storage), web.put("/api/admin/storage", storage), web.post("/api/admin/storage/reconcile", reconcile), web.get("/api/admin/storage/inventory", storage_inventory),
                    web.get("/api/admin/storage/users/{user_id}/media", user_media), web.delete("/api/admin/storage/media", delete_media), web.get("/api/account/storage", own_storage)])
