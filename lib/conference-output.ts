/** Silence existing remote receiver tracks, including Web Audio playback.
 * No capture, new connection, subscription change or sender mutation. */
export function createConferenceOutputGate() {
  const owned = new Map<MediaStreamTrack, boolean>();
  let deafened = false, stopped = false;
  function refresh(tracks: readonly MediaStreamTrack[]) {
    if (stopped) throw new Error('Call audio controls are no longer available.');
    if (tracks.length > 512 || tracks.some(track => track.kind !== 'audio')) throw new Error('Call audio tracks are unavailable.');
    const current = new Set(tracks);
    for (const [track, enabled] of owned) if (track.readyState !== 'live' || !deafened && !current.has(track)) {
      owned.delete(track);
      if (track.readyState === 'live') track.enabled = enabled;
    }
    if (deafened) for (const track of current) {
      if (track.readyState !== 'live') continue;
      if (!owned.has(track) && owned.size >= 1024) throw new Error('Call audio controls are unavailable.');
      if (!owned.has(track)) owned.set(track, track.enabled);
      track.enabled = false;
    }
    else {
      for (const [track, enabled] of owned) if (track.readyState === 'live') track.enabled = enabled;
      owned.clear();
    }
    if (deafened) for (const track of owned.keys()) if (track.readyState === 'live') track.enabled = false;
  }
  return {
    refresh,
    set(value: boolean, tracks: readonly MediaStreamTrack[]) {
      if (typeof value !== 'boolean') throw new Error('Invalid call audio control.');
      if (stopped || tracks.length > 512 || tracks.some(track => track.kind !== 'audio')) throw new Error('Call audio controls are unavailable.');
      deafened = value; refresh(tracks);
      if (value && tracks.some(track => track.readyState === 'live' && track.enabled)) throw new Error('Call audio could not be silenced.');
    },
    read: () => stopped ? null : deafened,
    stop() {
      if (stopped) return;
      // Retiring a call must not briefly resume audio before native teardown.
      owned.clear(); stopped = true;
    },
  };
}
