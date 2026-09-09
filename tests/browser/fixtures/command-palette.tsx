import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { CommandPalette, openCommandPalette } from '../../../app/command-palette';
const testWindow = window as any;
function Fixture() { useEffect(() => { testWindow.fixtureReady = true; }, []); return <CommandPalette onSelectRoom={id => testWindow.chosen.push('room:' + id)} onSelectServer={id => testWindow.chosen.push('server:' + id)} onSettings={tab => testWindow.chosen.push('settings:' + tab)} onSearch={() => testWindow.chosen.push('search')} />; }
export function mountFixture() { testWindow.chosen = []; createRoot(document.getElementById('root')!).render(<Fixture />); document.getElementById('opener')!.onclick = () => openCommandPalette(); }
