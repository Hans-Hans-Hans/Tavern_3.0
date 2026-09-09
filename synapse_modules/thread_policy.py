"""Thread metadata authority and explicit relation restrictions for encrypted rooms."""
from collections.abc import Mapping
import time

try:
    from channel_policy import native_power, value
except ImportError:
    from synapse_modules.channel_policy import native_power, value

THREAD = 'io.tavern.thread'
ARCHIVE_INTERVALS = {0, 3600, 86400, 259200, 604800}


def valid_thread(data):
    if not isinstance(data, Mapping) or data.get('version') != 1:
        return False
    if not isinstance(data.get('title', ''), str) or len(data.get('title', '')) > 120:
        return False
    tags = data.get('tags', [])
    if not isinstance(tags, (list, tuple)) or len(tags) > 10 or any(not isinstance(tag, str) or not 1 <= len(tag.strip()) <= 32 for tag in tags):
        return False
    if any(type(data.get(field, False)) is not bool for field in ('closed', 'locked', 'archived', 'reopen')):
        return False
    interval = data.get('autoArchiveSeconds', 0)
    return type(interval) is int and interval in ARCHIVE_INTERVALS


def relation_root(event):
    relation = event.content.get('m.relates_to', {})
    return relation.get('event_id') if isinstance(relation, Mapping) and relation.get('rel_type') == 'm.thread' else None


class ThreadPolicy:
    def __init__(self, api, channel_policy):
        self.api, self.channels = api, channel_policy

    async def root(self, identity, room_id):
        if not isinstance(identity, str) or not identity.startswith('$') or len(identity) > 255:
            return None
        original = await self.api._store.get_event(identity, allow_none=True)
        if not original or original.room_id != room_id or original.type not in ('m.room.message', 'm.room.encrypted') or relation_root(original):
            return None
        return original

    async def activity(self, room_id, identity, now, interval=0, reset=False, record=False, event_id=''):
        def update(transaction):
            transaction.execute('CREATE TABLE IF NOT EXISTS tavern_thread_activity(room_id TEXT NOT NULL,root_id TEXT NOT NULL,last_activity_ms BIGINT NOT NULL,last_event TEXT NOT NULL,PRIMARY KEY(room_id,root_id))')
            row = None
            if reset:
                transaction.execute('INSERT INTO tavern_thread_activity VALUES(?,?,?,?) ON CONFLICT(room_id,root_id) DO UPDATE SET last_activity_ms=excluded.last_activity_ms,last_event=excluded.last_event', (room_id, identity, now, event_id))
                return now
            transaction.execute('SELECT last_activity_ms,last_event FROM tavern_thread_activity WHERE room_id=? AND root_id=?', (room_id, identity))
            row = transaction.fetchone()
            if not row:
                # Configuration predating this module has no trustworthy activity
                # ledger. Explicit owner/moderator reopen establishes one.
                return None
            previous, last_event = row
            if interval and previous + interval * 1000 <= now and last_event != event_id:
                return None
            if record:
                transaction.execute('UPDATE tavern_thread_activity SET last_activity_ms=?,last_event=? WHERE room_id=? AND root_id=? AND (last_activity_ms+?>? OR last_event=?)', (now, event_id, room_id, identity, interval * 1000, now, event_id))
                if transaction.rowcount != 1:
                    return None
                return now
            return previous
        return await self.api._store.db_pool.runInteraction('tavern_thread_activity', update)

    async def check(self, event, state, policies):
        key, actor = getattr(event, 'state_key', None), event.sender
        if event.type == THREAD:
            if not valid_thread(event.content) or value(state, 'm.room.member', actor).get('membership') != 'join':
                return False
            original = await self.root(key, event.room_id)
            if not original:
                return False
            power = value(state, 'm.room.power_levels')
            if native_power(state, actor) < power.get('events', {}).get(THREAD, power.get('state_default', 50)):
                return False
            moderator = self.channels.moderator(state, policies, actor, event.room_id)
            previous = value(state, THREAD, key)
            if original.sender != actor and not moderator:
                return False
            if (previous.get('locked') or bool(previous.get('locked')) != event.content.get('locked', False)) and not moderator:
                return False
            return True
        if event.type == 'm.room.redaction':
            target = getattr(event, 'redacts', None) or event.content.get('redacts')
            original = await self.api._store.get_event(target, allow_none=True) if target else None
            if original and original.type == THREAD:
                return False
        identity = relation_root(event)
        if not identity:
            return True
        original = await self.root(identity, event.room_id)
        if not original:
            return False
        config = value(state, THREAD, identity)
        if not config:
            return True
        if not valid_thread(config) or any(config.get(field) for field in ('closed', 'locked', 'archived')):
            return False
        interval = config.get('autoArchiveSeconds', 0)
        return not interval or await self.activity(event.room_id, identity, int(time.time() * 1000), interval) is not None

    async def finish(self, event, state):
        now = int(time.time() * 1000)
        if event.type == THREAD:
            identity = event.state_key
            previous, config = value(state, THREAD, identity), event.content
            reset = not previous or bool(config.get('reopen')) or (not previous.get('autoArchiveSeconds') and bool(config.get('autoArchiveSeconds'))) or any(previous.get(field) and not config.get(field) for field in ('closed', 'archived', 'locked'))
            activity = await self.activity(event.room_id, identity, now, reset=reset)
            replacement = event.get_dict()
            replacement['content'] = {**dict(config), 'updatedAt': now, 'activityStartedAt': activity or 0, 'reopen': False}
            return True, replacement
        identity = relation_root(event)
        config = value(state, THREAD, identity) if identity else {}
        if config and config.get('autoArchiveSeconds') and event.type in ('m.room.message', 'm.room.encrypted'):
            activity = await self.activity(event.room_id, identity, now, config['autoArchiveSeconds'], record=True, event_id=event.event_id)
            return activity is not None, None
        return True, None
