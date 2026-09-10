"""Bounded media-grant projection for the pinned Tavern SFU extension.

LiveKit treats an empty source allowlist as unrestricted. Keep effective data
permission explicit when closing an empty video-only intersection. Full Twirp
updates overwrite ordinary permission fields, so never send a partial update.
"""
import copy
import re

SOURCES = ('unknown', 'camera', 'microphone', 'screen_share', 'screen_share_audio')
BOOLEANS = {'canPublish': True, 'canSubscribe': True,
            'tavernCanSubscribeAudio': True, 'canUpdateMetadata': False,
            'hidden': False, 'recorder': False, 'agent': False,
            'canSubscribeMetrics': False, 'canManageAgentSession': False}
FIELDS = frozenset(BOOLEANS) | {'canPublishData', 'canPublishSources'}
WIRE_NAMES = {re.sub(r'(?<!^)([A-Z])', r'_\1', key).lower(): key for key in FIELDS}


def boolean(value, key, default):
    result = value.get(key, default)
    if type(result) is not bool:
        raise ValueError('Invalid media permission')
    return result


def grant_permissions(video):
    if not isinstance(video, dict):
        raise ValueError('Invalid media grant')
    result = {key: boolean(video, 'canUpdateOwnMetadata' if key == 'canUpdateMetadata' else key, default)
              for key, default in BOOLEANS.items()}
    result['canPublishData'] = boolean(video, 'canPublishData', result['canPublish'])
    sources = video.get('canPublishSources', [])
    if (not isinstance(sources, list) or len(sources) > len(SOURCES)
            or any(type(item) is not str or item not in SOURCES for item in sources)
            or len(set(sources)) != len(sources)):
        raise ValueError('Invalid source grant')
    result['canPublishSources'] = sorted(sources)
    return result


def stored_permissions(value):
    if not isinstance(value, dict) or set(value) != FIELDS:
        raise ValueError('Invalid stored media grant')
    video = dict(value)
    video['canUpdateOwnMetadata'] = video.pop('canUpdateMetadata')
    return grant_permissions(video)


def publication_sources(publication):
    if not isinstance(publication, dict) or any(type(publication.get(key)) is not bool for key in ('speak', 'video', 'screen_share')):
        raise ValueError('Invalid publication restrictions')
    if all(publication[key] for key in ('speak', 'video', 'screen_share')):
        return None  # Preserve unrestricted UNKNOWN-source legacy clients.
    allowed = set()
    if publication['speak']:
        allowed.add('microphone')
    if publication['video']:
        allowed.add('camera')
    if publication['screen_share']:
        allowed.add('screen_share')
        if publication['speak']:
            allowed.add('screen_share_audio')
    return allowed


def project(baseline, muted, deafened, publication=None):
    if type(muted) is not bool or type(deafened) is not bool:
        raise ValueError('Invalid audio restriction')
    result = stored_permissions(baseline)
    allowed = set(result['canPublishSources'] or SOURCES)
    source_limit = publication_sources(publication) if publication is not None else None
    if source_limit is not None:
        allowed &= source_limit
    if muted:
        allowed &= {'camera', 'screen_share'}
    if muted or source_limit is not None:
        result['canPublishSources'] = sorted(allowed)
        if not allowed:
            result['canPublish'] = False
    if deafened:
        result['tavernCanSubscribeAudio'] = False
    return result


def attenuated(candidate, ceiling):
    """A signed old/refreshed grant may be narrower, never broader."""
    candidate, ceiling = stored_permissions(candidate), stored_permissions(ceiling)
    for key in FIELDS - {'canPublishSources'}:
        if candidate[key] and not ceiling[key]:
            return False
    if candidate['canPublish']:
        sources = set(candidate['canPublishSources'] or SOURCES)
        if not sources <= set(ceiling['canPublishSources'] or SOURCES):
            return False
    return True


def projected_claims(claims, permissions):
    result = copy.deepcopy(claims)
    for key, value in stored_permissions(permissions).items():
        result['video']['canUpdateOwnMetadata' if key == 'canUpdateMetadata' else key] = value
    return result


def twirp_permissions(permissions):
    result = stored_permissions(permissions)
    result['canPublishSources'] = [item.upper() for item in result['canPublishSources']]
    return result


def observed_permissions(value, require_extension=True):
    """ProtoJSON omits default false fields; require the extension explicitly.

    Its absence cannot establish that the expected patched SFU is running.
    """
    if not isinstance(value, dict):
        raise ValueError('Invalid observed permission')
    normalized = {}
    # Pinned xtwirp emits proto snake_case/defaults; protojson also accepts
    # camelCase. Never let duplicate aliases choose a more permissive value.
    for key, item in value.items():
        canonical = key if key in FIELDS else WIRE_NAMES.get(key)
        if canonical is None or canonical in normalized:
            raise ValueError('Unknown or repeated observed permission')
        normalized[canonical] = item
    value = normalized
    if not require_extension and 'tavernCanSubscribeAudio' not in value:
        value['tavernCanSubscribeAudio'] = True
    if type(value.get('tavernCanSubscribeAudio')) is not bool:
        raise ValueError('The SFU audio extension was not confirmed')
    result = {key: boolean(value, key, False) for key in FIELDS - {'canPublishSources'}}
    sources = value.get('canPublishSources', [])
    if not isinstance(sources, list) or len(sources) > len(SOURCES):
        raise ValueError('Invalid observed sources')
    normalized = []
    for item in sources:
        if type(item) is int and 0 <= item < len(SOURCES):
            normalized.append(SOURCES[item])
        elif isinstance(item, str) and item in {source.upper() for source in SOURCES}:
            normalized.append(item.lower())
        else:
            raise ValueError('Invalid observed source')
    if len(set(normalized)) != len(normalized):
        raise ValueError('Repeated observed source')
    result['canPublishSources'] = sorted(normalized)
    return result
