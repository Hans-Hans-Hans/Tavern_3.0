"""Server-role enforcement for local, non-federated Tavern Spaces.

This adds restrictions to Matrix authorization; it never grants native room powers.
Encrypted content is opaque: all encrypted messages share the send_messages gate.
"""
from collections.abc import Mapping
from types import SimpleNamespace
import re
from urllib.parse import urlsplit
try:
    from community_settings import check_settings, NOTIFICATIONS, ONBOARDING, BRANDING
    from private_thread import PrivateThreadPolicy, SETTINGS as PRIVATE_SETTINGS
    from server_afk import ServerAfkPolicy, AFK
    from server_eligibility import ServerEligibilityPolicy, EligibilityDenied, ELIGIBILITY, cleanup as eligibility_cleanup
    from profile_metadata_policy import ProfileMetadataPolicy, ProfilePolicyDenied, PROFILE_POLICY
    from server_nickname import check_nickname, NICKNAME
    from channel_policy import ChannelPolicy, CHANNEL, TIMEOUT
    from thread_policy import ThreadPolicy, THREAD
    from invitation_policy import InvitationPolicy
    from temporary_ban import TemporaryBanPolicy, TEMPBAN, active as temporary_ban_active, cleanup as temporary_ban_cleanup
except ImportError:
    from synapse_modules.community_settings import check_settings, NOTIFICATIONS, ONBOARDING, BRANDING
    from synapse_modules.private_thread import PrivateThreadPolicy, SETTINGS as PRIVATE_SETTINGS
    from synapse_modules.server_afk import ServerAfkPolicy, AFK
    from synapse_modules.server_eligibility import ServerEligibilityPolicy, EligibilityDenied, ELIGIBILITY, cleanup as eligibility_cleanup
    from synapse_modules.profile_metadata_policy import ProfileMetadataPolicy, ProfilePolicyDenied, PROFILE_POLICY
    from synapse_modules.server_nickname import check_nickname, NICKNAME
    from synapse_modules.channel_policy import ChannelPolicy, CHANNEL, TIMEOUT
    from synapse_modules.thread_policy import ThreadPolicy, THREAD
    from synapse_modules.invitation_policy import InvitationPolicy
    from synapse_modules.temporary_ban import TemporaryBanPolicy, TEMPBAN, active as temporary_ban_active, cleanup as temporary_ban_cleanup

POLICY = "io.tavern.roles"
LAYOUT = "io.tavern.server.layout"
PERMISSIONS = frozenset({"send_messages", "create_private_threads", "add_reactions", "pin_messages", "manage_messages", "manage_reports", "manage_webhooks", "manage_nicknames", "join_calls", "invite", "kick", "ban", "timeout", "manage_channels", "manage_roles", "manage_server"})
CHANNEL_PERMISSIONS = PERMISSIONS - {"manage_roles", "manage_server", "manage_nicknames"}


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


def native_member_power(state, user):
    create = state.get(('m.room.create', ''))
    creation = create.content if create else {}
    version = creation.get('room_version', getattr(getattr(create, 'room_version', None), 'identifier', '1'))
    if version == '12' and (create.sender == user or user in creation.get('additional_creators', ())):
        return float('inf')
    event = state.get(('m.room.power_levels', ''))
    if not event:
        return 100 if create and create.sender == user else 0
    result = event.content.get('users', {}).get(user, event.content.get('users_default', 0))
    return result if type(result) is int else None


def may_assign_native_members(previous, proposed, state, actor):
    """Member assignments cannot bypass the target's native room hierarchy.

    Removing a deleted role from every member is definition cleanup, not a new
    assignment. The existing role hierarchy still authorizes that deletion.
    """
    retained = {role['id'] for role in proposed['roles']}
    before, after = previous.get('members', {}), proposed['members']
    actor_power = native_member_power(state, actor)
    for user in before.keys() | after.keys():
        if set(before.get(user, ())) & retained == set(after.get(user, ())) or user == actor:
            continue
        target_power = native_member_power(state, user)
        if actor_power is None or target_power is None or target_power >= actor_power:
            return False
    return True


class TavernPolicy:
    def __init__(self, config, api):
        self.api = api
        self.channels = ChannelPolicy(api, permissions, rank)
        self.threads = ThreadPolicy(api, self.channels)
        self.invitations = InvitationPolicy(config, api)
        self.temporary_bans = TemporaryBanPolicy(api, permissions, rank)
        self.private_threads = PrivateThreadPolicy(self, permissions, rank, native_member_power, valid_policy, valid_layout)
        self.server_afk = ServerAfkPolicy(api)
        self.server_eligibility = ServerEligibilityPolicy(config, api, SimpleNamespace(POLICY=POLICY,
            valid_policy=valid_policy, permissions=permissions, native_member_power=native_member_power))
        self.profile_metadata = ProfileMetadataPolicy(api, SimpleNamespace(POLICY=POLICY,
            valid_policy=valid_policy, permissions=permissions, native_member_power=native_member_power))
        api.register_third_party_rules_callbacks(check_event_allowed=self.check_event_with_errors, on_create_room=self.on_create_room,
            check_visibility_can_be_modified=self.private_threads.visibility, check_threepid_can_be_invited=self.private_threads.threepid)

    async def on_create_room(self, requester, request_content, is_requester_admin):
        error = await self.private_threads.create(requester.user.to_string(), request_content)
        creation = request_content.get('creation_content', {})
        if not error and isinstance(creation, Mapping) and creation.get('type') == 'io.tavern.private_thread':
            state = {('m.room.create', ''): SimpleNamespace(content=creation)}
            for actor in [requester.user.to_string()] + request_content.get('invite', []):
                if not await self.server_eligibility.eligible('', state, actor):
                    error = 'The source server account requirements do not permit this private discussion.'
                    break
        if error:
            from synapse.module_api.errors import SynapseError
            raise SynapseError(403, error, 'M_FORBIDDEN')

    async def check_event_with_errors(self, event, state_events):
        try:
            return await self.check_event_allowed(event, state_events)
        except (EligibilityDenied, ProfilePolicyDenied) as error:
            from synapse.module_api.errors import SynapseError
            raise SynapseError(403, str(error), 'M_FORBIDDEN') from None

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
            filters = [(POLICY, ''), (LAYOUT, ''), ('m.space.child', event.room_id), (TIMEOUT, event.sender), (TEMPBAN, event.sender), ('m.room.member', event.sender)]
            if event.type in ('m.room.member', TEMPBAN) and isinstance(getattr(event, 'state_key', None), str):
                filters.append((TEMPBAN, event.state_key))
            parent = await self.api.get_room_state(parent_id, filters)
            policy = content(parent, POLICY)
            # Reciprocal links prevent a client from claiming membership of someone else's server.
            if (POLICY, "") in parent and content(parent, "m.space.child", event.room_id).get("via"):
                found.append((parent_id, ResolvedPolicy(policy, content(parent, LAYOUT)), parent))
        return found

    async def check_event_allowed(self, event, state_events):
        if not await self.server_eligibility.check(event, state_events):
            return False, None
        if eligibility_cleanup(event, state_events):
            return True, None  # Native auth still applies; account requirements cannot trap members.
        if not await self.profile_metadata.check(event, state_events):
            return False, None
        if not await self.server_afk.check(event, state_events):
            return False, None
        if not check_settings(event, state_events):
            return False, None
        if not await self.invitations.check(event):
            return False, None
        private_result = await self.private_threads.check(event, state_events)
        if private_result is not None:
            return private_result
        policies = await self._policies(event, state_events)
        if any(not valid_policy(policy) for _, policy, _ in policies):
            return False, None
        if not await self.temporary_bans.check(event, state_events, policies):
            return False, None
        if not check_nickname(event, state_events, policies, permissions, rank, native_member_power):
            return False, None
        # Native Matrix auth still applies to these teardown events. A restricted
        # member must be able to leave even if their former role was removed.
        if temporary_ban_cleanup(event, state_events):
            import time
            now = int(time.time() * 1000)
            if temporary_ban_active(state_events, event.sender, now) or any(temporary_ban_active(parent, event.sender, now) for _, _, parent in policies):
                return True, None
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
                return bool(valid_policy(event.content) and event.sender == create.sender and event.content["owner"] == create.sender and may_assign_native_members({}, event.content, state_events, event.sender)), None
            if not valid_policy(old):
                return False, None
            return may_edit_policy(old, event.content, event.sender) and may_assign_native_members(old, event.content, state_events, event.sender), None
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
                if not original or original.type in (POLICY, CHANNEL, TIMEOUT, TEMPBAN, THREAD, PRIVATE_SETTINGS, LAYOUT, NOTIFICATIONS, ONBOARDING, BRANDING, NICKNAME, ELIGIBILITY, "m.space.parent", "m.space.child", "m.room.create"):
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
                need = {"m.room.message": "send_messages", "m.room.encrypted": "send_messages", "m.reaction": "add_reactions", "m.room.pinned_events": "pin_messages", "org.matrix.msc3401.call.member": "join_calls", "m.call.invite": "join_calls", "m.call.answer": "join_calls", "io.tavern.server.layout": "manage_channels", TIMEOUT: "timeout", TEMPBAN: "ban", NICKNAME: "manage_nicknames"}.get(kind)
                if need is None and key is not None and kind != THREAD:
                    need = "manage_server" if event.room_id == server_id else "manage_channels"
                if need and need not in grants:
                    return False, None
        if not await self.threads.check(event, state_events, policies) or not await self.channels.check(event, state_events, policies):
            return False, None
        return await self.threads.finish(event, state_events)
