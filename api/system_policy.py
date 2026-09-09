"""Operator-controlled maintenance and public announcements, with live updates."""
import asyncio
import json
import secrets
import time

from aiohttp import web

try:
    from .server import APIError, body_json, text_value
except ImportError:
    from server import APIError, body_json, text_value


def normalize_policy(value, now=None):
    now = int(time.time() * 1000) if now is None else now
    if not isinstance(value, dict) or value.get("registrationMode", "admin") not in {"admin", "invite", "open", "disabled"}:
        raise APIError(400, "Choose a valid registration mode.")
    maintenance = value.get("maintenance", {})
    if not isinstance(maintenance, dict) or type(maintenance.get("enabled", False)) is not bool:
        raise APIError(400, "Choose whether maintenance mode is enabled.")
    result = {"registrationMode": value.get("registrationMode", "admin"), "maintenance": {"enabled": maintenance.get("enabled", False), "message": text_value(maintenance.get("message", ""), 1000)}, "announcements": []}
    announcements = value.get("announcements", [])
    if not isinstance(announcements, list) or len(announcements) > 20:
        raise APIError(400, "Keep at most 20 announcements.")
    identities = set()
    for entry in announcements:
        if not isinstance(entry, dict):
            raise APIError(400, "Enter valid announcement details.")
        identity = text_value(entry.get("id") or secrets.token_urlsafe(12), 80)
        title = text_value(entry.get("title", ""), 120).strip()
        message = text_value(entry.get("message", ""), 2000).strip()
        if not title or not message or identity in identities:
            raise APIError(400, "Every announcement needs a unique ID, title and message.")
        severity = entry.get("severity", "information")
        if severity not in {"information", "warning", "maintenance", "critical"}:
            raise APIError(400, "Choose a valid announcement severity.")
        start, end = entry.get("startAt", 0), entry.get("endAt", 0)
        if type(start) is not int or type(end) is not int or min(start, end) < 0 or start > now + 366 * 86400000 or (end and end <= start):
            raise APIError(400, "Choose a valid announcement start and end time.")
        if type(entry.get("dismissible", True)) is not bool:
            raise APIError(400, "Choose whether the announcement can be dismissed.")
        identities.add(identity)
        result["announcements"].append({"id": identity, "title": title, "message": message, "severity": severity, "startAt": start, "endAt": end, "dismissible": entry.get("dismissible", True)})
    return result


def public_status(service, now=None):
    value = service.store.get("policy", {})
    now = int(time.time() * 1000) if now is None else now
    return {"maintenance": value.get("maintenance", {"enabled": False, "message": ""}), "announcements": [entry for entry in value.get("announcements", []) if entry["startAt"] <= now and (not entry["endAt"] or entry["endAt"] > now)]}


async def status(request):
    return web.json_response(public_status(request.app["service"]))


async def policy(request):
    service = request.app["service"]
    session = await service.require_admin(request)
    if request.method == "PUT":
        data = normalize_policy(await body_json(request))
        service.store.set("policy", data)
        service.audit(session["user_id"], "instance_policy_changed", "instance")
        for queue in request.app["system_watchers"]:
            if not queue.full():
                queue.put_nowait(True)
    return web.json_response(normalize_policy(service.store.get("policy", {})))


async def events(request):
    service, watchers = request.app["service"], request.app["system_watchers"]
    service.store.rate("system-events:" + service.ip(request), 30, 60)
    if len(watchers) >= 1000:
        raise APIError(429, "Too many status connections are open. Retry shortly.")
    queue = asyncio.Queue(maxsize=1)
    watchers.add(queue)
    response = web.StreamResponse(headers={"Content-Type": "text/event-stream", "X-Accel-Buffering": "no"})
    previous = ""
    try:
        await response.prepare(request)
        while True:
            current = json.dumps(public_status(service), sort_keys=True)
            if current != previous:
                await response.write(b"data: changed\n\n")
                previous = current
            try:
                await asyncio.wait_for(queue.get(), timeout=20)
            except asyncio.TimeoutError:
                await response.write(b": heartbeat\n\n")
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    finally:
        watchers.discard(queue)
    return response


def register_routes(app):
    app["system_watchers"] = set()
    app.add_routes([web.get("/api/system/status", status), web.get("/api/system/events", events), web.get("/api/admin/policy", policy), web.put("/api/admin/policy", policy)])
