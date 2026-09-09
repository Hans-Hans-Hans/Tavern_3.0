"""Restrict all new invitations; an optional is_direct client flag is not authority."""
from collections.abc import Mapping
import hashlib
import hmac
from pathlib import Path
import time

PRIVACY = 'io.tavern.privacy'


class InvitationPolicy:
    def __init__(self, config, api):
        self.api = api
        self.url = config.get('privacy_api_url', '')
        self.key_file = Path(config.get('privacy_key_file', '/data/tavern-privacy.key'))

    async def contacts(self, sender, recipient):
        try:
            key = bytes.fromhex(self.key_file.read_text().strip())
            if len(key) != 32 or not self.url:
                return False
            timestamp = str(int(time.time()))
            payload = '\n'.join(('v1', 'invitation-consent', timestamp, sender, recipient))
            signature = hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()
            client = self.api.http_client
            request = client.get_json(self.url + '/api/internal/invitation-consent', args={'sender': sender, 'recipient': recipient}, headers={b'X-Tavern-Privacy-Timestamp': [timestamp.encode()], b'X-Tavern-Privacy-Signature': [signature.encode()]})
            if hasattr(client, 'reactor'):
                from twisted.internet.defer import ensureDeferred
                request = ensureDeferred(request).addTimeout(5, client.reactor)
            result = await request
            return isinstance(result, Mapping) and result.get('allowed') is True
        except Exception:
            return False  # Contact consent cannot become allow-on-network-failure.

    async def shared_server(self, sender, recipient):
        # Pinned Synapse datastore API: reads actual joined rooms, never a
        # client-supplied m.direct flag or claimed parent link.
        sender_rooms = await self.api._store.get_rooms_for_user(sender)
        recipient_rooms = await self.api._store.get_rooms_for_user(recipient)
        for room_id in set(sender_rooms) & set(recipient_rooms):
            state = await self.api.get_room_state(room_id, [('m.room.create', ''), ('m.room.member', sender), ('m.room.member', recipient)])
            creation, a, b = state.get(('m.room.create', '')), state.get(('m.room.member', sender)), state.get(('m.room.member', recipient))
            if creation and creation.content.get('type') == 'm.space' and a and a.content.get('membership') == 'join' and b and b.content.get('membership') == 'join':
                return True
        return False

    async def check(self, event):
        if event.type != 'm.room.member' or event.content.get('membership') != 'invite':
            return True
        recipient, sender = getattr(event, 'state_key', ''), event.sender
        if not self.api.is_mine(recipient):
            return True
        ignored = await self.api.account_data_manager.get_global(recipient, 'm.ignored_user_list') or {}
        if not isinstance(ignored, Mapping) or sender in ignored.get('ignored_users', {}):
            return False
        privacy = await self.api.account_data_manager.get_global(recipient, PRIVACY) or {}
        if not isinstance(privacy, Mapping):
            return False
        mode = privacy.get('invitations', 'everyone')
        if mode == 'everyone':
            return True
        if mode == 'contacts':
            return await self.contacts(sender, recipient)
        if mode == 'shared_server':
            return await self.shared_server(sender, recipient)
        return False
