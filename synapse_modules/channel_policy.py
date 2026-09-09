"""Additional channel restrictions, evaluated alongside native Matrix auth.

Message ciphertext is never inspected. Rate reservations use the Synapse database
and server time so clients, concurrent requests and restarts cannot reset cooldowns.
"""
from collections.abc import Mapping
import logging
import time

try:
    from member_state import member_state_event, member_state_target, member_state_revision_matches
except ImportError:
    from synapse_modules.member_state import member_state_event, member_state_target, member_state_revision_matches

CHANNEL = "io.tavern.channel"
TIMEOUT = "io.tavern.timeout"
KINDS = frozenset({"text", "voice", "video", "forum", "announcement", "rules", "media", "read-only"})
POSTING = frozenset({"m.room.message", "m.room.encrypted", "m.reaction", "m.poll.start", "m.poll.response", "m.poll.end"})
CALL_JOINING = frozenset({"m.call.invite", "m.call.answer", "org.matrix.msc3401.call.member"})
LOG = logging.getLogger("tavern.channel_policy")


def value(state, kind, key=""):
    event = state.get((kind, key))
    return event.content if event else {}


def native_power(state, user):
    power = value(state, "m.room.power_levels")
    creator = state.get(("m.room.create", ""))
    creation = creator.content if creator else {}
    version = creation.get('room_version', getattr(getattr(creator, 'room_version', None), 'identifier', '1'))
    if version == '12' and (creator.sender == user or user in creation.get('additional_creators', ())):
        return float('inf')
    if not power:
        return 100 if creator and creator.sender == user else 0
    return power.get("users", {}).get(user, power.get("users_default", 0))


def valid_channel(content):
    if not isinstance(content, Mapping):
        return False
    seconds = content.get("slowModeSeconds", 0)
    return content.get("version", 1) == 1 and content.get("kind", "text") in KINDS and type(content.get("archived", False)) is bool and type(seconds) is int and 0 <= seconds <= 21600


def timeout_active(state, user, now):
    event = member_state_event(state, TIMEOUT, user)
    until = event.content.get("until") if event else 0
    # Malformed stored timeout state fails closed rather than lifting a restriction.
    return type(until) is not int or until > now


class ChannelPolicy:
    def __init__(self, api, role_permissions, role_rank):
        self.api = api
        self.permissions = role_permissions
        self.rank = role_rank
        self.table_ready = False

    def moderator(self, state, policies, actor, room_id):
        native = native_power(state, actor)
        threshold = value(state, "m.room.power_levels").get("redact", 50)
        if native < threshold:
            return False
        return all(actor == policy["owner"] or "manage_messages" in self.permissions(policy, actor, room_id) for _, policy, _ in policies)

    async def reserve_slow_mode(self, event, seconds, now):
        # Synapse exposes no public transactional module storage. This deliberately
        # small adapter targets the pinned monolith/worker database interface.
        def reserve(transaction):
            transaction.execute("CREATE TABLE IF NOT EXISTS tavern_channel_cooldowns(room_id TEXT NOT NULL,user_id TEXT NOT NULL,next_allowed_ms BIGINT NOT NULL,last_event TEXT NOT NULL,PRIMARY KEY(room_id,user_id))")
            transaction.execute("INSERT INTO tavern_channel_cooldowns(room_id,user_id,next_allowed_ms,last_event) VALUES(?,?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET next_allowed_ms=excluded.next_allowed_ms,last_event=excluded.last_event WHERE tavern_channel_cooldowns.next_allowed_ms<=? OR tavern_channel_cooldowns.last_event=?", (event.room_id, event.sender, now + seconds * 1000, event.event_id, now, event.event_id))
            return transaction.rowcount == 1
        return await self.api._store.db_pool.runInteraction("tavern_channel_slow_mode", reserve)

    async def check(self, event, state, policies):
        now = int(time.time() * 1000)
        actor, kind, key = event.sender, event.type, getattr(event, "state_key", None)
        if kind == CHANNEL:
            if key != "" or not valid_channel(event.content):
                return False
            # Native state authorization is always evaluated by Synapse too.
            required = value(state, "m.room.power_levels").get("events", {}).get(CHANNEL, value(state, "m.room.power_levels").get("state_default", 50))
            if native_power(state, actor) < required:
                return False
            return all(actor == policy["owner"] or "manage_channels" in self.permissions(policy, actor, event.room_id) for _, policy, _ in policies)
        if kind == TIMEOUT:
            try:
                target = member_state_target(key)
            except ValueError:
                return False
            if target == actor or not isinstance(event.content, Mapping) or not member_state_revision_matches(event.content, state, TIMEOUT, target):
                return False
            until, reason = event.content.get("until"), event.content.get("reason", "")
            if type(until) is not int or not (until == 0 or now < until <= now + 28 * 86400000) or not isinstance(reason, str) or len(reason) > 500:
                return False
            power = value(state, "m.room.power_levels")
            threshold = max(power.get("kick", 50), power.get("events", {}).get(TIMEOUT, power.get("state_default", 50)))
            if native_power(state, actor) < threshold or native_power(state, actor) <= native_power(state, target):
                return False
            if until and value(state, "m.room.member", target).get("membership") not in {"join", "invite"}:
                return False
            for _, policy, _ in policies:
                if actor != policy["owner"] and ("timeout" not in self.permissions(policy, actor, event.room_id) or self.rank(policy, target) >= self.rank(policy, actor)):
                    return False
            return True
        if kind == "m.room.redaction":
            target = getattr(event, "redacts", None) or event.content.get("redacts")
            original = await self.api._store.get_event(target, allow_none=True) if target else None
            if original and original.type in {CHANNEL, TIMEOUT}:
                return False  # Edit restrictions explicitly; redaction must not remove them.
        call = kind in CALL_JOINING
        if kind == "org.matrix.msc3401.call.member" and not event.content:
            call = False  # Allow leaving an existing call while timed out/archived.
        if kind == "org.matrix.msc3401.call.member" and event.content.get("memberships") == []:
            call = False
        if kind not in POSTING and not call:
            return True
        config = value(state, CHANNEL)
        if config and not valid_channel(config):
            return False
        if config.get("archived") or timeout_active(state, actor, now) or any(timeout_active(parent, actor, now) for _, _, parent in policies):
            return False
        moderator = self.moderator(state, policies, actor, event.room_id)
        if config.get("kind") in {"read-only", "rules", "announcement"} and kind in {"m.room.message", "m.room.encrypted", "m.poll.start"} and not moderator:
            return False
        seconds = config.get("slowModeSeconds", 0)
        if seconds and kind in {"m.room.message", "m.room.encrypted"} and not moderator:
            return await self.reserve_slow_mode(event, seconds, now)
        return True
