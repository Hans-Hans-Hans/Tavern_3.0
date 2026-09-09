import { CallFeedEvent, type CallFeed } from 'matrix-js-sdk/lib/webrtc/callFeed';

export type SpeechActivity = { speaking: boolean; measured: boolean; level: number };
type ActivityWatch = { listeners: Set<(activity: SpeechActivity) => void>; activity: SpeechActivity; stop: () => void };
const activityWatches = new WeakMap<CallFeed, ActivityWatch>();

export function watchSpeechActivity(feed: CallFeed, update: (activity: SpeechActivity) => void) {
  if (feed.purpose !== 'm.usermedia') { update({ speaking: false, measured: false, level: 0 }); return () => {}; }
  let watch = activityWatches.get(feed);
  if (!watch) {
    let started = false, stopped = false;
    const record: ActivityWatch = { listeners: new Set(), activity: { speaking: false, measured: false, level: 0 }, stop: () => {} };
    const publish = () => { for (const listener of record.listeners) listener(record.activity); };
    const volume = (db: number) => {
      if (stopped) return;
      const silent = feed.isAudioMuted();
      record.activity = { speaking: !silent && feed.isSpeaking(), measured: Number.isFinite(db) || db === -Infinity,
        level: silent || !Number.isFinite(db) ? 0 : Math.max(0, Math.min(100, (db + 60) * 100 / 60)) }; publish();
    };
    const speaking = (value: boolean) => { if (!stopped) { record.activity = { ...record.activity, speaking: !feed.isAudioMuted() && value }; publish(); } };
    const change = () => {
      if (stopped) return;
      if (feed.isAudioMuted()) { record.activity = { ...record.activity, speaking: false, level: 0 }; publish(); }
      if (!started && feed.hasAudioTrack) { started = true; feed.measureVolumeActivity(true); }
    };
    const disposed = () => { record.activity = { speaking: false, measured: false, level: 0 }; publish(); record.stop(); };
    record.stop = () => {
      if (stopped) return; stopped = true;
      feed.off(CallFeedEvent.VolumeChanged, volume); feed.off(CallFeedEvent.Speaking, speaking); feed.off(CallFeedEvent.MuteStateChanged, change); feed.off(CallFeedEvent.NewStream, change); feed.off(CallFeedEvent.Disposed, disposed);
      if (started) feed.measureVolumeActivity(false);
      record.listeners.clear(); activityWatches.delete(feed);
    };
    feed.on(CallFeedEvent.VolumeChanged, volume); feed.on(CallFeedEvent.Speaking, speaking); feed.on(CallFeedEvent.MuteStateChanged, change); feed.on(CallFeedEvent.NewStream, change); feed.on(CallFeedEvent.Disposed, disposed);
    activityWatches.set(feed, record); watch = record; change();
  }
  watch.listeners.add(update); update(watch.activity);
  return () => { watch!.listeners.delete(update); if (!watch!.listeners.size) watch!.stop(); };
}

export function fullscreenAvailable(element: Element | null) { return !!element && document.fullscreenEnabled === true && typeof element.requestFullscreen === 'function'; }
export async function toggleCallFullscreen(element: HTMLElement) {
  if (document.fullscreenElement === element) { await document.exitFullscreen(); return; }
  if (!fullscreenAvailable(element)) throw new Error('Fullscreen is unavailable in this browser or page. Expand the call panel instead.');
  try { await element.requestFullscreen(); }
  catch { throw new Error('This browser or window did not allow fullscreen. Keep the call expanded or try again from the fullscreen button.'); }
}
export function pictureInPictureAvailable(video: HTMLVideoElement | null) {
  return !!video && document.pictureInPictureEnabled === true && typeof video.requestPictureInPicture === 'function' && !video.disablePictureInPicture;
}
export async function toggleCallPictureInPicture(video: HTMLVideoElement) {
  if (document.pictureInPictureElement === video) { await document.exitPictureInPicture(); return; }
  if (!pictureInPictureAvailable(video)) throw new Error('Picture-in-Picture is unavailable in this browser. Use fullscreen or the expanded call panel.');
  if (!video.srcObject || !(video.srcObject instanceof MediaStream) || !video.srcObject.getVideoTracks().some(track => track.readyState === 'live') || video.readyState === 0) throw new Error('Wait for a live camera or shared-screen video before using Picture-in-Picture.');
  try { await video.requestPictureInPicture(); }
  catch { throw new Error('This browser or window did not allow Picture-in-Picture. Keep the video in Tavern or use fullscreen.'); }
}
export async function releaseVideoPresentation(video: HTMLVideoElement) {
  if (document.pictureInPictureElement === video) await document.exitPictureInPicture().catch(() => {});
}
