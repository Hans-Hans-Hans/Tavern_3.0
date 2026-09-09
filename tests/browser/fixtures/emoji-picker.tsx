import React from 'react';
import { createRoot } from 'react-dom/client';
import { EmojiPicker } from '../../../app/emoji-picker';
export function mountFixture() { const w = window as any; w.choices = []; w.fixtureClient = { getUserId: () => '@self:local', getRoom: () => ({ currentState: { getStateEvents: () => ({ getContent: () => ({ emoji: [{ name: 'cheers', uri: 'mxc://local/cheers', creator: '@self:local' }] }) }) } }), getAccessToken: () => 'fixture', mxcUrlToHttp: () => '/test-emoji-image' }; createRoot(document.getElementById('root')!).render(<EmojiPicker serverId="!server:local" onSelect={value => w.choices.push(value)} onSelectCustom={emoji => w.choices.push('custom:' + emoji.uri)} />); }
