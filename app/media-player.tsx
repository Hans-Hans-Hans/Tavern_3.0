import { useEffect, useRef, useState } from 'react';
import { Maximize, Minimize, Pause, PictureInPicture2, Play, Volume2, VolumeX } from 'lucide-react';
import './media-player.css';

function time(value: number) {
  const seconds = Math.max(0, Math.floor(value)), hours = Math.floor(seconds / 3600);
  return (hours ? hours + ':' : '') + String(Math.floor(seconds / 60) % 60).padStart(hours ? 2 : 1, '0') + ':' + String(seconds % 60).padStart(2, '0');
}
export function MediaPlayer({ source, name }: { source: string; name: string }) {
  const player = useRef<HTMLVideoElement>(null), frame = useRef<HTMLDivElement>(null), active = useRef<object | null>(null);
  const [state, setState] = useState({ paused: true, ready: false, current: 0, duration: 0, volume: 1, muted: false, rate: 1, waiting: false });
  const [error, setError] = useState(''), [fullscreen, setFullscreen] = useState(false), [pip, setPip] = useState(false);
  function refresh() {
    const video = player.current; if (!video) return;
    setState(previous => ({ ...previous, paused: video.paused, ready: video.readyState > 0, current: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0, volume: video.volume, muted: video.muted, rate: video.playbackRate }));
  }
  useEffect(() => {
    const video = player.current!, container = frame.current!, generation = {}; active.current = generation;
    if (video.getAttribute('src') !== source) { video.src = source; video.load(); }
    const presentation = () => { setFullscreen(document.fullscreenElement === container); setPip(document.pictureInPictureElement === video); };
    document.addEventListener('fullscreenchange', presentation); video.addEventListener('enterpictureinpicture', presentation); video.addEventListener('leavepictureinpicture', presentation);
    return () => {
      if (active.current === generation) active.current = null; video.pause();
      document.removeEventListener('fullscreenchange', presentation); video.removeEventListener('enterpictureinpicture', presentation); video.removeEventListener('leavepictureinpicture', presentation);
      if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => {});
      if (document.fullscreenElement === container) void document.exitFullscreen().catch(() => {});
      // A development effect replay immediately reacquires this same element.
      queueMicrotask(() => { if (!active.current) { video.removeAttribute('src'); video.load(); } });
    };
  }, [source]);
  async function togglePlay() {
    const video = player.current, generation = active.current; if (!video || !generation) return; setError('');
    if (!video.paused) { video.pause(); return; }
    try { await video.play(); if (active.current !== generation) video.pause(); }
    catch { if (active.current === generation) setError('Playback could not start. Try again, or download the video to open it on your device.'); }
  }
  async function presentation(mode: 'fullscreen' | 'pip') {
    const video = player.current!, container = frame.current!, generation = active.current; if (!generation) return; setError('');
    try {
      if (mode === 'fullscreen') {
        if (document.fullscreenElement === container) await document.exitFullscreen();
        else { await container.requestFullscreen(); if (active.current !== generation && document.fullscreenElement === container) await document.exitFullscreen(); }
      } else if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
      else { await video.requestPictureInPicture(); if (active.current !== generation && document.pictureInPictureElement === video) await document.exitPictureInPicture(); }
    } catch { if (active.current === generation) setError(mode === 'fullscreen' ? 'Fullscreen is unavailable in this window.' : 'Picture-in-Picture is unavailable in this window.'); }
  }
  return <div ref={frame} className="media-player" role="region" aria-label={'Video player: ' + name} tabIndex={0} onKeyDown={event => {
    // Controls retain their native keyboard behavior; the surrounding gallery must not capture seeking keys.
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) event.stopPropagation();
    if ((event.target !== event.currentTarget && event.target !== player.current) || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === ' ' || event.key.toLowerCase() === 'k') { event.preventDefault(); void togglePlay(); }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && state.duration) { event.preventDefault(); player.current!.currentTime = Math.max(0, Math.min(state.duration, state.current + (event.key === 'ArrowRight' ? 5 : -5))); }
    if (event.key.toLowerCase() === 'm') { event.preventDefault(); player.current!.muted = !player.current!.muted; }
  }}>
    <video ref={player} src={source} playsInline preload="metadata" aria-label={name} onClick={() => void togglePlay()} onLoadedMetadata={refresh} onDurationChange={refresh} onTimeUpdate={refresh} onPlay={refresh} onPause={refresh} onEnded={refresh} onVolumeChange={refresh} onRateChange={refresh}
      onWaiting={() => setState(previous => ({ ...previous, waiting: true }))} onPlaying={() => { refresh(); setState(previous => ({ ...previous, waiting: false })); }} onCanPlay={() => { refresh(); setState(previous => ({ ...previous, waiting: false })); }} onSeeked={refresh}
      onError={() => { refresh(); setState(previous => ({ ...previous, waiting: false })); setError('This browser could not play this video. Download it to open with a compatible application.'); }} />
    <div className="media-player-controls">
      <button type="button" className="secondary-button" aria-label={state.paused ? 'Play video' : 'Pause video'} disabled={!state.ready} onClick={() => void togglePlay()}>{state.paused ? <Play size={18} /> : <Pause size={18} />}</button>
      <label className="media-player-seek"><span className="sr-only">Video position</span><input type="range" min="0" max={state.duration || 1} step="0.1" value={Math.min(state.current, state.duration || 1)} disabled={!state.duration} aria-valuetext={time(state.current) + (state.duration ? ' of ' + time(state.duration) : '')} onChange={event => { player.current!.currentTime = Number(event.target.value); refresh(); }} /></label>
      <output className="media-player-time" aria-label="Playback time">{time(state.current)} / {state.duration ? time(state.duration) : '—'}</output>
      <button type="button" className="secondary-button" aria-label={state.muted ? 'Unmute video' : 'Mute video'} onClick={() => { player.current!.muted = !state.muted; }}>{state.muted || !state.volume ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
      <label className="media-player-volume"><span className="sr-only">Video volume</span><input type="range" min="0" max="1" step="0.05" value={state.muted ? 0 : state.volume} aria-valuetext={Math.round((state.muted ? 0 : state.volume) * 100) + '%'} onChange={event => { const video = player.current!; video.volume = Number(event.target.value); video.muted = false; }} /></label>
      <label className="media-player-rate"><span className="sr-only">Playback speed</span><select value={state.rate} onChange={event => { player.current!.playbackRate = Number(event.target.value); }}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => <option key={rate} value={rate}>{rate}×</option>)}</select></label>
      <button type="button" className="secondary-button" aria-label={fullscreen ? 'Exit video fullscreen' : 'Show video fullscreen'} disabled={!document.fullscreenEnabled || !frame.current?.requestFullscreen} onClick={() => void presentation('fullscreen')}>{fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}</button>
      <button type="button" className="secondary-button" aria-label={pip ? 'Exit video Picture-in-Picture' : 'Show video Picture-in-Picture'} disabled={!document.pictureInPictureEnabled || !player.current?.requestPictureInPicture || !state.ready} onClick={() => void presentation('pip')}><PictureInPicture2 size={18} /></button>
    </div>
    {state.waiting && !error && <p className="media-player-status" role="status">Buffering video…</p>}
    {error && <p className="media-player-status" role="alert">{error}</p>}
  </div>;
}
