"""Restrict all new invitations; an optional is_direct client flag is not authority."""
from collections.abc import Mapping
import hashlib
import hmac
from pathlib import Path
import re
import time

PRIVACY = 'io.tavern.privacy'
CHECK_TIMEOUT = 15
# Preserve legacy room IDs and accept the canonical unpadded URL-safe SHA-256
# create-event hash used by v12. The last sextet has two zero padding bits.
# Shared Space membership is still read from native state in shared_servers.
SERVER_ID = re.compile(r'(?:![^\s/\\?#\x00-\x1f\x7f]{1,254}:[^\s/\\?#\x00-\x1f\x7f]{1,254}|![A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])')


class InvitationPolicy:
    @staticmethod
    def server_rules(value):
        if not isinstance(value, Mapping) or len(value) > 200:
            return None
        if any(not isinstance(key, str) or not SERVER_ID.fullmatch(key)
               or mode not in ('contacts', 'nobody') for key, mode in value.items()):
            return None
        return dict(value)

    def __init__(self, config, api):
        self.api = api
        self.url = config.get('privacy_api_url', '')
        self.key_file = Path(config.get('privacy_key_file', '/data/tavern-privacy.key'))

    async def bounded(self, operation, timeout):
        # Synapse 1.160 exposes this reactor. Missing runtime support denies
        # rather than silently running an unbounded authorization callback.
        reactor = self.api.http_client.reactor
        from twisted.internet.defer import ensureDeferred
        return await ensureDeferred(operation()).addTimeout(timeout, reactor)

    async def contacts(self, sender, recipient):
        try:
            key = bytes.fromhex(self.key_file.read_text().strip())
            if len(key) != 32 or not self.url:
                return False
            timestamp = str(int(time.time()))
            payload = '\n'.join(('v1', 'invitation-consent', timestamp, sender, recipient))
            signature = hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()
            client = self.api.http_client
            result = await self.bounded(lambda: client.get_json(self.url + '/api/internal/invitation-consent', args={'sender': sender, 'recipient': recipient}, headers={b'X-Tavern-Privacy-Timestamp': [timestamp.encode()], b'X-Tavern-Privacy-Signature': [signature.encode()]}), 5)
            return isinstance(result, Mapping) and result.get('allowed') is True
        except Exception:
            return False  # Contact consent cannot become allow-on-network-failure.

    async def shared_servers(self, sender, recipient, selected=None):
        # Pinned Synapse datastore API: reads actual joined rooms, never a
        # client-supplied m.direct flag or claimed parent link.
        sender_rooms = await self.api._store.get_rooms_for_user(sender)
        recipient_rooms = await self.api._store.get_rooms_for_user(recipient)
        if len(sender_rooms) > 4096 or len(recipient_rooms) > 4096:
            raise ValueError('Invitation membership scope is too large')
        shared = set(sender_rooms) & set(recipient_rooms)
        if selected is not None:
            shared.intersection_update(selected)
        if len(shared) > 256:
            raise ValueError('Invitation shared scope is too large')
        found = set()
        for room_id in sorted(shared):
            state = await self.api.get_room_state(room_id, [('m.room.create', ''), ('m.room.member', sender), ('m.room.member', recipient)])
            creation, a, b = state.get(('m.room.create', '')), state.get(('m.room.member', sender)), state.get(('m.room.member', recipient))
            if creation and creation.content.get('type') == 'm.space' and a and a.content.get('membership') == 'join' and b and b.content.get('membership') == 'join':
                found.add(room_id)
        return found

    async def shared_server(self, sender, recipient):
        return bool(await self.shared_servers(sender, recipient))

    async def snapshot(self, sender, recipient):
        ignored = await self.api.account_data_manager.get_global(recipient, 'm.ignored_user_list')
        ignored = {} if ignored is None else ignored
        if not isinstance(ignored, Mapping) or not isinstance(ignored.get('ignored_users', {}), Mapping) or sender in ignored.get('ignored_users', {}):
            return None
        privacy = await self.api.account_data_manager.get_global(recipient, PRIVACY)
        privacy = {} if privacy is None else privacy
        if not isinstance(privacy, Mapping):
            return None
        mode, rules = privacy.get('invitations', 'everyone'), self.server_rules(privacy.get('serverInvitations', {}))
        if mode not in ('everyone', 'contacts', 'shared_server', 'nobody') or rules is None:
            return None
        return mode, rules

    async def check(self, event):
        if event.type != 'm.room.member' or event.content.get('membership') != 'invite':
            return True
        recipient, sender = getattr(event, 'state_key', ''), event.sender
        if not self.api.is_mine(recipient):
            return True
        try:
            return await self.bounded(lambda: self.check_current(sender, recipient), CHECK_TIMEOUT)
        except Exception:
            return False

    async def check_current(self, sender, recipient):
        before = await self.snapshot(sender, recipient)
        if before is None: return False
        mode, rules = before
        if mode == 'nobody': return False
        selected = None if mode == 'shared_server' else rules
        shared = await self.shared_servers(sender, recipient, selected) if rules or mode == 'shared_server' else set()
        if mode == 'shared_server' and not shared: return False
        applicable = {rules[server] for server in shared if server in rules}
        if 'nobody' in applicable: return False
        needs_contacts = mode == 'contacts' or 'contacts' in applicable
        if needs_contacts and not await self.contacts(sender, recipient): return False
        # Two finite observations detect drift during the earlier awaits. Read
        # memberships after the final privacy snapshot so a newly shared,
        # restricted Space cannot hide behind an old membership set.
        if await self.snapshot(sender, recipient) != before: return False
        if rules or mode == 'shared_server':
            if await self.shared_servers(sender, recipient, selected) != shared: return False
        if needs_contacts and not await self.contacts(sender, recipient): return False
        # Native account data, membership and API contact consent have no shared
        # transaction. These bounded reads do not claim atomicity with each other
        # or with later event persistence; rechecking indefinitely cannot add it.
        return True
