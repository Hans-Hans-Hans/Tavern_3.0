"""Server-role enforcement for local, non-federated Tavern Spaces.

This adds restrictions to Matrix authorization; it never grants native room powers.
Encrypted content is opaque: all encrypted messages share the send_messages gate.
"""
from collections.abc import Mapping
import re
from urllib.parse import urlsplit
try:
    from channel_policy import ChannelPolicy, CHANNEL, TIMEOUT
    from thread_policy import ThreadPolicy, THREAD
    from invitation_policy import InvitationPolicy
except ImportError:
    from synapse_modules.channel_policy import ChannelPolicy, CHANNEL, TIMEOUT
    from synapse_modules.thread_policy import ThreadPolicy, THREAD
    from synapse_modules.invitation_policy import InvitationPolicy

POLICY = "io.tavern.roles"
LAYOUT = "io.tavern.server.layout"
PERMISSIONS = frozenset({"send_messages", "add_reactions", "pin_messages", "manage_messages", "join_calls", "invite", "kick", "ban", "timeout", "manage_channels", "manage_roles", "manage_server"})
CHANNEL_PERMISSIONS = PERMISSIONS - {"manage_roles", "manage_server"}


def content(state, event_type, key=""):
    event = state.get((event_type, key))
    return event.content if event else {}


class ResolvedPolicy(dict):
    """Non-serialized context, populated only from the actual policy Space."""
    def __init__(self, policy, layout):
        super().__init__(policy)
        self._category_by_room = layout_categories(layout)


def valid_layout(layout):
    if not isinstance(layout, Mapping) or layout.get('version') != 1:
        return False
    categories, channels = layout.get('categories'), layout.get('channels')
    if not isinstance(categories, (list, tuple)) or len(categories) > 100 or not isinstance(channels, (list, tuple)) or len(channels) > 1000:
        return False
    category_ids, room_ids = set(), set()
    for category in categories:
        if not isinstance(category, Mapping) or not isinstance(category.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', category['id']) or category['id'] in category_ids:
            return False
        category_ids.add(category['id'])
    for channel in channels:
        if not isinstance(channel, Mapping) or not isinstance(channel.get('id'), str) or not channel['id'].startswith('!') or channel['id'] in room_ids or not isinstance(channel.get('category', ''), str) or channel.get('category', '') not in category_ids | {''}:
            return False
        room_ids.add(channel['id'])
    return True


def layout_categories(layout):
    return {channel['id']: channel.get('category', '') for channel in layout['channels']} if valid_layout(layout) else {}


def meaningful_overrides(values):
    result = {}
    for kind in ('roles', 'users'):
        targets = {}
        for target, rules in values.get(kind, {}).items():
            effective = {permission: direction for permission, direction in rules.items() if direction in (-1, 1)}
            if effective:
                targets[target] = effective
        if targets:
            result[kind] = targets
    return result


def may_edit_layout(previous, proposed, policy, actor):
    if not valid_layout(proposed):
        return False
    if actor == policy['owner']:
        return True
    before, after = layout_categories(previous), layout_categories(proposed)
    category_rules = policy.get('categoryOverrides', {})
    for room_id in before.keys() | after.keys():
        old, new = meaningful_overrides(category_rules.get(before.get(room_id), {})), meaningful_overrides(category_rules.get(after.get(room_id), {}))
        if old != new:
            return False  # Moving must not bypass inherited policy hierarchy.
    return True


def valid_policy(policy):
    if not isinstance(policy, Mapping) or policy.get("version") != 1 or not isinstance(policy.get("owner"), str) or not policy["owner"].startswith("@"):
        return False
    roles, members, overrides = policy.get("roles"), policy.get("members"), policy.get("overrides", {})
    if not isinstance(roles, (list, tuple)) or not 1 <= len(roles) <= 100 or not isinstance(members, Mapping) or len(members) > 1000 or not isinstance(overrides, Mapping) or len(overrides) > 1000:
        return False
    ids, positions = set(), set()
    for role in roles:
        if not isinstance(role, Mapping) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", str(role.get("id", ""))) or not isinstance(role.get("name"), str) or not 1 <= len(role["name"].strip()) <= 60:
            return False
        rank, rid, grants = role.get("position"), role["id"], role.get("permissions")
        if not isinstance(rank, int) or isinstance(rank, bool) or not 0 <= rank < 1000 or rid in ids or rank in positions or not isinstance(grants, (list, tuple)) or any(not isinstance(p, str) for p in grants) or not set(grants) <= PERMISSIONS:
            return False
        if (rid == "everyone") != (rank == 0):
            return False
        if role.get("color") and not re.fullmatch(r"#[0-9A-Fa-f]{6}", str(role["color"])):
            return False
        if not isinstance(role.get("icon", ""), str) or len(role.get("icon", "")) > 16:
            return False
        ids.add(rid)
        positions.add(rank)
    if "everyone" not in ids:
        return False
    for user, assigned in members.items():
        if not isinstance(user, str) or not user.startswith("@") or not isinstance(assigned, (list, tuple)) or len(assigned) > 100 or any(not isinstance(r, str) for r in assigned) or not set(assigned) <= ids:
            return False
    categories = policy.get('categoryOverrides', {})
    if not isinstance(categories, Mapping) or len(categories) > 100:
        return False
    for room, values, is_category in [(key, values, False) for key, values in overrides.items()] + [(key, values, True) for key, values in categories.items()]:
        if not isinstance(room, str) or (not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', room) if is_category else not room.startswith('!')) or not isinstance(values, Mapping):
            return False
        for kind in ("roles", "users"):
            targets = values.get(kind, {})
            if not isinstance(targets, Mapping) or len(targets) > 1000:
                return False
            for target, permissions in targets.items():
                if not isinstance(target, str) or (target not in ids if kind == "roles" else not target.startswith("@")) or not isinstance(permissions, Mapping) or not set(permissions) <= CHANNEL_PERMISSIONS or any(value not in (-1, 0, 1) or isinstance(value, bool) for value in permissions.values()):
                    return False
    return True


def user_roles(policy, user):
    assigned = set(policy.get("members", {}).get(user, [])) | {"everyone"}
    return [role for role in policy["roles"] if role["id"] in assigned]


def rank(policy, user):
    return 1001 if user == policy["owner"] else max(role["position"] for role in user_roles(policy, user))


def permissions(policy, user, room_id=None, category_id=None):
    if user == policy["owner"]:
        return set(PERMISSIONS)
    roles = user_roles(policy, user)
    result = set().union(*(set(role["permissions"]) for role in roles))
    if category_id is None:
        category_id = getattr(policy, '_category_by_room', {}).get(room_id)
    stages = [policy.get('categoryOverrides', {}).get(category_id, {}), policy.get("overrides", {}).get(room_id, {})]
    # Category first, then channel. Each stage uses role deny-wins followed by
    # the explicit member override; native Matrix powers remain the ceiling.
    for override in stages:
        for perm in CHANNEL_PERMISSIONS:
            values = [override.get("roles", {}).get(role["id"], {}).get(perm, 0) for role in roles]
            if -1 in values:
                result.discard(perm)
            elif 1 in values:
                result.add(perm)
            user_value = override.get("users", {}).get(user, {}).get(perm, 0)
            if user_value == -1:
                result.discard(perm)
            elif user_value == 1:
                result.add(perm)
    return result


def may_edit_policy(previous, proposed, actor):
    if not valid_policy(proposed) or proposed["owner"] != previous["owner"]:
        return False
    if actor == previous["owner"]:
        return True
    grants, actor_rank = permissions(previous, actor), rank(previous, actor)
    old_roles = {r["id"]: r for r in previous["roles"]}
    new_roles = {r["id"]: r for r in proposed["roles"]}
    if previous["roles"] != proposed["roles"]:
        if "manage_roles" not in grants:
            return False
        for rid in old_roles.keys() | new_roles.keys():
            old, new = old_roles.get(rid), new_roles.get(rid)
            if old == new:
                continue
            if any(role and role["position"] >= actor_rank for role in (old, new)) or (new and not set(new["permissions"]) <= grants):
                return False
    old_members, new_members = previous["members"], proposed["members"]
    for user in old_members.keys() | new_members.keys():
        if old_members.get(user, []) == new_members.get(user, []):
            continue
        if "manage_roles" not in grants or user == actor or rank(previous, user) >= actor_rank or rank(proposed, user) >= actor_rank:
            return False
        added_roles = set(new_members.get(user, [])) - set(old_members.get(user, []))
        if any(not set(new_roles[role]["permissions"]) <= grants for role in added_roles):
            return False
    for override_key in ('overrides', 'categoryOverrides'):
        if previous.get(override_key, {}) == proposed.get(override_key, {}):
            continue
        if "manage_channels" not in grants:
            return False
        old_overrides, new_overrides = previous.get(override_key, {}), proposed.get(override_key, {})
        for room in old_overrides.keys() | new_overrides.keys():
            for kind in ("roles", "users"):
                old_targets, new_targets = old_overrides.get(room, {}).get(kind, {}), new_overrides.get(room, {}).get(kind, {})
                for target in old_targets.keys() | new_targets.keys():
                    old_values, new_values = old_targets.get(target, {}), new_targets.get(target, {})
                    if old_values == new_values:
                        continue
                    target_rank = old_roles.get(target, new_roles.get(target, {})).get("position", 0) if kind == "roles" else rank(previous, target)
                    if target_rank >= actor_rank or any(value == 1 and permission not in grants for permission, value in new_values.items()):
                        return False
    # Do not allow a lower role edit to add new authority to the editor.
    return permissions(proposed, actor) <= grants and rank(proposed, actor) <= actor_rank


class TavernPolicy:
    def __init__(self, config, api):
        self.api = api
        self.channels = ChannelPolicy(api, permissions, rank)
        self.threads = ThreadPolicy(api, self.channels)
        self.invitations = InvitationPolicy(config, api)
        api.register_third_party_rules_callbacks(check_event_allowed=self.check_event_allowed)

    @staticmethod
    def parse_config(config):
        url = config.get('privacy_api_url', '')
        parsed = urlsplit(url)
        if url and (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.path or parsed.query or parsed.fragment):
            raise ValueError('privacy_api_url must be the account gateway origin')
        return {'privacy_api_url': url.rstrip('/'), 'privacy_key_file': config.get('privacy_key_file', '/data/tavern-privacy.key')}

    async def _policies(self, event, state):
        own = content(state, POLICY)
        if (POLICY, "") in state:
            return [(event.room_id, ResolvedPolicy(own, content(state, LAYOUT)), state)]
        parents = [(key, value) for (kind, key), value in state.items() if kind == "m.space.parent" and value.content.get("canonical") and value.content.get("via")]
        found = []
        for parent_id, _ in parents:
            parent = await self.api.get_room_state(parent_id, [(POLICY, ''), (LAYOUT, ''), ('m.space.child', event.room_id), (TIMEOUT, event.sender)])
            policy = content(parent, POLICY)
            # Reciprocal links prevent a client from claiming membership of someone else's server.
            if (POLICY, "") in parent and content(parent, "m.space.child", event.room_id).get("via"):
                found.append((parent_id, ResolvedPolicy(policy, content(parent, LAYOUT)), parent))
        return found

    async def check_event_allowed(self, event, state_events):
        if not await self.invitations.check(event):
            return False, None
        if event.type == POLICY:
            create = state_events.get(("m.room.create", ""))
            if getattr(event, "state_key", None) != "" or not create or create.content.get("type") != "m.space" or create.content.get("m.federate", True):
                return False, None
            if 'io.tavern.previous_event' in event.content:
                current_event = state_events.get((POLICY, ''))
                current_id = current_event.event_id if current_event else None
                if event.content['io.tavern.previous_event'] != current_id:
                    return False, None
            old = content(state_events, POLICY)
            if not old:
                return bool(valid_policy(event.content) and event.sender == create.sender and event.content["owner"] == create.sender), None
            if not valid_policy(old):
                return False, None
            return may_edit_policy(old, event.content, event.sender), None
        policies = await self._policies(event, state_events)
        if event.type == LAYOUT and (getattr(event, 'state_key', None) != '' or not valid_layout(event.content)):
            return False, None
        for server_id, policy, server_state in policies:
            if not valid_policy(policy):
                return False, None
            actor = event.sender
            if (LAYOUT, '') in server_state and not valid_layout(content(server_state, LAYOUT)) and (event.type != LAYOUT or actor != policy['owner']):
                return False, None
            grants = permissions(policy, actor, event.room_id)
            if event.type == LAYOUT and not may_edit_layout(content(server_state, LAYOUT), event.content, policy, actor):
                return False, None
            if event.type == "m.room.redaction":
                target = getattr(event, "redacts", None) or event.content.get("redacts")
                # Synapse's public module API has no single-event lookup. This read-only
                # adapter is covered by deployment tests and the pinned Synapse version.
                original = await self.api._store.get_event(target, allow_none=True) if target else None
                # Redacting a policy or parent could remove enforcement. Policies must be edited in place.
                if not original or original.type in (POLICY, CHANNEL, TIMEOUT, THREAD, LAYOUT, "m.space.parent", "m.space.child", "m.room.create"):
                    return False, None
                if original.sender != actor and "manage_messages" not in grants:
                    return False, None
                continue
            if actor == policy["owner"]:
                continue
            kind, key = event.type, getattr(event, "state_key", None)
            if kind == "m.room.member":
                membership = event.content.get("membership")
                if key == actor and membership in ("join", "leave"):
                    continue
                need = "invite" if membership == "invite" else "ban" if membership == "ban" or content(state_events, "m.room.member", key).get("membership") == "ban" else "kick"
                if need not in grants or (need != "invite" and rank(policy, key) >= rank(policy, actor)):
                    return False, None
            elif kind in ("m.space.parent", "m.space.child"):
                # Adding a new channel is allowed; removing an existing managed
                # relationship would remove enforcement and requires the owner.
                if kind != "m.space.child" or content(state_events, kind, key).get("via") or "manage_channels" not in grants or not event.content.get("via"):
                    return False, None
            elif kind == "m.room.power_levels":
                return False, None  # Native authority remains an owner operation.
            else:
                need = {"m.room.message": "send_messages", "m.room.encrypted": "send_messages", "m.reaction": "add_reactions", "m.room.pinned_events": "pin_messages", "org.matrix.msc3401.call.member": "join_calls", "m.call.invite": "join_calls", "m.call.answer": "join_calls", "io.tavern.server.layout": "manage_channels", TIMEOUT: "timeout"}.get(kind)
                if need is None and key is not None and kind != THREAD:
                    need = "manage_server" if event.room_id == server_id else "manage_channels"
                if need and need not in grants:
                    return False, None
        if not await self.threads.check(event, state_events, policies) or not await self.channels.check(event, state_events, policies):
            return False, None
        return await self.threads.finish(event, state_events)
