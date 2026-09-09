"""Reuse the deployed Synapse policy model for private companion operations.

The account gateway never grants native Matrix authority. The shared model is
loaded only from the deployment's read-only module volume, or this repository in
development. Parent relationships come from current reciprocal room state.
"""
from dataclasses import dataclass
from importlib import import_module, util
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from urllib.parse import quote

try:
    from .server import APIError
except ImportError:
    from server import APIError

_models = {}


def policy_model(service):
    directory = service.config.synapse_config.parent / 'tavern_modules'
    if not (directory / 'tavern_policy.py').is_file():
        if (Path(__file__).resolve().parent.parent / 'synapse_modules' / 'tavern_policy.py').is_file():
            return import_module('synapse_modules.tavern_policy')
        raise APIError(503, 'The deployed server-role policy is unavailable. Ask an administrator to check provisioning.')
    key = str(directory.resolve())
    if key not in _models:
        # Imports are synchronous, from a deployment-controlled read-only path.
        sys.path.insert(0, key)
        try:
            spec = util.spec_from_file_location('_tavern_companion_policy', directory / 'tavern_policy.py')
            module = util.module_from_spec(spec); spec.loader.exec_module(module)
            _models[key] = module
        except (ImportError, OSError):
            raise APIError(503, 'The deployed server-role policy could not be loaded.') from None
        finally:
            sys.path.remove(key)
    return _models[key]


def room_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'![^\s/\\?#]{1,254}:[^\s/\\?#]{1,254}', value):
        raise APIError(400, 'Choose a valid Matrix room.')
    return value


def user_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'@[^\s/\\?#]{1,254}:[^\s/\\?#]{1,254}', value):
        raise APIError(400, 'Choose a valid Matrix account.')
    return value


def content(state, kind, key=''):
    event = state.get((kind, key))
    return event.content if event else {}


def power(state, user):
    values = content(state, 'm.room.power_levels')
    if not values:
        creator = state.get(('m.room.create', ''))
        return 100 if creator and creator.sender == user else 0
    level = values.get('users', {}).get(user, values.get('users_default', 0))
    if type(level) is not int: raise APIError(403, 'Room power levels are invalid.')
    return level


async def state(service, identity):
    value = await service.matrix('GET', '/_synapse/admin/v1/rooms/' + quote(identity, safe='') + '/state', token=await service.service_token())
    events = value.get('state')
    if not isinstance(events, list) or len(events) > 50000:
        raise APIError(503, 'This room state could not be safely checked.')
    result = {}
    for event in events:
        if not isinstance(event, dict) or not isinstance(event.get('type'), str) or not isinstance(event.get('state_key'), str) or not isinstance(event.get('content'), dict):
            raise APIError(503, 'This room state could not be safely checked.')
        result[(event['type'], event['state_key'])] = SimpleNamespace(content=event['content'], sender=event.get('sender'), event_id=event.get('event_id'))
    return result


@dataclass
class RoomAuthority:
    room_id: str
    actor: str
    state: dict
    policies: list
    model: object

    def require(self, permission, native='redact', target=None, target_joined=False):
        threshold = content(self.state, 'm.room.power_levels').get(native, 50)
        if type(threshold) is not int or power(self.state, self.actor) < threshold:
            raise APIError(403, 'You do not have the native room permission for this action.')
        for server_id, policy, server_state in self.policies:
            if content(server_state, 'm.room.member', self.actor).get('membership') != 'join':
                raise APIError(403, 'You must currently belong to the parent server to moderate this channel.')
            if permission not in self.model.permissions(policy, self.actor, self.room_id):
                raise APIError(403, 'Your current server or channel role does not permit this action.')
        if target is not None:
            user_id(target)
            if target == self.actor or power(self.state, target) >= power(self.state, self.actor):
                raise APIError(403, 'You cannot moderate yourself or a member with equal or higher room power.')
            if target_joined and content(self.state, 'm.room.member', target).get('membership') not in ('join', 'invite'):
                raise APIError(403, 'Warnings can only be issued to current or invited room members.')
            if any(self.model.rank(policy, target) >= self.model.rank(policy, self.actor) for _, policy, _ in self.policies):
                raise APIError(403, 'You cannot moderate an equal or higher server role.')
        return self


async def room_authority(service, session, identity):
    identity = room_id(identity); actor = session['user_id']
    # Validate ordinary access before using the service's read-only state view.
    membership = await service.matrix('GET', '/_matrix/client/v3/rooms/' + quote(identity, safe='') + '/state/m.room.member/' + quote(actor, safe=''), token=service.store.open(session['token']))
    if membership.get('membership') != 'join': raise APIError(403, 'Join this room before accessing moderation tools.')
    current = await state(service, identity)
    if content(current, 'm.room.member', actor).get('membership') != 'join': raise APIError(403, 'Your room membership changed. Reopen moderation tools.')
    model = policy_model(service); policies = []
    candidates = [(identity, current)] if (model.POLICY, '') in current else []
    if not candidates:
        parents = [key for (kind, key), event in current.items() if kind == 'm.space.parent' and event.content.get('canonical') and event.content.get('via')]
        if len(parents) > 32: raise APIError(503, 'This room has too many canonical parents to authorize this operation safely.')
        for parent_id in parents:
            parent = await state(service, room_id(parent_id))
            if (model.POLICY, '') in parent and content(parent, 'm.space.child', identity).get('via'):
                candidates.append((parent_id, parent))
    for server_id, parent in candidates:
        policy = content(parent, model.POLICY); layout = content(parent, model.LAYOUT)
        if not model.valid_policy(policy) or ((model.LAYOUT, '') in parent and not model.valid_layout(layout)):
            raise APIError(403, 'The server role policy is invalid. Ask the server owner to repair it.')
        policies.append((server_id, model.ResolvedPolicy(policy, layout), parent))
    return RoomAuthority(identity, actor, current, policies, model)
