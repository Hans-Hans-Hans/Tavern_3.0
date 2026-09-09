import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { ConferenceIdle } from '../../../app/conference-idle';
import { clearConference, conferenceClosing, conferenceJoined, conferenceSnapshot, openConference } from '../../../lib/conference-session';
import '../../../app/globals.css';
import '../../../app/calls.css';

export function mountFixture() {
  const w = window as any;
  w.fixtureClient = {}; w.listeners = new Set(); w.leaveCount = 0; w.captureCount = 0;
  w.afk = { version: 1, channelId: '!afk:local', timeoutSeconds: 300, serverId: '!server:local', destinationName: 'Quiet room' };
  openConference('!source:local'); conferenceJoined(conferenceSnapshot().generation);
  w.authoritativeConference = conferenceSnapshot;
  w.replaceBeforeRender = () => { clearConference(conferenceSnapshot().generation); openConference('!new:local'); conferenceJoined(conferenceSnapshot().generation); };
  w.closeBeforeRender = conferenceClosing;
  navigator.mediaDevices.getUserMedia = async () => { w.captureCount++; throw new Error('Idle handling must not capture media'); };
  navigator.mediaDevices.getDisplayMedia = async () => { w.captureCount++; throw new Error('Idle handling must not capture media'); };
  function Fixture() {
    const frame = useRef<HTMLIFrameElement>(null), [generation, setGeneration] = useState(conferenceSnapshot().generation), [joined, setJoined] = useState(true);
    w.replaceCall = () => { clearConference(conferenceSnapshot().generation); openConference('!source:local'); conferenceJoined(conferenceSnapshot().generation); setGeneration(conferenceSnapshot().generation); setJoined(true); };
    const close = async () => {
      const current = conferenceSnapshot(); if (current.generation !== generation || current.roomId !== '!source:local' || current.phase !== 'joined') return false;
      w.leaveCount++; conferenceClosing(); if (w.delayLeave) await new Promise<void>(resolve => { w.finishLeave = resolve; });
      clearConference(generation); if (conferenceSnapshot().generation === generation) setJoined(false); return true;
    };
    return <><button onClick={() => { w.afk = { ...w.afk, timeoutSeconds: 600 }; for (const listener of w.listeners) listener(); }}>Change server timeout</button><button onClick={() => { w.fixtureClient = {}; for (const listener of w.listeners) listener(); }}>Change account</button>
      <iframe ref={frame} title='Synthetic conference controls' srcDoc='<button>Widget control</button>'/>
      <ConferenceIdle roomId='!source:local' generation={generation} joined={joined} frame={frame} onLeave={close}/><Toaster/>
    </>;
  }
  createRoot(document.getElementById('root')!).render(<Fixture/>);
}
