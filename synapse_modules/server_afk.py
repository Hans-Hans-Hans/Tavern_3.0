"""Protect the AFK destination hint. This never moves or monitors call members."""
from collections.abc import Mapping

try:
    from channel_policy import value, valid_channel
except ImportError:
    from synapse_modules.channel_policy import value, valid_channel

AFK = 'io.tavern.server.afk'
TIMEOUTS = {300, 600, 900, 1800, 3600}


def valid_afk(data):
    channel = data.get('channelId') if isinstance(data, Mapping) else None
    return (isinstance(data, Mapping) and set(data) <= {'version', 'channelId', 'timeoutSeconds', 'io.tavern.previous_event'}
            and type(data.get('version')) is int and data['version'] == 1
            and isinstance(channel, str) and (channel == '' or channel.startswith('!') and 2 <= len(channel) <= 255 and not any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in channel))
            and type(data.get('timeoutSeconds')) is int and data['timeoutSeconds'] in TIMEOUTS)


class ServerAfkPolicy:
    def __init__(self, api):
        self.api = api

    async def check(self, event, state):
        if event.type == 'm.room.redaction':
            target = getattr(event, 'redacts', None) or event.content.get('redacts')
            original = await self.api._store.get_event(target, allow_none=True) if target else None
            if original and original.type == AFK:
                return False
        if event.type != AFK:
            return True
        previous = state.get((AFK, ''))
        data, create = event.content, value(state, 'm.room.create')
        if (getattr(event, 'state_key', None) != '' or not valid_afk(data)
                or 'io.tavern.previous_event' not in data
                or data['io.tavern.previous_event'] != (getattr(previous, 'event_id', None) if previous else None)
                or create.get('type') != 'm.space' or create.get('m.federate') is not False
                or value(state, 'm.room.member', event.sender).get('membership') != 'join'):
            return False
        channel = data['channelId']
        if not channel:
            return True
        if not value(state, 'm.space.child', channel).get('via'):
            return False
        target = await self.api.get_room_state(channel)
        creation, policy = value(target, 'm.room.create'), value(target, 'io.tavern.channel')
        parent = value(target, 'm.space.parent', event.room_id)
        return bool(creation.get('m.federate') is False and creation.get('type') not in ('m.space', 'io.tavern.private_thread')
                    and value(target, 'm.room.encryption').get('algorithm') == 'm.megolm.v1.aes-sha2'
                    and valid_channel(policy) and policy.get('kind') == 'voice' and not policy.get('archived')
                    and not value(target, 'm.room.tombstone') and parent.get('canonical') is True and parent.get('via')
                    and value(target, 'm.room.member', event.sender).get('membership') == 'join')
